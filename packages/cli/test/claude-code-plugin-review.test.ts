import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MOD_CALLS,
  MOD_CALLS_VERSION,
  MOD_MODULE,
  MOD_NAME,
  modFiles,
  validateBrokenManifest,
  validatePassCalling,
  validatePassNoHooks,
  validatePassWithWarning,
  validatorFor,
  writeModFolder,
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
  CLAUDE_CODE_PATHS,
  findPluginValidator,
  pluginFolderChange,
  reviewPluginFolder,
  riskOfCall,
  withPartsHere,
  type CollectedFile,
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

/**
 * Asks about the mod (or `folder`) with `run` as validate's report and the given flags and
 * answers.
 */
async function gate(
  run: ValidateRun | null,
  flags: { assumeYes?: boolean; allowCommands?: boolean } = {},
  answers: boolean[] = [],
  folder = mod(),
) {
  const { validator } = await validatorFor(run);
  const script = scriptedPrompter(answers);
  const { reporter, lines } = recordingReporter({ levels: false });
  const accepted = await askPluginFolders([{ folder, change: 'new' }], validator, {
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
        writes: [],
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

  // SEC-04 (review 15): the calls that run tools, commands and MCP servers are flagged too.
  it('flags calls that run tools, commands, subagents or MCP servers, change settings or send prompts', async () => {
    const run = validatePassCalling([
      '$.tool.call',
      '$.command.run',
      '$.agent.spawn',
      '$.mcp.connect',
      '$.mcp.call',
      '$.config.set',
      '$.env.set',
      '$.session.send',
      '$.prompt.submit',
    ]);
    const { validator } = await validatorFor(run);
    expect((await reviewPluginFolder(mod(), validator)).modules[0]?.risky).toEqual([
      '$.tool.call (runs tools, Bash included)',
      '$.command.run (runs commands)',
      '$.agent.spawn (runs subagents)',
      '$.mcp.connect (starts or calls MCP servers)',
      '$.mcp.call (starts or calls MCP servers)',
      '$.config.set (changes settings)',
      '$.env.set (sets environment variables)',
      '$.session.send (sends prompts)',
      '$.prompt.submit (sends prompts)',
    ]);
  });

  it('flags a call made through a helper, as validate names it', async () => {
    const run = validatePassCalling(['$.store.get', '$.tool.call (via run, again)']);
    const { validator } = await validatorFor(run);
    const review = await reviewPluginFolder(mod(), validator);
    expect(review.modules[0]?.calls).toEqual(['$.store.get', '$.tool.call (via run, again)']);
    expect(review.modules[0]?.risky).toEqual([
      '$.tool.call (via run, again) (runs tools, Bash included)',
    ]);
  });

  it('pins the mod calls of the Claude Code the paths data was reviewed against', () => {
    expect(MOD_CALLS_VERSION).toBe(CLAUDE_CODE_PATHS.reviewedVersion);
  });

  it("flags exactly these of the program's mod calls", () => {
    const flagged = MOD_CALLS.flatMap((name) => {
      const does = riskOfCall(`$.${name}`);
      return does === null ? [] : [`${name}: ${does}`];
    });
    expect(flagged).toEqual([
      'tool.call: runs tools, Bash included',
      'agent.spawn: runs subagents',
      'prompt.submit: sends prompts',
      'command.run: runs commands',
      'config.set: changes settings',
      'session.send: sends prompts',
      'model.complete: calls the model',
      'model.classify: calls the model',
      'model.fork: calls the model',
      'mcp.call: starts or calls MCP servers',
      'mcp.connect: starts or calls MCP servers',
      'fs.write: writes files',
      'http.fetch: uses the network',
      'process.run: runs programs',
      'process.spawn: runs programs',
      'env.set: sets environment variables',
    ]);
  });

  it('shows the environment variables and state a module writes', async () => {
    const run = validatePassCalling(['$.env.set']);
    const json = structuredClone(run.json) as { contents: { notes: string[] }[] };
    json.contents[0]?.notes.push(
      './register.ts env writes: FOO, BAR',
      './register.ts env reads: nothing',
      './register.ts state writes: seen',
    );
    const t = await gate({ ...run, json }, {}, [false, false]);
    expect(t.lines[0]).toContain('      ./register.ts env writes: FOO, BAR');
    expect(t.lines[0]).toContain('      ./register.ts state writes: seen');
    expect(t.lines[0]).not.toContain('env reads');
  });
});

/** A plugin without hooks or modules, with `files` and its manifest `{ name, ...manifest }`. */
const pluginWith = (files: CollectedFile[], manifest: object = {}): PluginFolderToReview =>
  mod([collectedJson('.claude-plugin/plugin.json', { name: MOD_NAME, ...manifest }), ...files]);

const MCP_SERVER = { command: 'node', args: ['srv.js'] };
const LSP_SERVER = { command: 'gopls', args: ['serve'], extensionToLanguage: { '.go': 'go' } };
const MONITOR = { name: 'watch', command: 'bash watch.sh', description: 'Watches the build' };
const STOP_HOOK = { Stop: [{ hooks: [{ type: 'command', command: 'bash stop.sh' }] }] };

// SEC-02 (review 15): Claude Code starts these by itself, so the folder needs a yes.
describe('plugin parts Claude Code starts programs from (SEC-02)', () => {
  it.each([
    ['monitors/monitors.json', pluginWith([collectedJson('monitors/monitors.json', [MONITOR])])],
    ['.lsp.json', pluginWith([collectedJson('.lsp.json', { go: LSP_SERVER })])],
    ['.mcp.json', pluginWith([collectedJson('.mcp.json', { mcpServers: { db: MCP_SERVER } })])],
    ['hooks in plugin.json', pluginWith([], { hooks: STOP_HOOK })],
    ['mcpServers in plugin.json', pluginWith([], { mcpServers: { inline: MCP_SERVER } })],
    ['lspServers in plugin.json', pluginWith([], { lspServers: { go: LSP_SERVER } })],
    ['monitors in plugin.json', pluginWith([], { monitors: [MONITOR] })],
  ])('--yes never accepts a plugin with %s', async (_part, folder) => {
    const t = await gate(validatePassNoHooks, { assumeYes: true }, [], folder);
    expect(t.accepted).toEqual([]);
  });

  it('lists the MCP and LSP servers and monitors it starts', async () => {
    const folder = pluginWith(
      [
        collectedJson('.mcp.json', { mcpServers: { db: MCP_SERVER } }),
        collectedJson('.lsp.json', { go: LSP_SERVER }),
        collectedJson('monitors/monitors.json', [MONITOR]),
      ],
      { mcpServers: { inline: MCP_SERVER } },
    );
    const { validator } = await validatorFor(validatePassNoHooks);
    expect((await reviewPluginFolder(folder, validator)).starts).toEqual([
      'MCP server inline: node srv.js',
      'MCP server db: node srv.js',
      'LSP server go: gopls serve',
      'monitor watch: bash watch.sh',
    ]);
  });

  it('reads the files plugin.json names instead of the default ones', async () => {
    const folder = pluginWith(
      [
        collectedJson('config/servers.json', { mcpServers: { db: MCP_SERVER } }),
        collectedJson('config/lsp.json', { go: LSP_SERVER }),
        collectedJson('config/watch.json', [MONITOR]),
      ],
      {
        mcpServers: './config/servers.json',
        lspServers: ['./config/lsp.json'],
        monitors: './config/watch.json',
      },
    );
    const { validator } = await validatorFor(validatePassNoHooks);
    expect((await reviewPluginFolder(folder, validator)).starts).toEqual([
      'MCP server db: node srv.js',
      'LSP server go: gopls serve',
      'monitor watch: bash watch.sh',
    ]);
  });

  it('lists command hooks written in plugin.json', async () => {
    const { validator } = await validatorFor(validatePassNoHooks);
    const review = await reviewPluginFolder(pluginWith([], { hooks: STOP_HOOK }), validator);
    expect(review.commandHooks).toEqual(['hook Stop: bash stop.sh']);
  });

  it('shows what it starts before asking', async () => {
    const folder = pluginWith([collectedJson('monitors/monitors.json', [MONITOR])]);
    const t = await gate(validatePassNoHooks, {}, [false], folder);
    expect(t.lines[0]).toContain('      monitor watch: bash watch.sh');
    expect(t.asked).toEqual(['Write probe-mod@skills-dir? It runs code inside Claude Code.']);
  });
});

// SEC-01 (review 16): Windows and macOS open `Hooks/hooks.json` as `hooks/hooks.json`.
describe('plugin file names in any case (SEC-01 of review 16)', () => {
  const HOOKS_FILE = { hooks: STOP_HOOK };

  it.each([
    ['Hooks/hooks.json', pluginWith([collectedJson('Hooks/hooks.json', HOOKS_FILE)])],
    ['hooks/Hooks.json', pluginWith([collectedJson('hooks/Hooks.json', HOOKS_FILE)])],
    ['.MCP.json', pluginWith([collectedJson('.MCP.json', { mcpServers: { db: MCP_SERVER } })])],
    ['Monitors/monitors.json', pluginWith([collectedJson('Monitors/monitors.json', [MONITOR])])],
    [
      '.Claude-Plugin/plugin.json with hooks',
      mod([collectedJson('.Claude-Plugin/plugin.json', { name: MOD_NAME, hooks: STOP_HOOK })]),
    ],
  ])('--yes skips a plugin with %s', async (_part, folder) => {
    const t = await gate(validatePassNoHooks, { assumeYes: true }, [], folder);
    expect(t.accepted).toEqual([]);
    expect(t.lines).toContain(
      'Skipped skills/probe-mod: probe-mod@skills-dir runs code inside Claude Code. --yes never accepts a plugin with code; add --allow-commands to accept it.',
    );
  });

  it('shows the command hooks of Hooks/hooks.json', async () => {
    const { validator } = await validatorFor(validatePassNoHooks);
    const folder = pluginWith([collectedJson('Hooks/hooks.json', HOOKS_FILE)]);
    expect((await reviewPluginFolder(folder, validator)).commandHooks).toEqual([
      'hook Stop: bash stop.sh',
    ]);
  });

  it('shows the servers of .MCP.json', async () => {
    const { validator } = await validatorFor(validatePassNoHooks);
    const folder = pluginWith([collectedJson('.MCP.json', { mcpServers: { db: MCP_SERVER } })]);
    expect((await reviewPluginFolder(folder, validator)).starts).toEqual([
      'MCP server db: node srv.js',
    ]);
  });

  it('reads both manifests when two differ only in case', async () => {
    const { validator } = await validatorFor(validatePassNoHooks);
    const folder = pluginWith([
      collectedJson('.Claude-Plugin/plugin.json', { name: MOD_NAME, hooks: STOP_HOOK }),
    ]);
    const review = await reviewPluginFolder(folder, validator);
    expect(review.commandHooks).toEqual(['hook Stop: bash stop.sh']);
    expect(review.runsCode).toBe(true);
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
    await writeModFolder(dir);
    expect(await pluginFolderChange(dir, mod())).toBeNull();
  });
});

describe('the parts of a plugin folder already here (SEC-02 of review 16)', () => {
  let dir: string;
  useTempDir('agentnomad-plugin-here-', (made) => (dir = made));
  const hooksOnly = (): PluginFolderToReview =>
    mod([collectedJson('hooks/hooks.json', { hooks: STOP_HOOK })]);

  it('adds the manifest here to a folder without one', async () => {
    await writeTestFile(join(dir, '.claude-plugin', 'plugin.json'), '{"name":"probe-mod"}');
    const folder = await withPartsHere(dir, hooksOnly());
    expect(folder?.files.map((file) => file.path)).toEqual([
      'hooks/hooks.json',
      '.claude-plugin/plugin.json',
    ]);
  });

  it('adds the hooks file and monitors here to a lone manifest', async () => {
    await writeTestFile(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: STOP_HOOK }));
    await writeTestFile(join(dir, 'monitors', 'monitors.json'), JSON.stringify([MONITOR]));
    const folder = await withPartsHere(dir, pluginWith([]));
    expect(folder?.files.map((file) => file.path)).toEqual([
      '.claude-plugin/plugin.json',
      'hooks/hooks.json',
      'monitors/monitors.json',
    ]);
  });

  it('never adds a part the folder has in another case', async () => {
    await writeTestFile(join(dir, 'hooks', 'hooks.json'), 'here');
    const folder = await withPartsHere(dir, pluginWith([collected('Hooks/hooks.json', 'new')]));
    expect(folder?.files.map((file) => file.path)).toEqual([
      '.claude-plugin/plugin.json',
      'Hooks/hooks.json',
    ]);
  });

  it('null when neither the folder nor this PC has a manifest: not a plugin', async () => {
    expect(await withPartsHere(dir, hooksOnly())).toBeNull();
  });
});
