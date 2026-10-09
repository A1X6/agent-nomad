import { readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  pluginFiles,
  PROBE_MOD_VALIDATION,
  REAL_VALIDATE_REPORT,
  scriptedValidator,
} from './claude-code-plugin-fixtures.ts';
import { collected, collectedJson, useTempDir } from './fakes.ts';
import {
  createPluginValidator,
  isPluginGenerated,
  pluginFolders,
  pluginNotes,
  readValidateReport,
  reviewPlugins,
  type ExecutableLookupSystem,
  type ProgramCli,
} from '../src/index.ts';

const MOD = 'skills/my-mod/';
const mod = (folder = MOD) => pluginFiles(folder, { modules: ['./register.ts'] });

describe('plugins in the skills folder (T96): what Claude Code generates', () => {
  it.each([
    ['skills/my-mod/.claude-plugin/types', true],
    ['skills/my-mod/.claude-plugin/types/claude-code/index.d.ts', true],
    ['.claude/skills/my-mod/.claude-plugin/types/tsconfig.json', true],
    ['skills/my-mod/.claude-plugin/plugin.json', false],
    ['skills/types/SKILL.md', false],
    ['skills/my-mod/.claude-plugin/types.md', false],
    ['skills/my-mod/types/index.d.ts', false],
  ])('%s generated: %s', (path, generated) => {
    expect(isPluginGenerated(path)).toBe(generated);
  });
});

describe('plugins in the skills folder (T96): finding them', () => {
  it('a skill folder is a plugin when it has .claude-plugin/plugin.json, in either scope', () => {
    const files = [
      ...pluginFiles('skills/b/'),
      ...pluginFiles('.claude/skills/a/'),
      collected('skills/plain/SKILL.md', 'a skill'),
      // Managed by claude.ai; never collected, and never a plugin of the setup.
      collectedJson('skills/synced/acct/x/.claude-plugin/plugin.json', { name: 'x' }),
    ];
    expect(pluginFolders(files).map((plugin) => [plugin.folder, plugin.name])).toEqual([
      ['.claude/skills/a/', 'a'],
      ['skills/b/', 'b'],
    ]);
  });

  it('reads the modules, hooks and MCP servers from the default files', () => {
    const [plugin] = pluginFolders(
      pluginFiles(MOD, {
        modules: ['./register.ts', './pane.tsx'],
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
        mcpServers: { docs: { command: 'npx', args: ['docs-mcp'] } },
      }),
    );
    expect(plugin?.modules).toEqual(['./register.ts', './pane.tsx']);
    expect(plugin?.hooks.map((source) => source.label)).toEqual(['hooks/hooks.json']);
    expect(plugin?.servers.map((source) => source.label)).toEqual(['.mcp.json']);
    expect(plugin?.files).toHaveLength(5);
  });

  it('also reads the hooks and MCP files the manifest names, and inline blocks', () => {
    const files = [
      collectedJson(`${MOD}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: './extra/hooks.json',
        mcpServers: { inline: { command: 'inline-mcp' } },
      }),
      collectedJson(`${MOD}extra/hooks.json`, { modules: ['./x.ts'] }),
      collectedJson(`${MOD}other/plugin.json`, { hooks: { Stop: [] } }),
    ];
    const [plugin] = pluginFolders(files);
    expect(plugin?.modules).toEqual(['./x.ts']);
    expect(plugin?.hooks.map((source) => source.label)).toEqual(['extra/hooks.json']);
    expect(plugin?.servers.map((source) => source.label)).toEqual(['.claude-plugin/plugin.json']);

    const inline = pluginFolders([
      collectedJson(`${MOD}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
        mcpServers: './servers.json',
      }),
      collectedJson(`${MOD}servers.json`, { docs: { command: 'docs-mcp' } }),
    ]);
    expect(inline[0]?.hooks.map((source) => source.label)).toEqual(['.claude-plugin/plugin.json']);
    expect(inline[0]?.servers.map((source) => source.label)).toEqual(['servers.json']);
  });

  it('a manifest that is not JSON still marks the folder as a plugin', () => {
    const files = [collected(`${MOD}.claude-plugin/plugin.json`, '{ not json'), ...mod().slice(1)];
    expect(pluginFolders(files).map((plugin) => plugin.modules)).toEqual([['./register.ts']]);
  });

  it('push names them, and says which are mods', () => {
    expect(pluginNotes([collected('skills/plain/SKILL.md', 'x')])).toEqual([]);
    expect(pluginNotes([...pluginFiles('skills/tools/'), ...mod()])).toEqual([
      'Plugins in the skills folder, saved with it: my-mod (skills/my-mod/, a mod: runs code inside Claude Code), tools (skills/tools/). They load as <name>@skills-dir on the other PC, after pull shows what they run.',
    ]);
  });
});

