import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  addedFromFolders,
  installedPluginsFile,
  MOD_NAME,
  modFiles,
  PLUGIN_DATA_FOLDERS,
  PLUGIN_STORE_FILES,
  PLUGIN_STORE_MODES,
  putJson,
  realisticPlugins,
  syncedAccountPlugins,
  validateCli,
  validatePassWithWarning,
  writePluginData,
  writePluginStore,
} from './claude-code-plugin-fixtures.ts';
import {
  base,
  claudeCodeAdapter,
  globalCollector,
  home,
  project,
  root,
  useProjectFolders,
} from './claude-code-project-fixtures.ts';
import {
  collected,
  collectedJson,
  executableLookup,
  exists,
  paths,
  readJson,
  readText,
  recordingReporter,
  scriptedPrompter,
  writeTestFile,
} from './fakes.ts';

import {
  collectPluginData,
  createFileGatherer,
  findPluginValidator,
  PLUGIN_DATA_PREFIX,
  PLUGIN_STORE_PREFIX,
  pluginDataFolder,
  pluginStoreFile,
  restoredPluginIds,
  SKIPPED_NAMES,
  type CollectedFile,
  type ConflictChoice,
  type RestorePlanContext,
} from '../src/index.ts';

useProjectFolders('agentnomad-plugin-data-');

/** The mod of the T97 tests in `skills/`, as Claude Code names it, and its data names. */
const MOD_ID = `${MOD_NAME}@skills-dir`;
const MOD_STORE = 'probe-mod_skills-dir-e89169932969.json';
const MOD_DATA = 'probe-mod-skills-dir';

/** A mod's saved choice, as `$.store` keeps it. */
const CHOICE = { theme: 'dark' };

/** The mod in `~/.claude/skills/probe-mod/` on this PC (T97). */
async function modInSkills(): Promise<void> {
  for (const file of modFiles()) {
    await writeTestFile(join(base, ...file.path.split('/')), file.content);
  }
}

/** Plugin `id` installed for the user, from a GitHub marketplace. */
async function installed(...ids: string[]): Promise<void> {
  await putJson(installedPluginsFile(base), {
    version: 2,
    plugins: Object.fromEntries(ids.map((id) => [id, [{ scope: 'user', version: '1.0.0' }]])),
  });
  await putJson(
    join(base, 'plugins', 'known_marketplaces.json'),
    Object.fromEntries(
      ids.map((id) => [id.split('@')[1], { source: { source: 'github', repo: 'me/market' } }]),
    ),
  );
}

const ids = (accountPlugins = false) =>
  restoredPluginIds({ baseDir: base, platform: process.platform }, { accountPlugins });

/** `collectPluginData` for `pluginIds` with the skipped names, recording what it left out. */
async function collectFor(pluginIds: readonly string[]) {
  const skipped: string[] = [];
  const files = createFileGatherer(process.platform, { skippedNames: SKIPPED_NAMES });
  const found = await collectPluginData(files, base, pluginIds, (path, reason) =>
    skipped.push(`${path}: ${reason}`),
  );
  return { found, skipped };
}

describe('plugin data names (T102)', () => {
  it.each(PLUGIN_DATA_FOLDERS)('the data folder of %s is %s', (id, folder) => {
    expect(pluginDataFolder(id)).toBe(folder);
  });

  it.each(PLUGIN_STORE_FILES)('the store file of %s is %s', (id, file) => {
    expect(pluginStoreFile(id)).toBe(file);
  });
});

describe('plugin data (T102): which plugins push takes it for', () => {
  it('the plugins plugins.json reinstalls and those of local marketplaces', async () => {
    await realisticPlugins(home, project);
    expect(await ids()).toEqual([
      'brag@brag',
      'builder@company',
      'mine@local-tools',
      'warp@claude-code-warp',
    ]);
  });

  it('the plugin of a saved local marketplace (T98)', async () => {
    await addedFromFolders(base, { 'my-tools': join(root, 'tools') });
    expect(await ids()).toEqual([`${MOD_NAME}@my-tools`]);
  });

  it('a plugin folder in skills/ (T97)', async () => {
    await modInSkills();
    expect(await ids()).toEqual([MOD_ID]);
  });

  it('your claude.ai plugins only when they are saved too (T101), by their id after pull', async () => {
    await syncedAccountPlugins(base);
    expect(await ids(false)).toEqual([]);
    expect(await ids(true)).toEqual(['my-upload@skills-dir']);
  });
});

