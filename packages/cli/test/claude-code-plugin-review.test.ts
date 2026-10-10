import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MOD_MODULE,
  MOD_NAME,
  modFiles,
  validateBrokenManifest,
  validateCli,
  validatePassCalling,
  validatePassWithWarning,
  type ValidateRun,
} from './claude-code-plugin-fixtures.ts';
import {
  collected,
  collectedJson,
  executableLookup,
  exists,
  recordingReporter,
  scriptedPrompter,
  useTempDir,
  writeTestFile,
} from './fakes.ts';
import {
  askPluginFolders,
  findPluginValidator,
  pluginFolderChange,
  reviewPluginFolder,
  type PluginFolderToReview,
} from '../src/index.ts';

/** The pull review of plugin folders (T97), with captured `claude plugin validate` reports. */

const CLAUDE = '/usr/bin/claude';

/** The mod as pull is about to write it to `skills/probe-mod`. */
const mod = (files = modFiles('')): PluginFolderToReview => ({
  id: `${MOD_NAME}@skills-dir`,
  folder: `skills/${MOD_NAME}`,
  files,
});

/** A PC where `claude` answers validate with `run`, or one without Claude Code. */
async function validatorFor(run: ValidateRun | null) {
  const fake = validateCli(run ?? validatePassWithWarning);
  const system = executableLookup({
    platform: 'linux',
    homedir: '/home/a',
    env: { PATH: '/usr/bin' },
    executables: run === null ? [] : [CLAUDE],
  });
  return { validator: await findPluginValidator(system, fake.cli), calls: fake.calls };
}

/** Asks about the mod with `run` as validate's report and the given flags and answers. */
async function gate(
  run: ValidateRun | null,
  flags: { assumeYes?: boolean; allowCommands?: boolean } = {},
  answers: boolean[] = [],
) {
  const { validator } = await validatorFor(run);
  const script = scriptedPrompter(answers);
  const { reporter, lines } = recordingReporter({ levels: false });
  const accepted = await askPluginFolders([{ folder: mod(), change: 'new' }], validator, {
    prompter: script.prompter,
    reporter,
    assumeYes: flags.assumeYes ?? false,
    allowCommands: flags.allowCommands ?? false,
  });
  return { accepted: [...accepted], asked: script.asked, lines };
}

describe('claude plugin validate on a plugin folder (T97)', () => {
  it('runs on a copy in a new temporary folder, never on a path from the bundle', async () => {
    const { validator, calls } = await validatorFor(validatePassWithWarning);
    await validator.validate(mod());
    const [call] = calls;
    expect(call?.args.slice(0, 3)).toEqual(['plugin', 'validate', '--json']);
    expect(call?.args[3]?.startsWith(join(tmpdir(), 'agentnomad-plugin-review-'))).toBe(true);
    expect(call?.files).toEqual([
      '.claude-plugin/plugin.json',
      'hooks/hooks.json',
      'hooks/register.ts',
    ]);
  });

  it("runs Claude Code with an empty config folder of its own, so this PC's setup is untouched", async () => {
    const { validator, calls } = await validatorFor(validatePassWithWarning);
    await validator.validate(mod());
    const [call] = calls;
    expect(call?.configDir).toBe(join(call?.args[3] ?? '', '..', 'config'));
  });

  it('removes the copy afterwards', async () => {
    const { validator, calls } = await validatorFor(validatePassWithWarning);
    await validator.validate(mod());
    expect(await exists(calls[0]?.args[3] ?? '')).toBe(false);
  });

  it('never copies a file whose path leaves the folder', async () => {
    const { validator, calls } = await validatorFor(validatePassWithWarning);
    await validator.validate(mod([...modFiles(''), collected('../outside.ts', 'x')]));
    expect(calls[0]?.files).toEqual([
      '.claude-plugin/plugin.json',
      'hooks/hooks.json',
      'hooks/register.ts',
    ]);
  });

  it('a file it cannot copy leaves the folder unreviewed, never stops pull', async () => {
    const { validator, calls } = await validatorFor(validatePassWithWarning);
    // A folder and a file of one name: the second cannot be written.
    const clash = [collected('hooks', 'x'), ...modFiles('')];
    expect((await validator.validate(mod(clash))).kind).toBe('unavailable');
    expect(calls).toEqual([]);
  });

  it('shows its errors with the folder pull writes, not the copy', async () => {
    const { validator } = await validatorFor(validateBrokenManifest);
    expect(await validator.validate(mod())).toEqual({
      kind: 'checked',
      passed: false,
      errors: ['json: Invalid JSON syntax: JSON Parse error: Unexpected EOF'],
      notes: [
        './register.ts hooks: session.start',
        './register.ts calls: $.store.get, $.store.set, $.ui.status',
      ],
    });
  });

  it('without Claude Code, says so', async () => {
    const { validator } = await validatorFor(null);
    expect(await validator.validate(mod())).toEqual({
      kind: 'unavailable',
      reason: 'Claude Code is not installed here',
    });
  });

  it('a Claude Code without validate gives no report', async () => {
    const validator = await findPluginValidator(
      executableLookup({
        platform: 'linux',
        homedir: '/h',
        env: { PATH: '/usr/bin' },
        executables: [CLAUDE],
      }),
      () => ({
        run: () =>
          Promise.resolve({ exitCode: 1, stdout: '', stderr: "error: unknown command 'validate'" }),
      }),
    );
    expect(await validator.validate(mod())).toEqual({
      kind: 'unavailable',
      reason:
        "`claude plugin validate` gave no report (exit code 1: error: unknown command 'validate')",
    });
  });
});