describe('plugins in the skills folder (T96): the pull review', () => {
  it('shows a new mod with what its modules hook and call, as one unit (its folder)', async () => {
    const validator = scriptedValidator(PROBE_MOD_VALIDATION);
    const review = await reviewPlugins(mod(), [], validator.validate);
    expect(review).toEqual([
      {
        file: MOD,
        label: 'plugin skills/my-mod/ module ./register.ts (runs code inside Claude Code)',
        command:
          'hooks: session.start, tool.call{tool=Bash}; calls: $.store.get, $.store.set, $.ui.status',
        identity:
          'hooks: session.start, tool.call{tool=Bash}; calls: $.store.get, $.store.set, $.ui.status',
        change: 'new',
      },
    ]);
    expect(validator.asked.map((plugin) => plugin.name)).toEqual(['my-mod']);
  });

  it('an unchanged plugin is not shown and not checked; a local extra file is no change', async () => {
    const validator = scriptedValidator(PROBE_MOD_VALIDATION);
    const files = mod();
    expect(await reviewPlugins(files, files, validator.validate)).toEqual([]);
    const extra = [...files, collected(`${MOD}notes.md`, 'mine')];
    expect(await reviewPlugins(files, extra, validator.validate)).toEqual([]);
    expect(validator.asked).toEqual([]);
  });

  it('a changed plugin is shown as changed', async () => {
    const files = mod();
    const here = files.map((file) =>
      file.path.endsWith('register.ts')
        ? collected(file.path, 'export const register = 1\n')
        : file,
    );
    const review = await reviewPlugins(
      files,
      here,
      scriptedValidator(PROBE_MOD_VALIDATION).validate,
    );
    expect(review.map((entry) => entry.change)).toEqual(['changed']);
    // A plain skill folder that becomes a plugin is a change too.
    const wasSkill = [collected(`${MOD}SKILL.md`, 'x')];
    const became = await reviewPlugins(
      files,
      wasSkill,
      scriptedValidator(PROBE_MOD_VALIDATION).validate,
    );
    expect(became.map((entry) => entry.change)).toEqual(['changed']);
  });

  it('lists classic hooks and MCP servers with the T44 readers; no module, no check', async () => {
    const validator = scriptedValidator(PROBE_MOD_VALIDATION);
    const files = pluginFiles('skills/classic/', {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'bun "${CLAUDE_PLUGIN_ROOT}/on-start.ts"' }] },
        ],
        Stop: 'not a list',
      },
      mcpServers: { docs: { command: 'npx', args: ['docs-mcp'], env: { KEY: 'x' } } },
    });
    const review = await reviewPlugins(files, [], validator.validate);
    expect(review.map((entry) => [entry.file, entry.label, entry.command])).toEqual([
      [
        'skills/classic/',
        'plugin skills/classic/ hook SessionStart',
        'bun "${CLAUDE_PLUGIN_ROOT}/on-start.ts"',
      ],
      ['skills/classic/', 'plugin skills/classic/ hook Stop (unreadable)', '"not a list"'],
      ['skills/classic/', 'plugin skills/classic/ MCP server docs', 'npx docs-mcp  (env: KEY)'],
    ]);
    expect(validator.asked).toEqual([]);
  });

  it('a plugin with only skills is not shown: its skills are reviewed as skills', async () => {
    const files = pluginFiles('skills/tools/', {
      extra: { 'SKILL.md': '---\nname: tools\n---\n' },
    });
    expect(
      await reviewPlugins(files, [], scriptedValidator(PROBE_MOD_VALIDATION).validate),
    ).toEqual([]);
  });

  it('a broken mod is shown as broken, with the errors, and its modules as not read', async () => {
    const validator = scriptedValidator({
      kind: 'report',
      errors: ['modules../register.ts: syntax: register.ts does not parse: Unexpected end of file'],
      modules: [],
    });
    const review = await reviewPlugins(mod(), [], validator.validate);
    expect(review.map((entry) => [entry.label, entry.command])).toEqual([
      [
        'plugin skills/my-mod/ (broken: Claude Code will not load it)',
        'modules../register.ts: syntax: register.ts does not parse: Unexpected end of file',
      ],
      [
        'plugin skills/my-mod/ module ./register.ts (runs code inside Claude Code)',
        'not read by validate',
      ],
    ]);
  });

  it('a mod that could not be checked is still shown, with why, so it still needs a yes', async () => {
    const validator = scriptedValidator({
      kind: 'unavailable',
      reason: 'the claude command was not found',
    });
    const review = await reviewPlugins(mod('.claude/skills/my-mod/'), [], validator.validate);
    expect(review).toEqual([
      {
        file: '.claude/skills/my-mod/',
        label: 'plugin .claude/skills/my-mod/ (a mod: runs code inside Claude Code, not checked)',
        command:
          'modules ./register.ts: the claude command was not found, so what they hook and call could not be listed',
        identity:
          'modules ./register.ts: the claude command was not found, so what they hook and call could not be listed',
        change: 'new',
      },
    ]);
    const unset = await reviewPlugins(mod(), []);
    expect(unset[0]?.command).toContain('plugin checks are not set up');
  });
});

