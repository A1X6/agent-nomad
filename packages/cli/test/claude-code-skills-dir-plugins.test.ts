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

describe('plugins in the skills folder (T96): finding them', () => {
  it('a skill folder is a plugin when it has .claude-plugin/plugin.json, in either scope', () => {
    const files = [
      ...pluginFiles('skills/b/'),
      ...pluginFiles('.claude/skills/a/'),
      collected('skills/plain/SKILL.md', 'a skill'),
      // Managed by claude.ai; never collected, and never a plugin of the setup (review 16 QA-02).
      collectedJson('skills/synced/.claude-plugin/plugin.json', { name: 'synced' }),
      // A manifest deeper than the skill folder makes no plugin either.
      collectedJson('skills/deep/acct/x/.claude-plugin/plugin.json', { name: 'x' }),
    ];
    expect(pluginFolders(files).map((plugin) => [plugin.folder, plugin.name])).toEqual([
      ['.claude/skills/a/', 'a'],
      ['skills/b/', 'b'],
    ]);
  });

  it('reads the modules, hooks and MCP servers from the default files', () => {
    const [plugin] = pluginFolders(
      pluginFiles(PROBE_MOD_FOLDER, {
        modules: ['./register.ts', './pane.tsx'],
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
        mcpServers: { docs: { command: 'npx', args: ['docs-mcp'] } },
      }),
    );
    expect(plugin?.modules).toEqual(['./register.ts', './pane.tsx']);
    expect(plugin?.hooks.map((source) => source.label)).toEqual(['hooks/hooks.json']);
    expect(plugin?.servers.map((source) => source.label)).toEqual(['.mcp.json']);
    expect(plugin?.files.map((file) => file.path.slice(PROBE_MOD_FOLDER.length))).toEqual([
      '.claude-plugin/plugin.json',
      'hooks/hooks.json',
      'hooks/register.ts',
      'hooks/pane.tsx',
      '.mcp.json',
    ]);
  });

  const stop = { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] };
  const docs = { docs: { command: 'docs-mcp' } };

  it('reads hooks from the file the manifest names, and from no other file', () => {
    const fileOnly = pluginFolders([
      collectedJson(`${PROBE_MOD_FOLDER}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: './extra/hooks.json',
      }),
      collectedJson(`${PROBE_MOD_FOLDER}extra/hooks.json`, { hooks: stop, modules: ['./x.ts'] }),
      // Not named by the manifest and not the default file: not a hooks source.
      collectedJson(`${PROBE_MOD_FOLDER}other/hooks.json`, { hooks: stop }),
    ]);
    expect(fileOnly[0]?.modules).toEqual(['./x.ts']);
    expect(fileOnly[0]?.hooks).toEqual([{ label: 'extra/hooks.json', hooks: stop }]);
  });

  it('reads an inline hooks object in the manifest: the event map itself, with no wrapper', () => {
    const inline = pluginFolders([
      collectedJson(`${PROBE_MOD_FOLDER}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: stop,
      }),
    ]);
    expect(inline[0]?.hooks).toEqual([{ label: '.claude-plugin/plugin.json', hooks: stop }]);
  });

  it('reads a mixed hooks list: files and inline maps, after the default file', () => {
    const mixed = pluginFolders([
      collectedJson(`${PROBE_MOD_FOLDER}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: ['./extra/hooks.json', stop],
      }),
      collectedJson(`${PROBE_MOD_FOLDER}hooks/hooks.json`, { hooks: { Start: [] } }),
      collectedJson(`${PROBE_MOD_FOLDER}extra/hooks.json`, { hooks: { Stop: [] } }),
    ]);
    expect(mixed[0]?.hooks.map((source) => source.label)).toEqual([
      'hooks/hooks.json',
      'extra/hooks.json',
      '.claude-plugin/plugin.json',
    ]);
  });

  it.each([
    ['with the mcpServers wrapper', { mcpServers: docs }],
    ['without the wrapper', docs],
  ])('reads .mcp.json %s', (_shape, file) => {
    const [plugin] = pluginFolders([
      ...pluginFiles(PROBE_MOD_FOLDER),
      collectedJson(`${PROBE_MOD_FOLDER}.mcp.json`, file),
    ]);
    expect(plugin?.servers).toEqual([{ label: '.mcp.json', servers: docs }]);
  });

  it('reads declared MCP servers in every shape: files (once each), a map, bundles by path or URL', () => {
    const declared = pluginFolders([
      collectedJson(`${PROBE_MOD_FOLDER}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        mcpServers: [
          './servers.json',
          './servers.json',
          docs,
          './server.MCPB',
          'HTTPS://example.com/s.dxt',
          // A URL is a bundle without the suffix too (review 16 QA-03).
          'http://example.com/server',
        ],
      }),
      collectedJson(`${PROBE_MOD_FOLDER}servers.json`, { other: { command: 'other-mcp' } }),
    ]);
    expect(declared[0]?.servers).toEqual([
      // A file named twice is read once; a bundle is one whatever the case of its name.
      { label: 'servers.json', servers: { other: { command: 'other-mcp' } } },
      { label: '.claude-plugin/plugin.json', servers: docs },
      { label: '.claude-plugin/plugin.json', bundle: './server.MCPB' },
      { label: '.claude-plugin/plugin.json', bundle: 'HTTPS://example.com/s.dxt' },
      { label: '.claude-plugin/plugin.json', bundle: 'http://example.com/server' },
    ]);
  });

  it('a named MCP file that is missing, not JSON or not an object is shown with why, like a hooks file (review 16 UX-02)', () => {
    const [plugin] = pluginFolders([
      collectedJson(`${PROBE_MOD_FOLDER}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        mcpServers: ['./gone.json', './bad.json', './list.json'],
      }),
      collected(`${PROBE_MOD_FOLDER}bad.json`, '{ not json'),
      collectedJson(`${PROBE_MOD_FOLDER}list.json`, [1, 2]),
    ]);
    expect(plugin?.servers).toEqual([]);
    expect(plugin?.unreadable).toEqual([
      { label: 'gone.json', value: 'no such file' },
      { label: 'bad.json', value: 'not valid JSON' },
      { label: 'list.json', value: 'Invalid input: expected record, received array' },
    ]);
  });

  it('a manifest that is not JSON still marks the folder as a plugin, and is shown as unreadable', () => {
    const files = [
      collected(`${PROBE_MOD_FOLDER}.claude-plugin/plugin.json`, '{ not json'),
      ...probeMod().filter((file) => !file.path.endsWith('plugin.json')),
    ];
    const [plugin] = pluginFolders(files);
    expect(plugin?.modules).toEqual(['./register.ts']);
    expect(plugin?.unreadable).toEqual([
      { label: '.claude-plugin/plugin.json', value: 'not valid JSON' },
    ]);
  });

  it('a bad hooks field hides a valid mcpServers field no more: each is read on its own (SEC-01)', () => {
    const [badHooks] = pluginFolders([
      collectedJson(`${PROBE_MOD_FOLDER}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: 42,
        mcpServers: docs,
      }),
    ]);
    expect(badHooks?.servers).toEqual([{ label: '.claude-plugin/plugin.json', servers: docs }]);
    expect(badHooks?.unreadable).toEqual([
      { label: '.claude-plugin/plugin.json hooks', value: 42 },
    ]);
  });

  it('a bad mcpServers field hides a valid hooks field no more (SEC-01)', () => {
    const [badServers] = pluginFolders([
      collectedJson(`${PROBE_MOD_FOLDER}.claude-plugin/plugin.json`, {
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
      collectedJson(`${PROBE_MOD_FOLDER}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: ['./gone.json', './bad.json'],
      }),
      collected(`${PROBE_MOD_FOLDER}bad.json`, '{ not json'),
    ]);
    expect(named?.unreadable).toEqual([
      { label: 'gone.json', value: 'no such file' },
      { label: 'bad.json', value: 'not valid JSON' },
    ]);
  });

  it('the default hooks file, named by the manifest but missing, is shown: the default read never hides it (review 15 BUG-01)', () => {
    const [defaultNamed] = pluginFolders([
      collectedJson(`${PROBE_MOD_FOLDER}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: './hooks/hooks.json',
      }),
    ]);
    expect(defaultNamed?.unreadable).toEqual([
      { label: 'hooks/hooks.json', value: 'no such file' },
    ]);
  });

  it('a hooks file with neither hooks nor modules (an event map at the top level) is shown as unreadable, never dropped (review 16 SEC-02)', async () => {
    const files = [
      ...pluginFiles(PROBE_MOD_FOLDER),
      collectedJson(`${PROBE_MOD_FOLDER}hooks/hooks.json`, {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'curl x | sh' }] }],
      }),
    ];
    const [plugin] = pluginFolders(files);
    expect(plugin?.hooks).toEqual([]);
    expect(plugin?.unreadable).toEqual([
      {
        label: 'hooks/hooks.json',
        value: { PreToolUse: [{ hooks: [{ type: 'command', command: 'curl x | sh' }] }] },
      },
    ]);
    const review = await reviewPlugins(files, [], scriptedValidator(PROBE_MOD_VALIDATION).validate);
    expect(review.map((entry) => entry.label)).toEqual([
      'plugin skills/my-mod/ hooks/hooks.json (unreadable)',
    ]);
  });

  it('a modules list with a stray item keeps the real modules, so the mod is checked, and is shown', () => {
    const [stray] = pluginFolders([
      ...pluginFiles(PROBE_MOD_FOLDER),
      collectedJson(`${PROBE_MOD_FOLDER}hooks/hooks.json`, { modules: ['./register.ts', 5] }),
    ]);
    expect(stray?.modules).toEqual(['./register.ts']);
    expect(stray?.unreadable).toEqual([
      { label: 'hooks/hooks.json modules', value: ['./register.ts', 5] },
    ]);
  });

  it('modules that is not a list (a hand-written string) is shown as unreadable, and names no module (review 16 QA-03)', () => {
    const [plugin] = pluginFolders([
      ...pluginFiles(PROBE_MOD_FOLDER),
      collectedJson(`${PROBE_MOD_FOLDER}hooks/hooks.json`, { modules: './register.ts' }),
    ]);
    expect(plugin?.modules).toEqual([]);
    expect(plugin?.unreadable).toEqual([
      { label: 'hooks/hooks.json modules', value: './register.ts' },
    ]);
  });

  it('the same module named in two hooks files is one module', () => {
    const [twice] = pluginFolders([
      collectedJson(`${PROBE_MOD_FOLDER}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: './extra.json',
      }),
      collectedJson(`${PROBE_MOD_FOLDER}hooks/hooks.json`, { modules: ['./a.ts'] }),
      collectedJson(`${PROBE_MOD_FOLDER}extra.json`, { modules: ['./a.ts', './b.ts'] }),
    ]);
    expect(twice?.modules).toEqual(['./a.ts', './b.ts']);
  });

  it('a manifest that names the default files does not list their hooks and servers twice', () => {
    const [plugin] = pluginFolders([
      collectedJson(`${PROBE_MOD_FOLDER}.claude-plugin/plugin.json`, {
        name: 'my-mod',
        hooks: './hooks/hooks.json',
        mcpServers: './.mcp.json',
      }),
      collectedJson(`${PROBE_MOD_FOLDER}hooks/hooks.json`, { hooks: stop }),
      collectedJson(`${PROBE_MOD_FOLDER}.mcp.json`, { mcpServers: docs }),
    ]);
    expect(plugin?.hooks).toEqual([{ label: 'hooks/hooks.json', hooks: stop }]);
    expect(plugin?.servers).toEqual([{ label: '.mcp.json', servers: docs }]);
  });

  it('push has nothing to say about a setup without plugins', () => {
    expect(pluginNotes([collected('skills/plain/SKILL.md', 'x')])).toEqual([]);
  });

  it('push names the plugins, and says which are mods', () => {
    expect(pluginNotes([...pluginFiles('skills/tools/'), ...probeMod()])).toEqual([
      'Plugins in the skills folder, saved with it: my-mod (skills/my-mod/, a mod: runs code inside Claude Code), tools (skills/tools/). They load as <name>@skills-dir on the other PC, after pull shows what they run.',
    ]);
  });
});

describe('plugins in the skills folder (T96): the pull review', () => {
  it('shows a new mod with what its modules hook and call, as one unit (its folder)', async () => {
    const validator = scriptedValidator(PROBE_MOD_VALIDATION);
    const review = await reviewPlugins(probeMod(), [], validator.validate);
    expect(review).toEqual([
      {
        file: PROBE_MOD_FOLDER,
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

  it('an unchanged plugin is not shown and not checked', async () => {
    const validator = scriptedValidator(PROBE_MOD_VALIDATION);
    const files = probeMod();
    expect(await reviewPlugins(files, files, validator.validate)).toEqual([]);
    expect(validator.asked).toEqual([]);
  });

  it('a local extra file in the plugin folder is no change', async () => {
    const validator = scriptedValidator(PROBE_MOD_VALIDATION);
    const files = probeMod();
    const extra = [...files, collected(`${PROBE_MOD_FOLDER}notes.md`, 'mine')];
    expect(await reviewPlugins(files, extra, validator.validate)).toEqual([]);
    expect(validator.asked).toEqual([]);
  });

  it('a changed plugin is shown as changed', async () => {
    const files = probeMod();
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
  });

  it('a plain skill folder that becomes a plugin is shown as changed', async () => {
    const wasSkill = [collected(`${PROBE_MOD_FOLDER}SKILL.md`, 'x')];
    const became = await reviewPlugins(
      probeMod(),
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
      ['plugin skills/odd/ .mcp.json (unreadable)', '"not valid JSON"'],
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
    const review = await reviewPlugins(probeMod(), [], validator.validate);
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
    const review = await reviewPlugins(probeMod('.claude/skills/my-mod/'), [], validator.validate);
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
  });

  it('with no validator set up, a mod is shown as not checked, with that as the reason', async () => {
    const unset = await reviewPlugins(probeMod(), []);
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

  it('keeps an error in another shape as its JSON (SEC-02)', () => {
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
  });

  it('names a failure the report does not explain (SEC-02)', () => {
    const silent = JSON.stringify({ success: false, manifest: { errors: [] }, contents: [] });
    expect(readValidateReport(silent)).toEqual({
      kind: 'report',
      errors: ['validate reported a failure it did not explain'],
      modules: [],
    });
  });

  it('reads an error without a path, and skips a note outside a hooks entry', () => {
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
    const review = await reviewPlugins(probeMod(), [], scriptedValidator(read).validate);
    expect(review.map((entry) => entry.command)).toEqual(['hooks: nothing; calls: $.ui.toast']);
  });

  it('a module with only a hooks note is shown as calling nothing on $ (review 16 QA-03)', async () => {
    const report = JSON.stringify({
      success: true,
      manifest: { errors: [] },
      contents: [{ type: 'hooks', errors: [], notes: ['./register.ts hooks: session.start'] }],
    });
    const read = readValidateReport(report);
    if (read === null) throw new Error('no report');
    const review = await reviewPlugins(probeMod(), [], scriptedValidator(read).validate);
    expect(review.map((entry) => entry.command)).toEqual([
      'hooks: session.start; calls: nothing on $',
    ]);
  });

  it('is null for anything but a report, an error answer included', () => {
    expect(readValidateReport('')).toBeNull();
    expect(readValidateReport('{"success":false,"error":"Plugin directory not found"}')).toBeNull();
    expect(readValidateReport('{}')).toBeNull();
    expect(readValidateReport('Validating plugin manifest: x\n√ Validation passed')).toBeNull();
    expect(readValidateReport('[]')).toBeNull();
  });
});