describe('the review of a plugin folder (T97)', () => {
  it('lists each module with its hooks and calls', async () => {
    const { validator } = await validatorFor(validatePassWithWarning);
    const review = await reviewPluginFolder(mod(), validator);
    expect(review.modules).toEqual([
      {
        module: './register.ts',
        hooks: ['session.start'],
        calls: ['$.store.get', '$.store.set', '$.ui.status'],
        risky: [],
      },
    ]);
  });

  it('a module that calls nothing on $ has no calls', async () => {
    const { validator } = await validatorFor(validatePassCalling(['nothing on $']));
    expect((await reviewPluginFolder(mod(), validator)).modules[0]?.calls).toEqual([]);
  });

  it('keeps a hook filter with commas as one hook', async () => {
    const run = validatePassCalling(['$.store.get']);
    const json = structuredClone(run.json) as { contents: { notes: string[] }[] };
    json.contents[0]?.notes.splice(
      0,
      1,
      './register.ts hooks: tool.call{tool=Bash,Edit}, session.start',
    );
    const { validator } = await validatorFor({ ...run, json });
    expect((await reviewPluginFolder(mod(), validator)).modules[0]?.hooks).toEqual([
      'tool.call{tool=Bash,Edit}',
      'session.start',
    ]);
  });

  it('flags running programs, file writes, model and network calls', async () => {
    const run = validatePassCalling([
      '$.store.get',
      '$.process.spawn',
      '$.fs.read',
      '$.fs.write',
      '$.model.complete',
      '$.net.fetch',
    ]);
    const { validator } = await validatorFor(run);
    const review = await reviewPluginFolder(mod(), validator);
    expect(review.modules[0]?.risky).toEqual([
      '$.process.spawn (runs programs)',
      '$.fs.write (writes files)',
      '$.model.complete (calls the model)',
      '$.net.fetch (uses the network)',
    ]);
  });

  it('lists classic command hooks, which validate does not', async () => {
    const files = [
      ...modFiles('').filter((file) => file.path !== 'hooks/hooks.json'),
      collectedJson('hooks/hooks.json', {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash notify.sh' }] }] },
      }),
    ];
    const { validator } = await validatorFor(validatePassWithWarning);
    const review = await reviewPluginFolder(mod(files), validator);
    expect(review.commandHooks).toEqual(['hook Stop: bash notify.sh']);
  });

  it('a plugin with no hooks, MCP servers or modules runs no code', async () => {
    const files = [collectedJson('.claude-plugin/plugin.json', { name: MOD_NAME })];
    const run: ValidateRun = {
      ...validatePassWithWarning,
      json: { ...validatePassWithWarning.json, contents: [] },
    };
    const { validator } = await validatorFor(run);
    expect((await reviewPluginFolder(mod(files), validator)).runsCode).toBe(false);
  });
});