describe('plugin data (T102): what push takes', () => {
  it("takes a plugin's data folder and its store file", async () => {
    await writePluginData(base, MOD_DATA, { 'cache/state.json': '{}' });
    await writePluginStore(base, MOD_STORE, CHOICE);
    const { found } = await collectFor([MOD_ID]);
    expect(paths(found)).toEqual([
      `${PLUGIN_DATA_PREFIX}${MOD_DATA}/cache/state.json`,
      `${PLUGIN_STORE_PREFIX}${MOD_STORE}`,
    ]);
  });

  it('leaves out the skipped names inside a data folder', async () => {
    await writePluginData(base, MOD_DATA, { 'notes.md': 'x', 'node_modules/a/index.js': 'x' });
    const { found } = await collectFor([MOD_ID]);
    expect(paths(found)).toEqual([`${PLUGIN_DATA_PREFIX}${MOD_DATA}/notes.md`]);
  });

  it("leaves out a plugin's data over the size limit, and says so", async () => {
    await writePluginData(base, MOD_DATA, { 'big.bin': 'x'.repeat(5 * 1024 * 1024 + 1) });
    const { found, skipped } = await collectFor([MOD_ID]);
    expect(found).toEqual([]);
    expect(skipped).toEqual([
      `${PLUGIN_DATA_PREFIX}${MOD_DATA}: the data of ${MOD_ID} is 5.0 MB, over the 5.0 MB limit for one plugin`,
    ]);
  });

  it('never takes the leftovers of a removed plugin', async () => {
    await modInSkills();
    await writePluginData(base, MOD_DATA, { 'state.json': '{}' });
    await writePluginData(base, 'vercel-inline', { 'state.json': '{}' });
    await writePluginStore(base, 'gone_inline-0123456789ab.json', CHOICE);
    const found = await globalCollector().collect(
      { kind: 'global' },
      { includeMemory: false, include: new Set(['plugin-data']) },
    );
    expect(
      paths(found).filter(
        (path) => path.startsWith(PLUGIN_DATA_PREFIX) || path.startsWith(PLUGIN_STORE_PREFIX),
      ),
    ).toEqual([`${PLUGIN_DATA_PREFIX}${MOD_DATA}/state.json`]);
  });

  it('takes nothing unless asked', async () => {
    await modInSkills();
    await writePluginStore(base, MOD_STORE, CHOICE);
    const found = await globalCollector().collect({ kind: 'global' }, { includeMemory: false });
    expect(found.some((file) => file.path.startsWith(PLUGIN_STORE_PREFIX))).toBe(false);
  });

  it("push's question names the plugins with data", async () => {
    await modInSkills();
    await writePluginStore(base, MOD_STORE, CHOICE);
    const part = claudeCodeAdapter(home).optionalParts?.find((entry) => entry.id === 'plugin-data');
    const found = await part?.available();
    expect(found?.names).toEqual([MOD_ID]);
    expect(part?.question([MOD_ID])).toBe(
      "Also save the data of 1 plugin (probe-mod@skills-dir)? It holds what plugins and mods keep, e.g. a mod's saved choices; only for plugins this setup puts back.",
    );
  });
});

/** The saved store file of the mod. */
const savedStore = (value: unknown = CHOICE) =>
  collectedJson(`${PLUGIN_STORE_PREFIX}${MOD_STORE}`, value);
const storePath = () => join(base, 'plugins', 'store', MOD_STORE);

