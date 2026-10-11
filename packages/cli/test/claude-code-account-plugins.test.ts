import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  modFiles,
  savedFiles,
  SYNCED_ACCOUNT,
  syncedAccountPlugins,
  syncedPluginFiles,
  syncedPluginsManifest,
  validatePassNoHooks,
  type SyncedPluginEntry,
} from './claude-code-plugin-fixtures.ts';
import {
  base,
  claudeCodeAdapter,
  home,
  useProjectFolders,
  planStepWith,
} from './claude-code-project-fixtures.ts';
import { collected, collectedJson, paths, readText, writeTestFile } from './fakes.ts';

import {
  ACCOUNT_PLUGINS_PREFIX,
  collectAccountPlugins,
  createFileGatherer,
  pathsOf,
  planAccountPlugins,
  readSyncedPlugins,
  SKIPPED_NAMES,
  type CollectedFile,
  type RestorePlanContext,
} from '../src/index.ts';

useProjectFolders('agentnomad-account-plugins-');

/** One entry of the 2.1.296 plugins manifest, by name, with `fields` changed. */
function syncedPlugin(name: string, fields: Partial<SyncedPluginEntry> = {}): SyncedPluginEntry {
  const plugin = syncedPluginsManifest.plugins.find((entry) => entry.name === name);
  if (plugin === undefined) throw new Error(`no synced plugin ${name} in the fixture`);
  return { ...plugin, ...fields };
}

/** What push finds after Claude Code 2.1.296 synced `plugins` (see `syncedAccountPlugins`). */
async function syncedWith(plugins: readonly SyncedPluginEntry[], marketplaces = true) {
  await syncedAccountPlugins(base, { plugins, marketplaces });
  const found = await readSyncedPlugins(pathsOf(process.platform), base);
  return { ...found, ownNames: found.own.map((plugin) => plugin.name) };
}

const notSavedFrom = `Plugins not saved from claude.ai account ${SYNCED_ACCOUNT}:`;
const fromOthers = 'it comes from your organization or claude.ai, not from you';
const installedByClaudeAi = 'claude.ai installs it by itself on every PC signed in to the account';

