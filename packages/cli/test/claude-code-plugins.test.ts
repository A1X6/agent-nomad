import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createClaudeCodeGlobalCollector,
  globalDestination,
  marketplaceAddArgument,
  PluginManifestSchema,
  projectDestination,
  readCurrentPlugins,
  readPluginManifest,
} from '../src/index.ts';

import {
  base,
  pluginProject,
  putJson,
  realisticPlugins,
  root,
  usePluginFolders,
} from './claude-code-plugin-fixtures.ts';

usePluginFolders('agentnomad-plugins-');

describe('plugin list on push', () => {
  it('saves user plugins with addable marketplaces, and says what was left out', async () => {
    await realisticPlugins(root);
    const manifest = await readPluginManifest({
      baseDir: base,
      platform: process.platform,
      scope: { kind: 'global' },
    });
    expect(manifest).toEqual({
      marketplaces: [
        { name: 'brag', add: 'latent-spaces/brag' },
        { name: 'claude-code-warp', add: 'warpdotdev/claude-code-warp#v2' },
        { name: 'company', add: 'https://gitlab.example.com/team/plugins.git' },
      ],
      plugins: [
        { id: 'brag@brag', scope: 'user', commandSource: false },
        { id: 'builder@company', scope: 'user', commandSource: true },
        { id: 'warp@claude-code-warp', scope: 'user', commandSource: false },
      ],
      skipped: [
        { what: 'mine@local-tools', reason: 'its marketplace is a local folder or unknown source' },
        {
          what: 'notes@claudeai-organization-library',
          reason: 'comes with your claude.ai account',
        },
        { what: 'gone@deleted-market', reason: 'its marketplace is missing' },
      ],
    });
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('a project push saves only that project’s plugins', async () => {
    await realisticPlugins(root);
    const manifest = await readPluginManifest({
      baseDir: base,
      platform: process.platform,
      scope: { kind: 'project', projectDir: pluginProject() },
    });
    expect(manifest?.plugins).toEqual([
      { id: 'team-lint@company', scope: 'project', commandSource: false },
    ]);
    expect(manifest?.marketplaces.map((entry) => entry.name)).toEqual(['company']);
  });

  it('nothing to save without installed plugins', async () => {
    expect(
      await readPluginManifest({
        baseDir: base,
        platform: process.platform,
        scope: { kind: 'global' },
      }),
    ).toBeNull();
  });

  it('the global collector adds .agentnomad/plugins.json, which restore never writes', async () => {
    await realisticPlugins(root);
    const files = await createClaudeCodeGlobalCollector({
      baseDir: base,
      homedir: root,
      platform: process.platform,
      customConfigDir: false,
    }).collect({ kind: 'global' }, { includeMemory: false });
    expect(files.map((file) => file.path)).toEqual(['.agentnomad/plugins.json']);
    expect(globalDestination('.agentnomad/plugins.json', new Set())).toEqual({ kind: 'metadata' });
    expect(projectDestination('.agentnomad/plugins.json')).toEqual({ kind: 'metadata' });
  });

  it.each([
    [{ source: 'github', repo: 'a/b' }, 'a/b'],
    [{ source: 'github', repo: 'a/b', ref: 'v1.2.0' }, 'a/b#v1.2.0'],
    [{ source: 'git', url: 'https://host/x.git', ref: 'main' }, 'https://host/x.git#main'],
    [{ source: 'git', url: 'git@host:x.git' }, 'git@host:x.git'],
    [
      { source: 'url', url: 'https://example.com/marketplace.json' },
      'https://example.com/marketplace.json',
    ],
    [{ source: 'url', url: 'http://example.com/m.json' }, null],
    [{ source: 'directory', path: './m' }, null],
    [{ source: 'file', path: '/m.json' }, null],
    [{ source: 'github', repo: '--evil' }, null],
  ])('marketplace %j is added as %j', (source, expected) => {
    expect(marketplaceAddArgument(source)).toBe(expected);
  });
});

describe('plugin ids in the manifest (T44)', () => {
  it('a normal plugin id is accepted (control for the next test)', () => {
    expect(
      PluginManifestSchema.safeParse({
        marketplaces: [],
        plugins: [{ id: 'x@market', scope: 'user', commandSource: false }],
        skipped: [],
      }).success,
    ).toBe(true);
  });

  it.each(['-x@market', 'x@-market', '--help@x'])(
    'a plugin id that starts like an option is refused: %s',
    (id) => {
      expect(
        PluginManifestSchema.safeParse({
          marketplaces: [],
          plugins: [{ id, scope: 'user', commandSource: false }],
          skipped: [],
        }).success,
      ).toBe(false);
    },
  );
});

describe('marketplace sources: only the forms push writes (T44)', () => {
  const addAccepted = (add: string) =>
    PluginManifestSchema.safeParse({ marketplaces: [{ name: 'm', add }], plugins: [], skipped: [] })
      .success;
  it.each([
    'owner/repo',
    'owner/repo#v1.2',
    'https://example.com/marketplace.json',
    'git@github.com:owner/repo.git#main',
  ])('accepts %s', (add) => {
    expect(addAccepted(add)).toBe(true);
  });
  it.each([
    '/home/me/marketplace',
    'C:\\market',
    './local',
    'http://example.com/m.json',
    '--help',
    '--scope',
    'owner/repo; rm -rf ~',
    'owner/repo & calc',
    'owner/repo"',
  ])('refuses %s', (add) => {
    expect(addAccepted(add)).toBe(false);
  });
});

describe('push saves only what pull accepts (BUG-01)', () => {
  it('leaves out, with why, a marketplace URL or plugin name pull would refuse', async () => {
    await putJson(join(base, 'plugins', 'installed_plugins.json'), {
      plugins: {
        'ok@plain': [{ scope: 'user' }],
        'tool@encoded': [{ scope: 'user' }],
        'tool@query': [{ scope: 'user' }],
        '.x@plain': [{ scope: 'user' }],
      },
    });
    await putJson(join(base, 'plugins', 'known_marketplaces.json'), {
      plain: { source: { source: 'url', url: 'https://host/market.json' } },
      encoded: { source: { source: 'url', url: 'https://host/my%20market.json' } },
      query: { source: { source: 'url', url: 'https://host/m.json?a=1&b=2' } },
    });
    const saved = await readPluginManifest({
      baseDir: base,
      platform: process.platform,
      scope: { kind: 'global' },
    });
    expect(saved?.plugins.map((plugin) => plugin.id)).toEqual(['ok@plain']);
    expect(saved?.skipped).toEqual([
      { what: 'tool@encoded', reason: 'its marketplace address has characters pull refuses' },
      { what: 'tool@query', reason: 'its marketplace address has characters pull refuses' },
      { what: '.x@plain', reason: 'unexpected plugin name' },
    ]);
    expect(PluginManifestSchema.safeParse(saved).success).toBe(true);
  });
});

describe('one reader of installed_plugins.json (BUG-03)', () => {
  it('counts a project install whose path is written another way as installed', async () => {
    await putJson(join(base, 'plugins', 'installed_plugins.json'), {
      plugins: { 'lint@company': [{ scope: 'project', projectPath: `${pluginProject()}${sep}` }] },
    });
    const current = await readCurrentPlugins(base, process.platform, pluginProject());
    expect(current.installed.has('lint@company|project')).toBe(true);
    const saved = await readPluginManifest({
      baseDir: base,
      platform: process.platform,
      scope: { kind: 'project', projectDir: pluginProject() },
    });
    expect(saved?.skipped.map((entry) => entry.what)).toEqual(['lint@company']);
  });

  it.runIf(process.platform === 'win32')('ignores the case of a Windows path', async () => {
    await putJson(join(base, 'plugins', 'installed_plugins.json'), {
      plugins: {
        'lint@company': [{ scope: 'project', projectPath: pluginProject().toUpperCase() }],
      },
    });
    const current = await readCurrentPlugins(base, 'win32', pluginProject());
    expect(current.installed.has('lint@company|project')).toBe(true);
  });
});