describe("plugin data (T102): pull's plan step", () => {
  const QUESTION =
    "Put back this plugin data? It holds what plugins and mods keep, e.g. a mod's saved choices.";

  /** The plan step for `files` with these answers, then the restore and its follow-up. */
  async function pull(
    files: CollectedFile[],
    answers: boolean[],
    overrides: Partial<RestorePlanContext> = {},
  ) {
    const script = scriptedPrompter(answers);
    const { reporter, lines } = recordingReporter({ levels: false });
    const system = executableLookup({
      platform: 'linux',
      homedir: home,
      env: { PATH: '/usr/bin' },
      executables: ['/usr/bin/claude'],
    });
    const adapter = claudeCodeAdapter(home, {
      pluginValidator: await findPluginValidator(system, validateCli(validatePassWithWarning).cli),
    });
    if (!adapter.planRestore) throw new Error('no plan step');
    const planned = await adapter.planRestore({
      target: { kind: 'global' },
      files,
      conflicts: new Map(),
      conflictAnswer: undefined,
      prompter: script.prompter,
      reporter,
      assumeYes: false,
      allowCommands: false,
      parts: new Map(),
      ...overrides,
    });
    await planned.restore(() => Promise.resolve('skip'), {});
    await planned.afterRestore({ reporter });
    return { asked: script.asked, lines };
  }

  it('lists it and asks; no by default writes nothing', async () => {
    await modInSkills();
    const t = await pull([savedStore()], [false]);
    expect(t.asked).toEqual([QUESTION]);
    expect(t.lines).toContain(
      `Plugin data from the other PC (put back only for plugins installed here):\n  + ${MOD_STORE}`,
    );
    expect(t.lines).toContain(
      'Not put back. To put it back later: agentnomad pull --global --plugin-data',
    );
    expect(await exists(storePath())).toBe(false);
  });

  it('--yes alone never puts it back', async () => {
    await modInSkills();
    const t = await pull([savedStore()], [], { assumeYes: true });
    expect(t.asked).toEqual([]);
    expect(await exists(storePath())).toBe(false);
  });

  it('the flag puts back the store of a plugin installed here, without asking', async () => {
    await modInSkills();
    const t = await pull([savedStore()], [], { parts: new Map([['plugin-data', true]]) });
    expect(t.asked).toEqual([]);
    expect(await readJson(storePath())).toEqual(CHOICE);
    expect(t.lines).toContain(`Put back plugin data: ${MOD_STORE}.`);
  });

  it('puts back a data folder under the same id only', async () => {
    await installed('lm-plugin@my-local.mkt');
    const t = await pull(
      [collected(`${PLUGIN_DATA_PREFIX}lm-plugin-my-local-mkt/state.json`, '{"a":1}')],
      [true],
    );
    expect(
      await readText(join(base, 'plugins', 'data', 'lm-plugin-my-local-mkt', 'state.json')),
    ).toBe('{"a":1}');
    expect(t.lines).toContain('Put back plugin data: lm-plugin-my-local-mkt.');
  });

  it('writes nothing for a plugin not installed here, and says so', async () => {
    const t = await pull([savedStore()], [true]);
    expect(await exists(storePath())).toBe(false);
    expect(t.lines).toContain(`Not put back, as no plugin installed here uses it: ${MOD_STORE}.`);
  });

  it('writes the store after the setup puts back its mod in this pull', async () => {
    const files = [...modFiles(), savedStore()];
    // The review of the mod (T97): write it.
    await pull(files, [true], { parts: new Map([['plugin-data', true]]) });
    expect(await exists(join(base, 'skills', MOD_NAME, 'hooks', 'register.ts'))).toBe(true);
    expect(await readJson(storePath())).toEqual(CHOICE);
  });

  it.skipIf(process.platform === 'win32')(
    "keeps the store's permissions: folder 700, file 600",
    async () => {
      await modInSkills();
      await pull([savedStore()], [true]);
      expect((await stat(join(base, 'plugins', 'store'))).mode & 0o777).toBe(
        PLUGIN_STORE_MODES.folder,
      );
      expect((await stat(storePath())).mode & 0o777).toBe(PLUGIN_STORE_MODES.file);
    },
  );

  it.each<[ConflictChoice, unknown]>([
    ['overwrite', CHOICE],
    ['skip', { theme: 'light' }],
  ])('asks about a store file here that differs: %s', async (choice, after) => {
    await modInSkills();
    await writePluginStore(base, MOD_STORE, { theme: 'light' });
    const asked: string[] = [];
    await pull([savedStore()], [true], {
      askConflict: (path) => {
        asked.push(path);
        return Promise.resolve(choice);
      },
    });
    expect(asked).toEqual([`${PLUGIN_STORE_PREFIX}${MOD_STORE}`]);
    expect(await readJson(storePath())).toEqual(after);
  });

  it('ignores a saved name the naming rules could not make', async () => {
    await modInSkills();
    const t = await pull([collected(`${PLUGIN_STORE_PREFIX}notes.txt`, 'x')], []);
    expect(t.asked).toEqual([]);
    expect(t.lines.some((line) => line.includes('notes.txt'))).toBe(false);
  });
});