describe('claude.ai plugins (T101): what push saves', () => {
  it('saves a plugin from your own uploads', async () => {
    const found = await syncedWith([syncedPlugin('my-upload')]);
    expect(found.ownNames).toEqual(['my-upload']);
    expect(found.notice).toBeNull();
    expect(found.problem).toBeNull();
  });

  it('takes a plugin on generation 2 from its <name>~g2 folder (T106)', async () => {
    const found = await syncedWith([syncedPlugin('my-upload')]);
    expect(found.own).toEqual([
      { name: 'my-upload', dir: join(base, 'plugins', 'synced', SYNCED_ACCOUNT, 'my-upload~g2') },
    ]);
  });

  it('takes a plugin without a generation from its plain folder (T106)', async () => {
    const found = await syncedWith([syncedPlugin('my-upload', { generation: undefined })]);
    expect(found.own).toEqual([
      { name: 'my-upload', dir: join(base, 'plugins', 'synced', SYNCED_ACCOUNT, 'my-upload') },
    ]);
  });

  it("never saves an organization's plugin, and names it", async () => {
    const found = await syncedWith([
      syncedPlugin('my-upload', { name: 'team-tool', marketplaceName: 'team-org' }),
    ]);
    expect(found.ownNames).toEqual([]);
    expect(found.notice).toBe(`${notSavedFrom} team-tool (${fromOthers}).`);
  });

  it("never saves a plugin from claude.ai's directory, and names it", async () => {
    const found = await syncedWith([
      syncedPlugin('my-upload', { name: 'directory-tool', marketplaceName: 'anthropic-directory' }),
    ]);
    expect(found.ownNames).toEqual([]);
    expect(found.notice).toBe(`${notSavedFrom} directory-tool (${fromOthers}).`);
  });

  it('never saves one claude.ai requires, even from your uploads', async () => {
    const found = await syncedWith([
      syncedPlugin('my-upload', { name: 'my-required', installationPreference: 'required' }),
    ]);
    expect(found.ownNames).toEqual([]);
    expect(found.notice).toBe(`${notSavedFrom} my-required (${installedByClaudeAi}).`);
  });

  it('never saves one claude.ai installs by itself (auto_install), even from your uploads', async () => {
    const found = await syncedWith([
      syncedPlugin('my-upload', { name: 'my-auto', installationPreference: 'auto_install' }),
    ]);
    expect(found.ownNames).toEqual([]);
    expect(found.notice).toBe(`${notSavedFrom} my-auto (${installedByClaudeAi}).`);
  });

  it('from the whole manifest saves only your upload and names the rest', async () => {
    const found = await syncedWith(syncedPluginsManifest.plugins);
    expect(found.ownNames).toEqual(['my-upload']);
    expect(found.notice).toBe(
      `${notSavedFrom} team-required (${fromOthers}), team-auto (${fromOthers}), directory-off (${fromOthers}).`,
    );
    expect([...found.allNames].sort()).toEqual([
      'directory-off',
      'my-upload',
      'team-auto',
      'team-required',
    ]);
  });

  it('leaves out a plugin whose marketplace is not listed, and names it', async () => {
    const found = await syncedWith([
      syncedPlugin('my-upload', { name: 'new-place', marketplaceName: 'brand-new' }),
    ]);
    expect(found.ownNames).toEqual([]);
    expect(found.notice).toBe(
      `${notSavedFrom} new-place (agentnomad cannot tell which claude.ai marketplace it comes from).`,
    );
  });

  it('without the marketplaces list saves nothing and says why', async () => {
    const found = await syncedWith([syncedPlugin('my-upload')], false);
    expect(found.ownNames).toEqual([]);
    expect(found.notice).toBe(
      `Claude Code keeps no list of claude.ai marketplaces for account ${SYNCED_ACCOUNT} (plugins/synced/${SYNCED_ACCOUNT}/.marketplaces.json), so your own plugins cannot be told apart from your organization's or claude.ai's: none were saved.`,
    );
  });

  it('an unreadable manifest saves nothing and names the account', async () => {
    await syncedAccountPlugins(base);
    await writeTestFile(join(base, 'plugins', 'synced', SYNCED_ACCOUNT, 'manifest.json'), '{');
    const found = await readSyncedPlugins(pathsOf(process.platform), base);
    expect(found.own).toEqual([]);
    expect(found.problem).toBe(
      `Claude Code's list of synced plugins (plugins/synced/${SYNCED_ACCOUNT}/manifest.json and .marketplaces.json) is missing or in a format agentnomad does not know.`,
    );
  });

  it('a manifest in another shape saves nothing and says why', async () => {
    await syncedAccountPlugins(base);
    await writeTestFile(
      join(base, 'plugins', 'synced', SYNCED_ACCOUNT, 'manifest.json'),
      JSON.stringify({ version: 2, entries: [] }),
    );
    const found = await readSyncedPlugins(pathsOf(process.platform), base);
    expect(found.own).toEqual([]);
    expect(found.problem).toContain('is missing or in a format agentnomad does not know.');
  });

  it('leaves out a folder with no plugin manifest, and names it', async () => {
    await syncedAccountPlugins(base, { plugins: [syncedPlugin('my-upload')] });
    const folder = join(base, 'plugins', 'synced', SYNCED_ACCOUNT, 'my-upload~g2');
    await rm(join(folder, '.claude-plugin', 'plugin.json'));
    const found = await readSyncedPlugins(pathsOf(process.platform), base);
    expect(found.own).toEqual([]);
    expect(found.notice).toBe(
      `${notSavedFrom} my-upload (its folder here has no .claude-plugin/plugin.json).`,
    );
  });

  // UX-02 (review 15): one reserved file per plugin, so an older CLI warns once per plugin.
  it('saves the folder whole under the reserved folder, without types/ or OS clutter', async () => {
    await syncedAccountPlugins(base);
    const files = createFileGatherer(process.platform, { skippedNames: SKIPPED_NAMES });
    const found = await collectAccountPlugins(files, await readSyncedPlugins(files.path, base));
    expect(paths(found)).toEqual([`${ACCOUNT_PLUGINS_PREFIX}my-upload.json`]);
    const saved = JSON.parse(new TextDecoder().decode(found[0]?.content)) as {
      name: string;
      files: { path: string }[];
    };
    expect(saved.name).toBe('my-upload');
    expect(saved.files.map((file) => file.path).sort()).toEqual([
      '.claude-plugin/plugin.json',
      'skills/my-upload/SKILL.md',
    ]);
  });

  it("push's question names them", () => {
    const part = claudeCodeAdapter(home).optionalParts?.find(
      (entry) => entry.id === 'account-plugins',
    );
    expect(part?.question(['my-upload'])).toBe(
      'Also save a copy of your 1 claude.ai plugin (my-upload)? Your claude.ai account already syncs them; the copy is for PCs without that account. Saved unless you say no.',
    );
  });
});