describe('asking before writing a plugin folder with code (T97)', () => {
  it('shows the hooks: and calls: lines before asking', async () => {
    const t = await gate(validatePassWithWarning, {}, [true]);
    expect(t.lines[0]).toContain('      ./register.ts hooks: session.start');
    expect(t.lines[0]).toContain(
      '      ./register.ts calls: $.store.get, $.store.set, $.ui.status',
    );
    expect(t.asked).toEqual(['Write probe-mod@skills-dir? It runs code inside Claude Code.']);
  });

  it('writes it after a yes', async () => {
    const t = await gate(validatePassWithWarning, {}, [true]);
    expect(t.accepted).toEqual(['skills/probe-mod']);
  });

  it('leaves it out after a no', async () => {
    const t = await gate(validatePassWithWarning, {}, [false]);
    expect(t.accepted).toEqual([]);
  });

  it('offers the source of a module with risky calls', async () => {
    const t = await gate(validatePassCalling(['$.process.spawn']), {}, [true, false]);
    expect(t.asked[0]).toBe('Show the source of ./register.ts in probe-mod@skills-dir?');
    expect(t.lines).toContain(MOD_MODULE);
  });

  it('--yes never accepts it', async () => {
    const t = await gate(validatePassWithWarning, { assumeYes: true });
    expect(t.accepted).toEqual([]);
    expect(t.asked).toEqual([]);
    expect(t.lines).toContain(
      'Skipped skills/probe-mod: probe-mod@skills-dir runs code inside Claude Code. --yes never accepts a plugin with code; add --allow-commands to accept it.',
    );
  });

  it('--allow-commands accepts it without asking', async () => {
    const t = await gate(validatePassWithWarning, { assumeYes: true, allowCommands: true });
    expect(t.accepted).toEqual(['skills/probe-mod']);
    expect(t.asked).toEqual([]);
  });

  it('a broken plugin (validate exit 1) shows its errors and needs a yes', async () => {
    const t = await gate(validateBrokenManifest, {}, [false]);
    expect(t.lines[0]).toContain(
      '      ✘ json: Invalid JSON syntax: JSON Parse error: Unexpected EOF',
    );
    expect(t.asked).toEqual([
      'Write probe-mod@skills-dir anyway? claude plugin validate found errors, so Claude Code may not load it.',
    ]);
    expect(t.accepted).toEqual([]);
  });

  it('--allow-commands does not write a broken plugin', async () => {
    const t = await gate(validateBrokenManifest, { assumeYes: true, allowCommands: true });
    expect(t.accepted).toEqual([]);
  });

  it('without validate, the folder is unreviewed code: --yes refuses it', async () => {
    const t = await gate(null, { assumeYes: true });
    expect(t.lines[0]).toContain(
      'not checked: Claude Code is not installed here; treated as unreviewed code',
    );
    expect(t.accepted).toEqual([]);
  });

  it('without validate, --allow-commands accepts it', async () => {
    const t = await gate(null, { assumeYes: true, allowCommands: true });
    expect(t.accepted).toEqual(['skills/probe-mod']);
  });
});

describe('whether a plugin folder is new or changed here (T97)', () => {
  let dir: string;
  useTempDir('agentnomad-plugin-change-', (made) => (dir = made));

  it('new when none of its files are here', async () => {
    expect(await pluginFolderChange(dir, mod())).toBe('new');
  });

  it('changed when a file differs', async () => {
    await writeTestFile(join(dir, 'hooks', 'register.ts'), 'old');
    expect(await pluginFolderChange(dir, mod())).toBe('changed');
  });

  it('null when every file is here as it is', async () => {
    for (const file of modFiles('')) {
      await writeTestFile(
        join(dir, ...file.path.split('/')),
        new TextDecoder().decode(file.content),
      );
    }
    expect(await pluginFolderChange(dir, mod())).toBeNull();
  });
});
