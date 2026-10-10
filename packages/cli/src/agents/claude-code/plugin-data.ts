import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import type { PlatformPath } from 'node:path';

import { formatSize } from '../../ui/format-size.ts';
import { printableLine } from '../../ui/printable.ts';
import type {
  AfterRestoreContext,
  CollectedFile,
  ConflictChoice,
  RestorePlanContext,
} from '../adapter.ts';
import { pathsOf } from '../shared/detector-system.ts';
import type { FileGatherer } from '../shared/file-gathering.ts';
import { readSyncedPlugins } from './account-plugins.ts';
import { CLAUDE_CODE_PATHS as DATA } from './claude-code-paths.data.ts';
import { PLUGIN_DATA_PREFIX, PLUGIN_STORE_PREFIX } from './global-paths.ts';
import {
  readInstalledPlugins,
  readLocalMarketplaces,
  readPluginManifest,
  type PluginManifestInput,
} from './plugins.ts';
import { sameForRestore, type ClaudeCodeRestorer } from './restorer.ts';
import { PLUGIN_MANIFEST, SKILLS_DIR_MARKETPLACE } from './skills-dir-plugins.ts';

/*
 * Plugin data (T102, opt-in). Claude Code keeps a plugin's own state in `plugins/data/<folder>/`
 * and a mod's `$.store` in `plugins/store/<file>.json`, both named from the plugin id, and
 * leaves them behind when the plugin is removed. Push takes them only for the plugins the
 * setup restores, by the names computed from their ids, and never lists those folders, so a
 * removed plugin's leftovers are never saved. Pull writes them only for plugins installed
 * here once the setup and its plugins are in, under the same id.
 */

/** The id of the optional part for plugin data (T102); also the flag name. */
export const PLUGIN_DATA_PART = 'plugin-data';

/** A plugin's data and store file larger than this in all are left out: a setup is small. */
const PLUGIN_DATA_MAX_BYTES = 5 * 1024 * 1024;

/** The modes Claude Code gives `plugins/store/` and its files: only the owner reads them. */
const STORE_MODES = { folder: 0o700, file: 0o600 } as const;

const DATA_RULE = DATA.plugins.data;
const STORE_RULE = DATA.plugins.store;

/** The id with every character the rule calls unsafe turned into its replacement. */
const safeId = (id: string, rule: { unsafe: string; replaceWith: string }) =>
  id.replace(new RegExp(rule.unsafe, 'g'), rule.replaceWith);

/** `plugins/data/<folder>` of plugin `id`: `lm-plugin@my-local.mkt` → `lm-plugin-my-local-mkt`. */
export const pluginDataFolder = (id: string): string => safeId(id, DATA_RULE);

/** `plugins/store/<file>` of plugin `id`: `probe-mod@skills-dir` → `probe-mod_skills-dir-<hash>.json`. */
export function pluginStoreFile(id: string): string {
  const hash = createHash('sha256').update(id).digest('hex').slice(0, STORE_RULE.hashDigits);
  return `${safeId(id, STORE_RULE)}-${hash}${STORE_RULE.extension}`;
}

/** A name as the rules above make one, so a saved name can never leave its folder. */
const SAFE_NAME = /^[A-Za-z0-9_*-]+$/;
const isStoreFileName = (name: string) =>
  name.endsWith(STORE_RULE.extension) &&
  SAFE_NAME.test(name.slice(0, -STORE_RULE.extension.length));

const isFile = async (path: string) => (await stat(path).catch(() => null))?.isFile() ?? false;

/** `<name>@skills-dir` for each plugin folder in `skills/` on this PC (T97). */
async function skillsDirPluginIds(path: PlatformPath, baseDir: string): Promise<string[]> {
  const ids: string[] = [];
  const skills = path.join(baseDir, 'skills');
  for (const entry of await readdir(skills, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name === 'synced') continue;
    if (await isFile(path.join(skills, entry.name, ...PLUGIN_MANIFEST.split('/')))) {
      ids.push(`${entry.name}@${SKILLS_DIR_MARKETPLACE}`);
    }
  }
  return ids;
}

const sortedUnique = (ids: readonly string[]) => [...new Set(ids)].sort();

/**
 * The ids of the plugins a global setup restores (T102): those `plugins.json` reinstalls, the
 * plugins of saved local marketplaces (T98), plugin folders in `skills/` (T97) and, when they
 * are saved too, the user's claude.ai plugins (T101), which pull adds as `<name>@skills-dir`.
 */
