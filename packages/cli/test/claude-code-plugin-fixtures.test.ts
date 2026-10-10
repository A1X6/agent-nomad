import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PLUGIN_DATA_FOLDERS,
  PLUGIN_STORE_FILES,
  PLUGIN_STORE_MODES,
  SKILLS_DIR_MARKETPLACE,
  SYNCED_ACCOUNT,
  VALIDATED_MOD,
  type ValidateRun,
  olderSyncedSkillsManifest,
  syncedMarketplaces,
  syncedPluginMeta,
  syncedPluginsManifest,
  syncedSkillsManifest,
  syncedSources,
  validateBrokenManifest,
  validatePassWithWarning,
} from './claude-code-plugin-fixtures.ts';
import { readJson, readText, useTempDir } from './fakes.ts';

/*
 * The plugin source fixtures (T96) hold what Claude Code 2.1.295 and 2.1.296 were seen to do;
 * these tests keep each fixture true to the rule it stands for.
 */

describe('plugin data folders and store files (T96)', () => {
  it.each(PLUGIN_DATA_FOLDERS)(
    '%s: every other character than A-Za-z0-9_*- becomes -',
    (id, folder) => {
      expect(id.replace(/[^A-Za-z0-9_*-]/g, '-')).toBe(folder);
    },
  );

  it.each(PLUGIN_STORE_FILES)(
    '%s: the safe id, then the first 12 hex of its SHA-256',
    (id, file) => {
      const hash = createHash('sha256').update(id).digest('hex').slice(0, 12);
      expect(`${id.replace(/[^A-Za-z0-9_*-]/g, '_')}-${hash}.json`).toBe(file);
    },
  );

  it('the store ids are mods in skills folders', () => {
    expect(PLUGIN_STORE_FILES.map(([id]) => id.split('@')[1])).toEqual([
      SKILLS_DIR_MARKETPLACE,
      SKILLS_DIR_MARKETPLACE,
    ]);
  });

  it('only the owner reads or writes the store', () => {
    expect(PLUGIN_STORE_MODES.folder & 0o077).toBe(0);
    expect(PLUGIN_STORE_MODES.file & 0o077).toBe(0);
  });
});

describe('claude plugin validate reports (T96)', () => {
  it('a pass with a warning exits 0 and lists one hooks: and one calls: line', () => {
    expect(validatePassWithWarning.exitCode).toBe(0);
    expect(validatePassWithWarning.json['success']).toBe(true);
    expect(validatePassWithWarning.text).toContain('  ❯ ./register.ts hooks: session.start\n');
    expect(validatePassWithWarning.text).toContain(
      '  ❯ ./register.ts calls: $.store.get, $.store.set, $.ui.status\n',
    );
  });

  it('a broken manifest exits 1 and still lists the module', () => {
    expect(validateBrokenManifest.exitCode).toBe(1);
    expect(validateBrokenManifest.json['success']).toBe(false);
    expect(validateBrokenManifest.text).toContain('./register.ts calls:');
    expect(validateBrokenManifest.text.endsWith('✘ Validation failed\n')).toBe(true);
  });

  it('holds no path of the PC it was captured on', () => {
    const runs: ValidateRun[] = [validatePassWithWarning, validateBrokenManifest];
    for (const run of runs) {
      expect(run.json['target']).toBe(`${VALIDATED_MOD}/.claude-plugin/plugin.json`);
      // No drive, no home folder and no Windows separator, in the text or the report.
      expect(run.text + JSON.stringify(run.json)).not.toMatch(
        /[A-Za-z]:[\\/]|\/Users\/|\/home\/|\\/,
      );
    }
  });
});

describe('claude.ai synced files (T96)', () => {
  it('the 2.1.295 skills manifest has every source and no creatorType', () => {
    expect(syncedSkillsManifest.skills.map((skill) => skill.source)).toEqual([
      'plugin',
      'anthropic',
      'anthropic-example',
      'custom',
      'session-refs',
    ]);
    expect(syncedSkillsManifest.skills.filter((skill) => 'creatorType' in skill)).toEqual([]);
    expect(syncedSkillsManifest.skills[0]).toHaveProperty('backingPluginId', 'plugin_01upload');
  });

  it('the older skills manifest still has creatorType', () => {
    expect(olderSyncedSkillsManifest.skills[0]).toHaveProperty('creatorType', 'user');
  });

  it('the plugins manifest has every installationPreference', () => {
    expect(syncedPluginsManifest.plugins.map((plugin) => plugin.installationPreference)).toEqual([
      'available',
      'required',
      'auto_install',
      'not_available',
    ]);
  });

  it('the .meta.json repeats its plugin’s id, marketplace and preference', () => {
    const plugin = syncedPluginsManifest.plugins[0];
    expect(syncedPluginMeta).toEqual({
      server_plugin_id: plugin?.pluginId,
      marketplace_name: plugin?.marketplaceName,
      installation_preference: plugin?.installationPreference,
    });
  });

  it('the marketplaces have every scope', () => {
    expect(syncedMarketplaces.map((marketplace) => marketplace.scope)).toEqual([
      'org',
      'default',
      'account',
    ]);
  });
});

describe('syncedSources (T96)', () => {
  let base = '';
  useTempDir('agentnomad-synced-', (dir) => (base = dir));

  it('writes the four files where Claude Code keeps them', async () => {
    await syncedSources(base);
    const skills = join(base, 'skills', 'synced', SYNCED_ACCOUNT);
    const plugins = join(base, 'plugins', 'synced', SYNCED_ACCOUNT);
    expect(await readJson(join(skills, 'manifest.json'))).toEqual(syncedSkillsManifest);
    expect(await readJson(join(plugins, 'manifest.json'))).toEqual(syncedPluginsManifest);
    expect(JSON.parse(await readText(join(plugins, '.marketplaces.json')))).toEqual(
      syncedMarketplaces,
    );
    expect(await readJson(join(plugins, 'my-upload.meta.json'))).toEqual({
      server_plugin_id: 'plugin_01upload',
      marketplace_name: 'my-uploads',
      installation_preference: 'available',
    });
  });
});
