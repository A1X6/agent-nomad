import { describe, expect, it } from 'vitest';

import {
  pluginFiles,
  PROBE_MOD_FOLDER,
  PROBE_MOD_VALIDATION,
  probeMod,
  REAL_VALIDATE_REPORT,
  scriptedValidator,
} from './claude-code-plugin-fixtures.ts';
import { collected, collectedJson } from './fakes.ts';
import { pluginFolders, pluginNotes, readValidateReport, reviewPlugins } from '../src/index.ts';

const MOD = PROBE_MOD_FOLDER;
const mod = probeMod;

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

  it('reads hooks in every shape the manifest reference gives: a file, an inline map, a mixed list', () => {
    const stop = { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] };
    const fileOnly = pluginFolders([
      collectedJson(`${MOD}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: './extra/hooks.json',
      }),
      collectedJson(`${MOD}extra/hooks.json`, { hooks: stop, modules: ['./x.ts'] }),
      // Not named by the manifest and not the default file: not a hooks source.
      collectedJson(`${MOD}other/hooks.json`, { hooks: stop }),
    ]);
    expect(fileOnly[0]?.modules).toEqual(['./x.ts']);
    expect(fileOnly[0]?.hooks).toEqual([{ label: 'extra/hooks.json', hooks: stop }]);

    // An inline object is the event map itself, with no `hooks` wrapper.
    const inline = pluginFolders([
      collectedJson(`${MOD}.claude-plugin/plugin.json`, { name: 'my-mod', hooks: stop }),
    ]);
    expect(inline[0]?.hooks).toEqual([{ label: '.claude-plugin/plugin.json', hooks: stop }]);

    const mixed = pluginFolders([
      collectedJson(`${MOD}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: ['./extra/hooks.json', stop],
      }),
      collectedJson(`${MOD}hooks/hooks.json`, { hooks: { Start: [] } }),
      collectedJson(`${MOD}extra/hooks.json`, { hooks: { Stop: [] } }),
    ]);
    expect(mixed[0]?.hooks.map((source) => source.label)).toEqual([
      'hooks/hooks.json',
      'extra/hooks.json',
      '.claude-plugin/plugin.json',
    ]);
  });

  it('reads MCP servers in every shape: .mcp.json with or without the wrapper, a file, a map, a bundle', () => {
    const docs = { docs: { command: 'docs-mcp' } };
    const wrapped = pluginFolders([
      ...pluginFiles(MOD),
      collectedJson(`${MOD}.mcp.json`, { mcpServers: docs }),
    ]);
    expect(wrapped[0]?.servers).toEqual([{ label: '.mcp.json', servers: docs }]);
    const unwrapped = pluginFolders([...pluginFiles(MOD), collectedJson(`${MOD}.mcp.json`, docs)]);
    expect(unwrapped[0]?.servers).toEqual([{ label: '.mcp.json', servers: docs }]);

    const declared = pluginFolders([
      collectedJson(`${MOD}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        mcpServers: [
          './servers.json',
          './servers.json',
          docs,
          './server.MCPB',
          'HTTPS://example.com/s.dxt',
          './gone.json',
          './bad.json',
        ],
      }),
      collectedJson(`${MOD}servers.json`, { other: { command: 'other-mcp' } }),
      collected(`${MOD}bad.json`, '{ not json'),
    ]);
    expect(declared[0]?.servers).toEqual([
      // A file named twice is read once; a bundle is one whatever the case of its name.
      { label: 'servers.json', servers: { other: { command: 'other-mcp' } } },
      { label: '.claude-plugin/plugin.json', servers: docs },
      { label: '.claude-plugin/plugin.json', bundle: './server.MCPB' },
      { label: '.claude-plugin/plugin.json', bundle: 'HTTPS://example.com/s.dxt' },
      // Named but missing or not JSON: shown as named, never dropped.
      { label: 'gone.json', servers: './gone.json' },
      { label: 'bad.json', servers: './bad.json' },
    ]);
  });

  it('a manifest that is not JSON still marks the folder as a plugin, and is shown as unreadable', () => {
    const files = [
      collected(`${MOD}.claude-plugin/plugin.json`, '{ not json'),
      ...mod().filter((file) => !file.path.endsWith('plugin.json')),
    ];
    const [plugin] = pluginFolders(files);
    expect(plugin?.modules).toEqual(['./register.ts']);
    expect(plugin?.unreadable).toEqual([
      { label: '.claude-plugin/plugin.json', value: 'not JSON' },
    ]);
  });

  it('one bad manifest field hides no other: each is read on its own (SEC-01)', () => {
    const docs = { docs: { command: 'docs-mcp' } };
    const stop = { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] };
    const [badHooks] = pluginFolders([
      collectedJson(`${MOD}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: 42,
        mcpServers: docs,
      }),
    ]);
    expect(badHooks?.servers).toEqual([{ label: '.claude-plugin/plugin.json', servers: docs }]);
    expect(badHooks?.unreadable).toEqual([
      { label: '.claude-plugin/plugin.json hooks', value: 42 },
    ]);

    const [badServers] = pluginFolders([
      collectedJson(`${MOD}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: stop,
        mcpServers: 42,
      }),
    ]);
    expect(badServers?.hooks).toEqual([{ label: '.claude-plugin/plugin.json', hooks: stop }]);
    expect(badServers?.servers).toEqual([]);
    expect(badServers?.unreadable).toEqual([
      { label: '.claude-plugin/plugin.json mcpServers', value: 42 },
    ]);
  });

  it('a named hooks file that is missing or not JSON is shown, never dropped (SEC-01)', () => {
    const [named] = pluginFolders([
      collectedJson(`${MOD}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: ['./gone.json', './bad.json'],
      }),
      collected(`${MOD}bad.json`, '{ not json'),
    ]);
    expect(named?.unreadable).toEqual([
      { label: 'gone.json', value: 'no such file' },
      { label: 'bad.json', value: 'not JSON' },
    ]);
    // The default file, named by the manifest but missing: the default read never hides it
    // (review 15 BUG-01).
    const [defaultNamed] = pluginFolders([
      collectedJson(`${MOD}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: './hooks/hooks.json',
      }),
    ]);
    expect(defaultNamed?.unreadable).toEqual([
      { label: 'hooks/hooks.json', value: 'no such file' },
    ]);
  });

  it('a modules list with a stray item keeps the real modules, so the mod is checked, and is shown', () => {
    const [stray] = pluginFolders([
      ...pluginFiles(MOD),
      collectedJson(`${MOD}hooks/hooks.json`, { modules: ['./register.ts', 5] }),
    ]);
    expect(stray?.modules).toEqual(['./register.ts']);
    expect(stray?.unreadable).toEqual([
      { label: 'hooks/hooks.json modules', value: ['./register.ts', 5] },
    ]);
    // The same module named in two hooks files is one module.
    const [twice] = pluginFolders([
      collectedJson(`${MOD}.claude-plugin/plugin.json`, { name: 'my-mod', hooks: './extra.json' }),
      collectedJson(`${MOD}hooks/hooks.json`, { modules: ['./a.ts'] }),
      collectedJson(`${MOD}extra.json`, { modules: ['./a.ts', './b.ts'] }),
    ]);
    expect(twice?.modules).toEqual(['./a.ts', './b.ts']);
  });

  it('a manifest that names the default files does not list their hooks and servers twice', () => {
    const stop = { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] };
    const docs = { docs: { command: 'docs-mcp' } };
    const [plugin] = pluginFolders([
      collectedJson(`${MOD}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: './hooks/hooks.json',
        mcpServers: './.mcp.json',
      }),
      collectedJson(`${MOD}hooks/hooks.json`, { hooks: stop }),
      collectedJson(`${MOD}.mcp.json`, { mcpServers: docs }),
    ]);
    expect(plugin?.hooks).toEqual([{ label: 'hooks/hooks.json', hooks: stop }]);
    expect(plugin?.servers).toEqual([{ label: '.mcp.json', servers: docs }]);
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

  it('lists inline manifest hooks and MCP bundles, which download or extract code', async () => {
    const files = [
      collectedJson('skills/pack/.claude-plugin/plugin.json', {
        name: 'pack',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
        mcpServers: 'https://example.com/server.mcpb',
      }),
    ];
    const review = await reviewPlugins(files, [], scriptedValidator(PROBE_MOD_VALIDATION).validate);
    expect(review.map((entry) => [entry.label, entry.command])).toEqual([
      ['plugin skills/pack/ hook Stop', 'echo bye'],
      [
        'plugin skills/pack/ MCP bundle (.claude-plugin/plugin.json, downloaded or extracted)',
        'https://example.com/server.mcpb',
      ],
    ]);
  });

  it('shows the unreadable parts of a plugin, so a broken declaration still needs a yes', async () => {
    const files = [
      collectedJson('skills/odd/.claude-plugin/plugin.json', { name: 'odd', hooks: 42 }),
      collected('skills/odd/.mcp.json', '{ not json'),
    ];
    const review = await reviewPlugins(files, [], scriptedValidator(PROBE_MOD_VALIDATION).validate);
    expect(review.map((entry) => [entry.label, entry.command])).toEqual([
      ['plugin skills/odd/ .claude-plugin/plugin.json hooks (unreadable)', '42'],
      ['plugin skills/odd/ .mcp.json (unreadable)', '"not JSON"'],
    ]);
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

  it('keeps an error in another shape as its JSON, and names an unexplained failure (SEC-02)', () => {
    const odd = JSON.stringify({
      success: false,
      manifest: { errors: [{ code: 'x' }] },
      contents: [{ type: 'hooks', errors: [], notes: [] }],
    });
    expect(readValidateReport(odd)).toEqual({
      kind: 'report',
      errors: ['{"code":"x"}'],
      modules: [],
    });
    const silent = JSON.stringify({ success: false, manifest: { errors: [] }, contents: [] });
    expect(readValidateReport(silent)).toEqual({
      kind: 'report',
      errors: ['validate reported a failure it did not explain'],
      modules: [],
    });
    // An error without a path, and a note that is not in a hooks entry.
    const mixed = JSON.stringify({
      manifest: { errors: [{ path: null, message: 'bad' }] },
      contents: [{ type: 'skills', errors: [], notes: ['./x.ts hooks: a'] }],
    });
    expect(readValidateReport(mixed)).toEqual({ kind: 'report', errors: ['bad'], modules: [] });
  });

  it('a module with only a calls note is shown as hooking nothing', async () => {
    const report = JSON.stringify({
      success: true,
      manifest: { errors: [] },
      contents: [{ type: 'hooks', errors: [], notes: ['./register.ts calls: $.ui.toast'] }],
    });
    const read = readValidateReport(report);
    expect(read).toEqual({
      kind: 'report',
      errors: [],
      modules: [{ module: './register.ts', hooks: '', calls: '$.ui.toast' }],
    });
    if (read === null) throw new Error('no report');
    const review = await reviewPlugins(mod(), [], scriptedValidator(read).validate);
    expect(review.map((entry) => entry.command)).toEqual(['hooks: nothing; calls: $.ui.toast']);
  });

  it('is null for anything but a report, an error answer included', () => {
    expect(readValidateReport('')).toBeNull();
    expect(readValidateReport('{"success":false,"error":"Plugin directory not found"}')).toBeNull();
    expect(readValidateReport('{}')).toBeNull();
    expect(readValidateReport('Validating plugin manifest: x\n√ Validation passed')).toBeNull();
    expect(readValidateReport('[]')).toBeNull();
  });
});