export async function restoredPluginIds(
  input: Pick<PluginManifestInput, 'baseDir' | 'platform'>,
  options: { readonly accountPlugins: boolean },
): Promise<string[]> {
  const path = pathsOf(input.platform);
  const global = { ...input, scope: { kind: 'global' } } as const;
  const manifest = await readPluginManifest(global);
  const local = await readLocalMarketplaces(global);
  const account = options.accountPlugins
    ? (await readSyncedPlugins(path, input.baseDir)).own.map(
        (plugin) => `${plugin.name}@${SKILLS_DIR_MARKETPLACE}`,
      )
    : [];
  return sortedUnique([
    ...(manifest?.plugins.map((plugin) => plugin.id) ?? []),
    ...local.flatMap((marketplace) => marketplace.plugins.map((plugin) => plugin.id)),
    ...(await skillsDirPluginIds(path, input.baseDir)),
    ...account,
  ]);
}

/** The ids of the plugins installed on this PC, any scope, with plugin folders in `skills/`. */
async function installedPluginIds(path: PlatformPath, baseDir: string, platform: NodeJS.Platform) {
  const installed = await readInstalledPlugins(baseDir, platform);
  return sortedUnique([
    ...Object.keys(installed ?? {}),
    ...(await skillsDirPluginIds(path, baseDir)),
  ]);
}

/** Folders of a plugin's data and store file on this PC. */
const dataDir = (path: PlatformPath, baseDir: string) =>
  path.join(baseDir, ...DATA_RULE.folder.split('/'));
const storeDir = (path: PlatformPath, baseDir: string) =>
  path.join(baseDir, ...STORE_RULE.folder.split('/'));

/** Which of `ids` have a data folder or a store file here, for push's question. */
export async function idsWithPluginData(
  path: PlatformPath,
  baseDir: string,
  ids: readonly string[],
): Promise<string[]> {
  const found: string[] = [];
  for (const id of ids) {
    const folder = await stat(path.join(dataDir(path, baseDir), pluginDataFolder(id))).catch(
      () => null,
    );
    if (
      folder?.isDirectory() === true ||
      (await isFile(path.join(storeDir(path, baseDir), pluginStoreFile(id))))
    ) {
      found.push(id);
    }
  }
  return found;
}

/**
 * The data folder and store file of each of `ids`, as `.agentnomad/plugin-data/<folder>/...`
 * and `.agentnomad/plugin-store/<file>`, minus the skipped names. A plugin whose files pass
 * {@link PLUGIN_DATA_MAX_BYTES} in all is left out and said. Nothing else in `plugins/data`
 * or `plugins/store` is read.
 */
export async function collectPluginData(
  files: FileGatherer,
  baseDir: string,
  ids: readonly string[],
  onSkipped?: (bundlePath: string, reason: string) => void,
): Promise<CollectedFile[]> {
  const { path } = files;
  const found: CollectedFile[] = [];
  for (const id of ids) {
    const folder = pluginDataFolder(id);
    const store = pluginStoreFile(id);
    const own = await files.walk(
      path.join(dataDir(path, baseDir), folder),
      `${PLUGIN_DATA_PREFIX}${folder}`,
      () => false,
    );
    const storeFile = await files.readIfFile(
      path.join(storeDir(path, baseDir), store),
      `${PLUGIN_STORE_PREFIX}${store}`,
    );
    if (storeFile !== null) own.push(storeFile);
    const size = own.reduce((total, file) => total + file.content.length, 0);
    if (size > PLUGIN_DATA_MAX_BYTES) {
      onSkipped?.(
        `${PLUGIN_DATA_PREFIX}${folder}`,
        `the data of ${id} is ${formatSize(size)}, over the ${formatSize(PLUGIN_DATA_MAX_BYTES)} limit for one plugin`,
      );
      continue;
    }
    found.push(...own);
  }
  return found;
}

/** Saved plugin data in a bundle: data files by folder name, store files by file name. */
interface SavedPluginData {
  /** Paths from `plugins/data/` (`<folder>/<file>`). */
  readonly data: readonly CollectedFile[];
  /** Paths from `plugins/store/` (`<file>.json`). */
  readonly store: readonly CollectedFile[];
}

/** The saved plugin data among `files`; a name the rules could not have made is left out. */
function savedPluginData(files: readonly CollectedFile[]): SavedPluginData {
  const data: CollectedFile[] = [];
  const store: CollectedFile[] = [];
  for (const file of files) {
    if (file.path.startsWith(PLUGIN_DATA_PREFIX)) {
      const rest = file.path.slice(PLUGIN_DATA_PREFIX.length);
      const folder = rest.split('/')[0] ?? '';
      if (SAFE_NAME.test(folder) && rest.length > folder.length + 1)
        data.push({ ...file, path: rest });
    } else if (file.path.startsWith(PLUGIN_STORE_PREFIX)) {
      const name = file.path.slice(PLUGIN_STORE_PREFIX.length);
      if (isStoreFileName(name)) store.push({ ...file, path: name });
    }
  }
  return { data, store };
}

/** The names saved data goes under: data folders and store files. */
const savedNames = (saved: SavedPluginData) =>
  sortedUnique([
    ...saved.data.map((file) => file.path.split('/')[0] ?? ''),
    ...saved.store.map((file) => file.path),
  ]);

