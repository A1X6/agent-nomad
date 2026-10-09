import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE_PATHS } from '../src/index.ts';

/**
 * What a real Claude Code 2.1.295 did with plugins and mods (T95), checked against the files
 * it wrote: `fixtures/claude-code-2.1.295/` (its README says how each was made). The plugin
 * and mod sync (T96 to T102) builds on these facts, so a newer Claude Code that changes one
 * needs new fixtures and a change here first.
 */
const FIXTURES = fileURLToPath(new URL('./fixtures/claude-code-2.1.295/', import.meta.url));
const fixture = (path: string) => readFile(`${FIXTURES}${path}`, 'utf8');
const fixtureJson = async (path: string): Promise<unknown> => JSON.parse(await fixture(path));

const PLUGINS = CLAUDE_CODE_PATHS.plugins;

/** `plugins/data/<this>`: the id with every character outside `A-Za-z0-9_-` as `-`. */
const dataDirName = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '-');

/** `plugins/store/<this>`: the id with `_` for those characters, then a short id hash. */
const storeFileName = (id: string) =>
  `${id.replace(/[^A-Za-z0-9_-]/g, '_')}-${createHash('sha256').update(id).digest('hex').slice(0, 12)}.json`;

/** The `plugins/` folder after the runs, as `find` listed it, as paths from the base folder. */
const pluginsTree = async () =>
  new Set(
    (await fixture('plugins-tree.txt'))
      .split('\n')
      .filter((line) => line.startsWith('./'))
      .map((line) => `plugins/${line.slice(2)}`),
  );

describe('Claude Code 2.1.295 plugin sources (T95)', () => {
  it('a mod in skills/<name>/ loads as <name>@skills-dir, and its $.store is its own file', async () => {
    const manifest = (await fixtureJson('skills-dir-mod/.claude-plugin/plugin.json')) as {
      name: string;
    };
    const id = `${manifest.name}@${PLUGINS.skillsDirSource}`;
    expect(id).toBe('probe-mod@skills-dir');

    const tree = await pluginsTree();
    const storeFile = storeFileName(id);
    expect(storeFile).toBe('probe-mod_skills-dir-e89169932969.json');
    expect(tree).toContain(`${PLUGINS.storeDir}/${storeFile}`);
    // Not in plugins/data: a mod with only a hooks module got no data folder at all.
    expect([...tree].some((path) => path.startsWith(`${PLUGINS.dataDir}/${dataDirName(id)}`))).toBe(
      false,
    );
    expect(await fixtureJson(`store-${storeFile}`)).toEqual({ runs: 3 }); // one per claude -p run
  });

  it('names a store file the same way for a name with other characters', async () => {
    const tree = await pluginsTree();
    expect(tree).toContain(`${PLUGINS.storeDir}/${storeFileName('Odd.Mod_v2@skills-dir')}`);
    expect(storeFileName('Odd.Mod_v2@skills-dir')).toBe('Odd_Mod_v2_skills-dir-bc7e6d4978f9.json');
  });

  it('names data folders from the id for marketplace, skills-dir and inline plugins', async () => {
    const tree = await pluginsTree();
    const ids = [
      'lm-plugin@my-local.mkt',
      'Odd.Name_v2@my-local.mkt',
      `probe-init@${PLUGINS.skillsDirSource}`,
      `inline-plug@${PLUGINS.inlineSource}`,
    ];
    expect(ids.map(dataDirName)).toEqual([
      'lm-plugin-my-local-mkt',
      'Odd-Name_v2-my-local-mkt',
      'probe-init-skills-dir',
      'inline-plug-inline',
    ]);
    for (const id of ids) expect(tree).toContain(`${PLUGINS.dataDir}/${dataDirName(id)}`);
  });

  it("claude plugin validate lists a mod's hooks and $ calls, and exits 1 only on errors", async () => {
    const notes = (text: string, kind: string) =>
      text
        .split('\n')
        .map((line) => line.match(new RegExp(`^ {2}> \\./register\\.ts ${kind}: (.*)$`))?.[1])
        .filter((line) => line !== undefined);

    expect(notes(await fixture('validate/probe-mod.txt'), 'hooks')).toEqual([
      'session.start, tool.call{tool=Bash}',
    ]);
    expect(notes(await fixture('validate/probe-mod.txt'), 'calls')).toEqual([
      '$.store.get, $.store.set, $.ui.status',
    ]);
    // Only the method names: what a spawned program or a written path is never shows.
    expect(notes(await fixture('validate/risky.txt'), 'calls')).toEqual([
      '$.fs.write, $.model.query, $.process.spawn',
    ]);
    // The JSON report carries the same lines as notes of the hooks file.
    const report = (await fixtureJson('validate/probe-mod.json')) as {
      contents: { type: string; notes: string[] }[];
    };
    expect(report.contents.find((entry) => entry.type === 'hooks')?.notes).toContain(
      './register.ts calls: $.store.get, $.store.set, $.ui.status',
    );
    // Classic command hooks are not listed at all, so the review must read hooks.json itself.
    expect(await fixture('validate/classic-hooks.txt')).not.toContain('hooks:');

    const exitCodes = Object.fromEntries(
      (await fixture('validate/exit-codes.txt'))
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' ') as [string, string]),
    );
    expect(exitCodes).toEqual({
      'probe-mod': '0', // passed with a warning
      'probe-mod.strict': '1', // --strict fails on that warning
      risky: '0',
      'syntax-error': '1',
      'missing-module': '1',
      'bad-manifest': '1',
      'classic-hooks': '0',
    });
  });

  it('claude.ai synced plugins carry marketplaceName and an installationPreference', async () => {
    const manifest = (await fixtureJson('synced/plugins-manifest.json')) as {
      plugins: Record<string, unknown>[];
    };
    for (const plugin of manifest.plugins) {
      expect(Object.keys(plugin).sort()).toEqual(
        [
          'description',
          'installationPreference',
          'marketplaceName',
          'name',
          'pluginId',
          'updatedAt',
          'version',
        ].sort(),
      );
      expect(PLUGINS.installationPreferences).toContain(plugin['installationPreference']);
    }
    expect(await fixtureJson('synced/cowork-plugin-management.meta.json')).toEqual({
      server_plugin_id: 'plugin_0155zZVATbJU3jHUmPP9NvMC',
      marketplace_name: 'knowledge-work-plugins',
      installation_preference: 'available',
    });
  });

  it('claude.ai synced skills have a source and no creatorType (T42 reads creatorType)', async () => {
    const manifest = (await fixtureJson('synced/skills-manifest.json')) as {
      skills: Record<string, unknown>[];
    };
    expect(manifest.skills.some((skill) => 'creatorType' in skill)).toBe(false);
    expect(manifest.skills.map((skill) => [skill['source'], 'backingPluginId' in skill])).toEqual([
      ['anthropic-example', false],
      ['plugin', true],
      ['anthropic', false],
    ]);
  });
});
