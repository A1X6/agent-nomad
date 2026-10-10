import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  globalDestination,
  marketplaceAddArgument,
  PLUGIN_VERSIONS_BUNDLE_PATH,
  PluginManifestSchema,
  projectDestination,
  readCurrentPlugins,
  readPluginManifest,
  readPluginVersions,
  readSavedPluginVersions,
  type PluginManifestInput,
} from '../src/index.ts';

import { installedPluginsFile, putJson, realisticPlugins } from './claude-code-plugin-fixtures.ts';
import { paths, text } from './fakes.ts';
import {
  base,
  collect,
  globalCollector,
  home,
  project,
  useProjectFolders,
} from './claude-code-project-fixtures.ts';

useProjectFolders('agentnomad-plugins-');

/** The plugin list a push of `scope` saves from the test's `~/.claude`. */
const manifestFor = (scope: PluginManifestInput['scope'] = { kind: 'global' }) =>
  readPluginManifest({ baseDir: base, platform: process.platform, scope });

describe('plugin list on push', () => {
  it('saves user plugins with addable marketplaces, and says what was left out', async () => {
    await realisticPlugins(home, project);
    const manifest = await manifestFor();
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
    await realisticPlugins(home, project);
    const manifest = await manifestFor({ kind: 'project', projectDir: project });
    expect(manifest?.plugins).toEqual([
      { id: 'team-lint@company', scope: 'project', commandSource: false },
    ]);
    expect(manifest?.marketplaces.map((entry) => entry.name)).toEqual(['company']);
  });

  it('nothing to save without installed plugins', async () => {
    expect(await manifestFor()).toBeNull();
  });

  it('the global collector adds .agentnomad/plugins.json, which restore never writes', async () => {
    await realisticPlugins(home, project);
    const files = await globalCollector().collect({ kind: 'global' }, { includeMemory: false });
    expect(paths(files)).toEqual(['.agentnomad/plugin-versions.json', '.agentnomad/plugins.json']);
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
    await putJson(installedPluginsFile(base), {
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
    const saved = await manifestFor();
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
    await putJson(installedPluginsFile(base), {
      plugins: { 'lint@company': [{ scope: 'project', projectPath: `${project}${sep}` }] },
    });
    const current = await readCurrentPlugins(base, process.platform, project);
    expect(current.installed.has('lint@company|project')).toBe(true);
    const saved = await manifestFor({ kind: 'project', projectDir: project });
    expect(saved?.skipped.map((entry) => entry.what)).toEqual(['lint@company']);
  });

  it.runIf(process.platform === 'win32')('ignores the case of a Windows path', async () => {
    await putJson(installedPluginsFile(base), {
      plugins: {
        'lint@company': [{ scope: 'project', projectPath: project.toUpperCase() }],
      },
    });
    const current = await readCurrentPlugins(base, 'win32', project);
    expect(current.installed.has('lint@company|project')).toBe(true);
  });
});

describe('plugin versions on push (T100)', () => {
  /** The saved `plugin-versions.json` of the collected `files`, as JSON. */
  const savedVersions = (files: Awaited<ReturnType<typeof collect>>) =>
    JSON.parse(text(files, PLUGIN_VERSIONS_BUNDLE_PATH)) as unknown;

  it('a global push saves the installed version of each saved plugin', async () => {
    await realisticPlugins(home, project);
    const files = await globalCollector().collect({ kind: 'global' }, { includeMemory: false });
    expect(savedVersions(files)).toEqual({
      plugins: [
        { id: 'brag@brag', scope: 'user', version: '1.0.0' },
        { id: 'builder@company', scope: 'user', version: '1.0.0' },
        { id: 'warp@claude-code-warp', scope: 'user', version: '1.0.0' },
      ],
    });
  });

  it('a project push saves the versions of that project’s plugins only', async () => {
    await realisticPlugins(home, project);
    expect(savedVersions(await collect())).toEqual({
      plugins: [{ id: 'team-lint@company', scope: 'project', version: '1.0.0' }],
    });
  });

  it('no versions file when no saved plugin has a known version', async () => {
    await realisticPlugins(home, project);
    await putJson(installedPluginsFile(base), {
      plugins: { 'brag@brag': [{ scope: 'user', version: 'unknown' }] },
    });
    const files = await globalCollector().collect({ kind: 'global' }, { includeMemory: false });
    expect(paths(files)).toEqual(['.agentnomad/plugins.json']);
  });

  /** The version push saves for `brag@brag` when Claude Code recorded `version`. */
  const savedVersionOf = async (version: unknown) => {
    await putJson(installedPluginsFile(base), {
      plugins: { 'brag@brag': [{ scope: 'user', version }] },
    });
    return readPluginVersions(
      { baseDir: base, platform: process.platform, scope: { kind: 'global' } },
      [{ id: 'brag@brag', scope: 'user', commandSource: false }],
    );
  };

  it('a version in the form Claude Code writes is saved (control for the next test)', async () => {
    expect(await savedVersionOf('1.2.0-a1b2c3d4e5f6')).toEqual({
      plugins: [{ id: 'brag@brag', scope: 'user', version: '1.2.0-a1b2c3d4e5f6' }],
    });
  });

  it.each([['unknown'], [7], ['-x'], ['1.0 beta'], [null]])(
    'a version Claude Code could not tell, or in an odd form, is left out: %j',
    async (version) => {
      expect(await savedVersionOf(version)).toBeNull();
    },
  );

  it('the version of an install in another scope is not taken', async () => {
    await putJson(installedPluginsFile(base), {
      plugins: { 'brag@brag': [{ scope: 'project', projectPath: project, version: '1.0.0' }] },
    });
    expect(
      await readPluginVersions(
        { baseDir: base, platform: process.platform, scope: { kind: 'global' } },
        [{ id: 'brag@brag', scope: 'user', commandSource: false }],
      ),
    ).toBeNull();
  });
});

describe('saved plugin versions on pull (T100)', () => {
  const content = (value: string) => new TextEncoder().encode(value);

  it('reads a saved plugin-versions.json', () => {
    const saved = '{"plugins":[{"id":"brag@brag","scope":"user","version":"1.0.0"}]}';
    expect(readSavedPluginVersions(content(saved))).toEqual({
      value: { plugins: [{ id: 'brag@brag', scope: 'user', version: '1.0.0' }] },
    });
  });

  it.each([
    ['that is not JSON', '{'],
    ['that is not the expected shape', '{"plugins": 1}'],
    [
      'holding a version that is not one',
      '{"plugins":[{"id":"a@b","scope":"user","version":"--x"}]}',
    ],
    ['holding an unknown key', '{"plugins":[],"extra":true}'],
  ])('a file %s is a problem, never a crash', (_, saved) => {
    expect(readSavedPluginVersions(content(saved))).toHaveProperty('problem');
  });
});