describe('plugins in the skills folder (T96): reading claude plugin validate --json', () => {
  it('reads the hooks and calls of each module from the real 2.1.295 report', () => {
    expect(readValidateReport(REAL_VALIDATE_REPORT)).toEqual(PROBE_MOD_VALIDATION);
  });

  it('collects the manifest and content errors, with their paths', () => {
    const report = JSON.stringify({
      success: false,
      manifest: { errors: [{ path: 'json', message: 'Invalid JSON syntax' }] },
      contents: [
        {
          type: 'hooks',
          errors: [{ path: 'modules../register.ts', message: 'missing: no such file' }],
          notes: ['./register.ts hooks: nothing', './register.ts calls: nothing on $'],
        },
      ],
    });
    expect(readValidateReport(report)).toEqual({
      kind: 'report',
      errors: ['json: Invalid JSON syntax', 'modules../register.ts: missing: no such file'],
      modules: [{ module: './register.ts', hooks: 'nothing', calls: 'nothing on $' }],
    });
  });

  it('is null for anything but a report', () => {
    expect(readValidateReport('')).toBeNull();
    expect(readValidateReport('Validating plugin manifest: x\n√ Validation passed')).toBeNull();
    expect(readValidateReport('[]')).toBeNull();
  });
});

describe('plugins in the skills folder (T96): running claude plugin validate', () => {
  let tempDir: string;
  useTempDir('agentnomad-validate-', (dir) => (tempDir = dir));

  /** Only what the lookup reads (SOLID-06): `claude` is installed when it is in `executables`. */
  const system = (executables: string[]): ExecutableLookupSystem => ({
    platform: 'linux',
    homedir: '/home/a',
    env: { PATH: '/usr/bin' },
    isExecutable: (path) => Promise.resolve(executables.includes(path)),
  });

  /** A `claude` that answers `stdout` and records the folder it was asked to validate. */
  function recordingCli(stdout: string, exitCode = 0, stderr = '') {
    const calls: { path: string; args: readonly string[]; cwd: string; files: string[] }[] = [];
    const cli = (path: string): ProgramCli => ({
      async run(args, cwd) {
        const folder = args.at(-1) ?? '';
        const files = (await readdir(folder, { recursive: true }))
          .map((name) => name.split(sep).join('/'))
          .sort();
        calls.push({ path, args, cwd, files });
        return { exitCode, stdout, stderr };
      },
    });
    return { calls, cli };
  }

  const [plugin] = pluginFolders(mod());
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
    expect(call?.args[3]).toBe(join(call?.cwd ?? '', 'my-mod'));
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

  it('is unavailable, with what claude said, when there is no report to read', async () => {
    const claude = recordingCli('', 1, 'claude: unknown option --json\nmore');
    const validate = createPluginValidator({
      system: system(['/usr/bin/claude']),
      cli: claude.cli,
      tempDir,
    });
    expect(await validate(plugin)).toEqual({
      kind: 'unavailable',
      reason: 'claude plugin validate gave no report (claude: unknown option --json)',
    });
    expect(await readdir(tempDir)).toEqual([]);
  });

  it('refuses to write a path that is not a safe bundle path', async () => {
    const claude = recordingCli(REAL_VALIDATE_REPORT);
    const validate = createPluginValidator({
      system: system(['/usr/bin/claude']),
      cli: claude.cli,
      tempDir,
    });
    const unsafe = { ...plugin, files: [...plugin.files, collected(`${MOD}../escape.ts`, 'x')] };
    expect(await validate(unsafe)).toEqual({
      kind: 'unavailable',
      reason: 'unsafe path ../escape.ts',
    });
    expect(claude.calls).toEqual([]);
    expect(await readdir(tempDir)).toEqual([]);
  });
});