/** What pull's plan step gives the question about plugin data. */
export type PluginDataContext = Pick<
  RestorePlanContext,
  'files' | 'prompter' | 'reporter' | 'assumeYes' | 'parts' | 'askConflict' | 'conflictAnswer'
>;

/** What pull needs to write plugin data on this PC. */
export interface PluginDataRestoreDeps {
  /** Claude Code's base folder on this PC. */
  readonly baseDir: string;
  readonly platform: NodeJS.Platform;
  readonly restorer: Pick<ClaudeCodeRestorer, 'restoreFolder'>;
}

/** Writes the agreed plugin data after the setup and its plugins are in; asks nothing. */
export type PluginDataFollowUp = (context: AfterRestoreContext) => Promise<void>;

/**
 * Saved plugin data (T102): listed, and put back only after a yes or `--plugin-data` (`--yes`
 * alone never). Each file that is here and differs is asked about as pull asks about the
 * setup's files (T34). The follow-up runs after the plugins are installed, and writes a data
 * folder or store file only when a plugin installed here has that name, so only under the
 * same id; the store keeps Claude Code's permissions (folder 700, file 600).
 */
export async function planPluginData(
  context: PluginDataContext,
  deps: PluginDataRestoreDeps,
): Promise<PluginDataFollowUp> {
  const nothing: PluginDataFollowUp = () => Promise.resolve();
  const saved = savedPluginData(context.files);
  const names = savedNames(saved);
  if (names.length === 0) return nothing;
  context.reporter.info(
    [
      'Plugin data from the other PC (put back only for plugins installed here):',
      ...names.map((name) => `  + ${name}`),
    ].join('\n'),
  );
  const add =
    context.parts.get(PLUGIN_DATA_PART) ??
    (!context.assumeYes &&
      (await context.prompter.confirm(
        "Put back this plugin data? It holds what plugins and mods keep, e.g. a mod's saved choices.",
        false,
      )));
  if (!add) {
    context.reporter.info(
      'Not put back. To put it back later: agentnomad pull --global --plugin-data',
    );
    return nothing;
  }

  const path = pathsOf(deps.platform);
  const places = [
    {
      files: saved.data,
      dir: dataDir(path, deps.baseDir),
      prefix: PLUGIN_DATA_PREFIX,
      store: false,
    },
    {
      files: saved.store,
      dir: storeDir(path, deps.baseDir),
      prefix: PLUGIN_STORE_PREFIX,
      store: true,
    },
  ];
  // Each file that is here and differs, asked as pull asks about the setup's files (T34).
  const answers = new Map<string, ConflictChoice>();
  for (const place of places) {
    for (const file of place.files) {
      const native = path.join(place.dir, ...file.path.split('/'));
      const here = await readFile(native).catch(() => null);
      if (here === null || sameForRestore(deps.platform, file.path, here, file.content)) continue;
      const key = place.prefix + file.path;
      const answer = await context.askConflict?.(key, {
        overwriteAllowed: true,
        message: `${printableLine(native)} already exists here and is different.`,
      });
      if (answer !== undefined) answers.set(key, answer);
    }
  }

  return async ({ reporter }) => {
    // Read now: the plugins this pull installed or wrote count, under their own ids only.
    const ids = await installedPluginIds(path, deps.baseDir, deps.platform);
    const folders = new Set(ids.map(pluginDataFolder));
    const stores = new Set(ids.map(pluginStoreFile));
    const wanted = (name: string) => folders.has(name) || stores.has(name);
    const notHere = names.filter((name) => !wanted(name));
    const putBack: string[] = [];
    for (const place of places) {
      const files = place.files.filter((file) => wanted(file.path.split('/')[0] ?? ''));
      if (files.length === 0) continue;
      if (place.store) await mkdir(place.dir, { recursive: true, mode: STORE_MODES.folder });
      const report = await deps.restorer.restoreFolder(place.dir, files, (file) =>
        Promise.resolve(answers.get(place.prefix + file) ?? context.conflictAnswer ?? 'skip'),
      );
      for (const warning of report.warnings) reporter.warn(warning);
      if (place.store && deps.platform !== 'win32') {
        await chmod(place.dir, STORE_MODES.folder);
        for (const file of [...report.written, ...report.backups]) {
          await chmod(path.join(place.dir, ...file.split('/')), STORE_MODES.file);
        }
      }
      putBack.push(...report.written.map((file) => file.split('/')[0] ?? ''));
    }
    const done = sortedUnique(putBack);
    if (done.length > 0) reporter.success(`Put back plugin data: ${done.join(', ')}.`);
    if (notHere.length > 0) {
      reporter.info(`Not put back, as no plugin installed here uses it: ${notHere.join(', ')}.`);
    }
  };
}
