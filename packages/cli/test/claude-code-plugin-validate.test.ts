import { readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PROBE_MOD_FOLDER,
  PROBE_MOD_VALIDATION,
  probeMod,
  REAL_VALIDATE_REPORT,
} from './claude-code-plugin-fixtures.ts';
import { collected, fakeExecutables, useTempDir } from './fakes.ts';
import {
  createPluginValidator,
  pluginFolders,
  type ProgramCli,
  type StartProgram,
} from '../src/index.ts';

describe('running claude plugin validate on a pulled plugin (T96)', () => {
  let tempDir: string;
  useTempDir('agentnomad-validate-', (dir) => (tempDir = dir));

  const system = fakeExecutables;

  /** A `claude` that answers `stdout` and records the folder it was asked to validate. */
  function recordingCli(stdout: string, exitCode = 0, stderr = '', failure?: string) {
    const calls: { path: string; args: readonly string[]; cwd: string; files: string[] }[] = [];
    const cli = (path: string): ProgramCli => ({
      async run(args, cwd) {
        const folder = args.at(-1) ?? '';
        const files = (await readdir(folder, { recursive: true }))
          .map((name) => name.split(sep).join('/'))
          .sort();
        calls.push({ path, args, cwd, files });
        return { exitCode, stdout, stderr, ...(failure !== undefined && { failure }) };
      },
    });
    return { calls, cli };
  }

  const [plugin] = pluginFolders(probeMod());
  if (plugin === undefined) throw new Error('no plugin');

  it('is unavailable when the claude command is not installed', async () => {
    const validate = createPluginValidator({ system: system([]), tempDir });
    expect(await validate(plugin)).toEqual({
      kind: 'unavailable',
      reason: 'the claude command was not found',
    });
  });

  it('writes the plugin to a temporary folder of its own, runs validate --json there, and removes it', async () => {
    const claude = recordingCli(REAL_VALIDATE_REPORT);
    const validate = createPluginValidator({
      system: system(['/usr/bin/claude']),
      cli: claude.cli,
      tempDir,
    });
    expect(await validate(plugin)).toEqual(PROBE_MOD_VALIDATION);
    const [call] = claude.calls;
    expect(call?.path).toBe('/usr/bin/claude');
    expect(call?.args.slice(0, 3)).toEqual(['plugin', 'validate', '--json']);
    // A fixed inner name, never the plugin's (review 15 SEC-01).
    expect(call?.args[3]).toBe(join(call?.cwd ?? '', 'plugin'));
    expect(call?.cwd.startsWith(join(tempDir, 'agentnomad-plugin-'))).toBe(true);
    expect(call?.files).toEqual([
      '.claude-plugin',
      '.claude-plugin/plugin.json',
      'hooks',
      'hooks/hooks.json',
      'hooks/register.ts',
    ]);
    // Nothing is left behind, whatever validate said.
    expect(await readdir(tempDir)).toEqual([]);
  });

  // One rule, four reasons in order of preference (review 15 UX-02; a table, review 16 BP-01).
  it.each([
    [
      'what claude said',
      '{"success":false,"error":"Plugin directory not found"}',
      1,
      '',
      undefined,
      'claude said: Plugin directory not found',
    ],
    [
      'why the run stopped',
      '',
      1,
      '',
      'it did not finish within 60 seconds',
      'it did not finish within 60 seconds',
    ],
    [
      'the first line of stderr',
      '',
      1,
      'claude: unknown option --json\nmore',
      undefined,
      'claude: unknown option --json',
    ],
    ['the exit code', '', 2, '', undefined, 'exit code 2'],
  ])(
    'is unavailable when there is no report, naming %s',
    async (_what, stdout, exitCode, stderr, failure, expected) => {
      const validate = createPluginValidator({
        system: system(['/usr/bin/claude']),
        cli: recordingCli(stdout, exitCode, stderr, failure).cli,
        tempDir,
      });
      expect(await validate(plugin)).toEqual({
        kind: 'unavailable',
        reason: `claude plugin validate gave no report (${expected})`,
      });
      expect(await readdir(tempDir)).toEqual([]);
    },
  );

  it("a plugin named .claude lands under the fixed name, not where Claude Code reads a project's settings", async () => {
    const claude = recordingCli(REAL_VALIDATE_REPORT);
    const validate = createPluginValidator({
      system: system(['/usr/bin/claude']),
      cli: claude.cli,
      tempDir,
    });
    const [dotClaude] = pluginFolders(probeMod('skills/.claude/'));
    if (dotClaude === undefined) throw new Error('no plugin');
    expect(await validate(dotClaude)).toEqual(PROBE_MOD_VALIDATION);
    expect(claude.calls[0]?.args[3]).toBe(join(claude.calls[0]?.cwd ?? '', 'plugin'));
  });

  it('without an injected cli, runs claude plugin validate --json with the 60 s limit (review 17 QA-05)', async () => {
    const started: { args: readonly string[]; timeoutMs: number | undefined }[] = [];
    const start: StartProgram = (_path, args, options) => {
      started.push({ args, timeoutMs: options.timeoutMs });
      return Promise.resolve({ exitCode: 0, stdout: REAL_VALIDATE_REPORT, stderr: '' });
    };
    const validate = createPluginValidator({ system: system(['/usr/bin/claude']), start, tempDir });
    expect(await validate(plugin)).toEqual(PROBE_MOD_VALIDATION);
    expect(started).toHaveLength(1);
    expect(started[0]?.args.slice(0, 3)).toEqual(['plugin', 'validate', '--json']);
    expect(started[0]?.timeoutMs).toBe(60_000);
  });

  it('never throws: a folder it cannot write is reported as unavailable', async () => {
    const claude = recordingCli(REAL_VALIDATE_REPORT);
    const validate = createPluginValidator({
      system: system(['/usr/bin/claude']),
      cli: claude.cli,
      tempDir: join(tempDir, 'missing', 'deeper'),
    });
    const result = await validate(plugin);
    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain('the check could not run');
    expect(claude.calls).toEqual([]);
  });

  it('refuses to write a path that is not a safe bundle path', async () => {
    const claude = recordingCli(REAL_VALIDATE_REPORT);
    const validate = createPluginValidator({
      system: system(['/usr/bin/claude']),
      cli: claude.cli,
      tempDir,
    });
    const unsafe = {
      ...plugin,
      files: [...plugin.files, collected(`${PROBE_MOD_FOLDER}../escape.ts`, 'x')],
    };
    expect(await validate(unsafe)).toEqual({
      kind: 'unavailable',
      reason: 'unsafe path ../escape.ts',
    });
    expect(claude.calls).toEqual([]);
    expect(await readdir(tempDir)).toEqual([]);
  });
});