/** A claude.ai plugin as push saves it, with Claude Code's generated `types/` as well. */
const savedPlugin = (name: string): CollectedFile[] =>
  Object.entries(syncedPluginFiles(name))
    .filter(([file]) => file !== '.DS_Store')
    .map(([file, content]) => collected(`${ACCOUNT_PLUGINS_PREFIX}${name}/${file}`, content));

const noNames = { syncedNames: new Set<string>(), localNames: new Set<string>() };

/** A claude.ai plugin as push saves it since UX-02 (review 15): one `<name>.json`. */
const packedPlugin = (name: string, value?: unknown) =>
  collectedJson(
    `${ACCOUNT_PLUGINS_PREFIX}${name}.json`,
    value ?? {
      name,
      files: savedFiles(
        Object.entries(syncedPluginFiles(name))
          .filter(([file]) => file !== '.DS_Store')
          .map(([file, content]) => collected(file, content)),
      ),
    },
  );

describe('claude.ai plugins (T101): what pull may add', () => {
  it('adds a plugin saved as one file as skills/<name>/, never its types/', () => {
    const plan = planAccountPlugins([packedPlugin('my-upload')], noNames);
    expect(plan.toAdd).toEqual(['my-upload']);
    expect(paths(plan.files)).toEqual([
      'skills/my-upload/.claude-plugin/plugin.json',
      'skills/my-upload/skills/my-upload/SKILL.md',
    ]);
  });

  it('skips a plugin saved as one file that cannot be read, and says why', () => {
    const plan = planAccountPlugins(
      [packedPlugin('my-upload', { name: 'other', files: [] })],
      noNames,
    );
    expect(plan.toAdd).toEqual([]);
    expect(plan.skipped).toEqual([
      { name: 'my-upload', reason: 'its saved copy could not be read (it holds another plugin)' },
    ]);
  });

  it('adds a saved plugin as skills/<name>/, never its types/', () => {
    const plan = planAccountPlugins(savedPlugin('my-upload'), noNames);
    expect(plan.toAdd).toEqual(['my-upload']);
    expect(paths(plan.files)).toEqual([
      'skills/my-upload/.claude-plugin/plugin.json',
      'skills/my-upload/skills/my-upload/SKILL.md',
    ]);
  });

  it('skips a plugin this PC already gets from claude.ai', () => {
    const plan = planAccountPlugins(savedPlugin('My-Upload'), {
      ...noNames,
      syncedNames: new Set(['my-upload']),
    });
    expect(plan.toAdd).toEqual([]);
    expect(plan.skipped).toEqual([
      { name: 'My-Upload', reason: 'this PC already gets it from claude.ai' },
    ]);
  });

  it('skips a plugin whose name a local skill or plugin uses', () => {
    const plan = planAccountPlugins(savedPlugin('my-upload'), {
      ...noNames,
      localNames: new Set(['my-upload']),
    });
    expect(plan.skipped).toEqual([
      { name: 'my-upload', reason: 'you already have a local skill or plugin with this name' },
    ]);
  });

  // SEC-02 (review 16): Windows and macOS write `Evil/` and `evil/` into one folder.
  it('adds only the first of two saved plugins whose names differ only in case', () => {
    const plan = planAccountPlugins([...savedPlugin('Evil'), ...savedPlugin('evil')], noNames);
    expect(plan.toAdd).toEqual(['evil']);
    expect(plan.skipped).toEqual([{ name: 'Evil', reason: 'another saved copy has this name' }]);
  });

  it('skips a saved plugin without its manifest', () => {
    const plan = planAccountPlugins(
      [collected(`${ACCOUNT_PLUGINS_PREFIX}bare/skills/bare/SKILL.md`, 'x')],
      noNames,
    );
    expect(plan.skipped).toEqual([
      { name: 'bare', reason: 'it has no .claude-plugin/plugin.json' },
    ]);
  });
});

