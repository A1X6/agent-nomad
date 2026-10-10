import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  putJson,
  SYNCED_ACCOUNT,
  syncedMarketplaces,
  syncedPluginsManifest,
  syncedSources,
} from './claude-code-plugin-fixtures.ts';
import { useTempDir } from './fakes.ts';

import {
  pathsOf,
  readSyncedPluginsOf,
  syncedPluginFolder,
  type SyncedPlugins,
} from '../src/index.ts';

/*
 * T106: `plugins/synced/<account>/` in the shapes the Claude Code 2.1.296 program reads and
 * writes (`.marketplaces.json` an object with `rows`, folders `<name>~g<N>` from generation 2).
 */

let base = '';
useTempDir('agentnomad-synced-plugins-', (dir) => (base = dir));

const accountDir = () => join(base, 'plugins', 'synced', SYNCED_ACCOUNT);

/** The 2.1.296 files of {@link syncedSources}, then `file` in the account folder as `value`. */
async function readWith(file?: 'manifest.json' | '.marketplaces.json', value?: unknown) {
  await syncedSources(base);
  if (file !== undefined) await putJson(join(accountDir(), file), value);
  return readSyncedPluginsOf(pathsOf(process.platform), accountDir());
}

/** The plugins a read found; fails the test on `'no list'` or `'unreadable'`. */
function listed(plugins: SyncedPlugins) {
  if (typeof plugins === 'string') throw new Error(`read as ${plugins}`);
  return plugins;
}

/** The first entry of the fixture manifest (the user's upload) with `fields` changed. */
const uploadWith = (fields: Record<string, unknown>) => ({
  lastUpdated: syncedPluginsManifest.lastUpdated,
  plugins: [{ ...syncedPluginsManifest.plugins[0], ...fields }],
});

describe('readSyncedPluginsOf (T106): the 2.1.296 shapes', () => {
  it('reads the manifest and the marketplaces object of Claude Code 2.1.296', async () => {
    expect(await readWith()).toEqual([
      {
        pluginId: 'plugin_01upload',
        name: 'my-upload',
        scope: 'account',
        installationPreference: 'available',
        presentsAs: 'skill',
        generation: 2,
      },
      {
        pluginId: 'plugin_02required',
        name: 'team-required',
        scope: 'org',
        installationPreference: 'required',
        presentsAs: undefined,
        generation: undefined,
      },
      {
        pluginId: 'plugin_03auto',
        name: 'team-auto',
        scope: 'org',
        installationPreference: 'auto_install',
        presentsAs: undefined,
        generation: undefined,
      },
      {
        pluginId: 'plugin_04blocked',
        name: 'directory-off',
        scope: 'default',
        installationPreference: 'not_available',
        presentsAs: undefined,
        generation: undefined,
      },
    ]);
  });

  it('still reads a bare list of marketplace rows', async () => {
    const plugins = await readWith('.marketplaces.json', syncedMarketplaces.rows);
    expect(listed(plugins).map((plugin) => plugin.scope)).toEqual([
      'account',
      'org',
      'org',
      'default',
    ]);
  });

  it('a marketplace row without scope cannot tell', async () => {
    const rows = syncedMarketplaces.rows.map(({ scope, ...row }) =>
      row.name === 'my-uploads' ? row : { ...row, scope },
    );
    const plugins = await readWith('.marketplaces.json', { rows });
    expect(listed(plugins)[0]?.scope).toBeUndefined();
  });

  it('a marketplaces object without rows is unreadable', async () => {
    expect(await readWith('.marketplaces.json', { etag: '"e1"', parserVersion: 1 })).toBe(
      'unreadable',
    );
  });

  it('a manifest with lastUpdated and no plugins lists none', async () => {
    expect(await readWith('manifest.json', { lastUpdated: 1760000000000 })).toEqual([]);
  });

  it('carries presentsAs', async () => {
    const plugins = await readWith('manifest.json', uploadWith({ presentsAs: 'connector' }));
    expect(listed(plugins)[0]?.presentsAs).toBe('connector');
  });

  it('an entry without generation has none', async () => {
    const plugins = await readWith('manifest.json', uploadWith({ generation: undefined }));
    expect(listed(plugins)[0]?.generation).toBeUndefined();
  });

  it('a generation that is not a whole number of 2 or more counts as absent, as in Claude Code', async () => {
    const plugins = await readWith('manifest.json', uploadWith({ generation: 1.5 }));
    expect(listed(plugins)[0]).toMatchObject({
      name: 'my-upload',
      generation: undefined,
    });
  });
});

describe('syncedPluginFolder (T106)', () => {
  it('is <name>~g<N> from generation 2', () => {
    expect(syncedPluginFolder({ name: 'my-upload', generation: 2 })).toBe('my-upload~g2');
  });

  it('is the plain name without a generation', () => {
    expect(syncedPluginFolder({ name: 'my-upload' })).toBe('my-upload');
  });

  it('is the plain name on generation 1', () => {
    expect(syncedPluginFolder({ name: 'my-upload', generation: 1 })).toBe('my-upload');
  });
});