describe("claude.ai plugins (T101): pull's plan step", () => {
  const QUESTION =
    'Add them as local plugins in ~/.claude/skills/? Only needed if this PC uses another claude.ai account, or none. Added unless you say no.';
  const pluginManifest = () =>
    readText(join(base, 'skills', 'my-upload', '.claude-plugin', 'plugin.json'));

  /** The plan step with `claude` passing a plugin without hooks, and these answers. */
  async function planStep(
    files: CollectedFile[],
    answers: boolean[],
    overrides: Partial<RestorePlanContext> = {},
  ) {
    const t = await planStepWith(validatePassNoHooks, answers, { files, ...overrides });
    const report = await t.planned.restore(() => Promise.resolve('skip'), {});
    return { ...t, report };
  }

  it('lists them and asks, yes by default (T114); a no writes nothing', async () => {
    const t = await planStep(savedPlugin('my-upload'), [false]);
    expect(t.asked).toEqual([QUESTION]);
    expect(t.defaults).toEqual([true]);
    expect(t.lines).toContain(
      'Plugins from your claude.ai account on the other PC:\n  + my-upload@skills-dir (skills/my-upload)',
    );
    expect(t.lines).toContain(
      'Not added. To add them later: agentnomad pull --global --account-plugins',
    );
    expect(t.report.written).toEqual([]);
  });

  it('a yes reviews the plugin (T97) and writes it into ~/.claude/skills/<name>/', async () => {
    const t = await planStep(savedPlugin('my-upload'), [true]);
    expect(t.validated).toHaveLength(1);
    expect(await pluginManifest()).toBe(JSON.stringify({ name: 'my-upload', version: '1.0.0' }));
    expect(t.report.written).not.toContain('skills/my-upload/.claude-plugin/types/index.d.ts');
    expect(t.lines).toContain(
      'Adding my-upload@skills-dir as local plugins. If this PC later signs in to the claude.ai account they came from, Claude Code prefers the local copy.',
    );
  });

  it('--yes adds them without asking (T114)', async () => {
    const t = await planStep(savedPlugin('my-upload'), [], { assumeYes: true });
    expect(t.asked).toEqual([]);
    expect(await pluginManifest()).toContain('my-upload');
  });

  it('--yes alone still never accepts a plugin with code (T97 review)', async () => {
    const t = await planStep(modFiles(`${ACCOUNT_PLUGINS_PREFIX}probe-mod/`), [], {
      assumeYes: true,
    });
    expect(t.report.written).toEqual([]);
    expect(t.planned.declined).toBe(true);
  });

  it('--no-account-plugins adds none without asking, even with --yes', async () => {
    const t = await planStep(savedPlugin('my-upload'), [], {
      assumeYes: true,
      parts: new Map([['account-plugins', false]]),
    });
    expect(t.asked).toEqual([]);
    await expect(pluginManifest()).rejects.toThrow();
    expect(t.lines).toContain(
      'Not added. To add them later: agentnomad pull --global --account-plugins',
    );
  });

  it('--account-plugins adds them without asking', async () => {
    const t = await planStep(savedPlugin('my-upload'), [], {
      parts: new Map([['account-plugins', true]]),
    });
    expect(t.asked).toEqual([]);
    expect(await pluginManifest()).toContain('my-upload');
  });

  it('--account-plugins with --yes still never accepts a plugin with code (T97 review)', async () => {
    const t = await planStep(modFiles(`${ACCOUNT_PLUGINS_PREFIX}probe-mod/`), [], {
      assumeYes: true,
      parts: new Map([['account-plugins', true]]),
    });
    expect(t.report.written).toEqual([]);
    expect(t.planned.declined).toBe(true);
    expect(t.lines.join('\n')).toContain(
      '--yes never accepts a plugin with code; add --allow-commands to accept it.',
    );
  });

  it('skips one this PC already gets from claude.ai, without asking', async () => {
    await syncedAccountPlugins(base);
    const t = await planStep(savedPlugin('my-upload'), []);
    expect(t.asked).toEqual([]);
    expect(t.lines).toContain(
      'Plugins from your claude.ai account on the other PC:\n  - my-upload: skipped, this PC already gets it from claude.ai',
    );
    await expect(pluginManifest()).rejects.toThrow();
  });

  it('never touches a local skill of the same name', async () => {
    await writeTestFile(join(base, 'skills', 'my-upload', 'SKILL.md'), 'My own local version.');
    const t = await planStep(savedPlugin('my-upload'), [], {
      parts: new Map([['account-plugins', true]]),
    });
    expect(t.report.written).toEqual([]);
    expect(await readText(join(base, 'skills', 'my-upload', 'SKILL.md'))).toBe(
      'My own local version.',
    );
  });
});
