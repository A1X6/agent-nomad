import * as z from 'zod';

import {
  JsonObjectSchema,
  parseJsonWith,
  valueOrNull,
  type JsonResult,
} from '../../system/json.ts';
import { printableLine } from '../../ui/printable.ts';
import type { CollectedFile, ConflictResolver, RestoreReport } from '../adapter.ts';
import { jsonFile } from '../shared/file-gathering.ts';
import { pathsOf } from '../shared/detector-system.ts';
import { PLUGIN_DIRS_PREFIX } from './global-paths.ts';
import {
  askFolderConflicts,
  exists,
  homeFolderFor,
  SAVED_FOLDER_SHAPE,
  saveFolder,
  savedFolderFiles,
  writeFolders,
  type FolderPlaceDeps,
  type FolderSave,
  type FolderToWrite,
  type FolderWriteDeps,
  type LocalMarketplaceContext,
} from './local-marketplaces.ts';
import {
  askPluginFolders,
  pluginFolderChange,
  type PluginFolderToReview,
  type PluginValidator,
} from './plugin-review.ts';
import type { ProgramCli } from './plugin-sync.ts';
import { MarketplaceNameSchema } from './plugins.ts';
import { PLUGIN_HOOKS, PLUGIN_MANIFEST } from './skills-dir-plugins.ts';

/*
 * Plugin folders that `env.CLAUDE_CODE_PLUGIN_DIRS` in the user's settings loads every session
 * (T99). The setting syncs with `settings.json`, but the folders exist only on the PC that has
 * them: push saves each one as T98 saves a local marketplace, and pull writes them back and
 * points the value at the folders it wrote. `--plugin-dir` and plugins an SDK passes are given
 * to one run only and are never seen, so they are not handled.
 */

/** The `env` name, as Claude Code 2.1.296 reads it. */
const PLUGIN_DIRS_VARIABLE = 'CLAUDE_CODE_PLUGIN_DIRS';

/** The user settings file, the only one that sets it: see `pluginDirFiles`. */
const USER_SETTINGS = 'settings.json';

const SeparatorSchema = z.enum([':', ';']);
type Separator = z.infer<typeof SeparatorSchema>;

/** What separates the folders on `platform`: Node's `path.delimiter`, which Claude Code uses. */
export const pluginDirsSeparator = (platform: NodeJS.Platform): Separator =>
  platform === 'win32' ? ';' : ':';

/** The folders `value` names, as Claude Code splits it: trimmed, empty ones dropped. */
export const splitPluginDirs = (value: string, separator: Separator): string[] =>
  value
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

const SavedPluginDirSchema = z.strictObject({
  /** The folder's name, for the folder pull writes when the path from home cannot be used. */
  name: MarketplaceNameSchema,
  /** The folder as the value names it, so pull can replace it there. */
  entry: z.string().min(1).max(4096),
  /** The separator of the PC that saved it, to split the value pull receives. */
  separator: SeparatorSchema,
  ...SAVED_FOLDER_SHAPE,
});
type SavedPluginDir = z.infer<typeof SavedPluginDirSchema>;

/** A saved plugin folder as pull reads it; never throws. */
export const readSavedPluginDir = (content: Uint8Array): JsonResult<SavedPluginDir> =>
  parseJsonWith(SavedPluginDirSchema, content);

const SettingsEnvSchema = z.looseObject({
  env: z.looseObject({ [PLUGIN_DIRS_VARIABLE]: z.string().optional() }).optional(),
});

/** The value in a settings file's `env`; `null` when it has none or cannot be read. */
const pluginDirsValue = (settings: Uint8Array): string | null =>
  valueOrNull(parseJsonWith(SettingsEnvSchema, settings))?.env?.[PLUGIN_DIRS_VARIABLE] ?? null;

/** What push needs to save plugin folders. */
export interface PluginDirCollect {
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
  /** Finds `git` (`findGit`); without it, or without git, every folder is walked. */
  readonly git?: () => Promise<ProgramCli | null>;
  /** Told about each folder or file left out, with why, so push can say so. */
  readonly onSkipped?: (what: string, reason: string) => void;
}

/** `~`, `~/x` and `~\x` from home, as Claude Code reads them; anything else as it is. */
function fromHome(entry: string, homedir: string, platform: NodeJS.Platform): string {
  if (entry !== '~' && !entry.startsWith('~/') && !entry.startsWith('~\\')) return entry;
  return pathsOf(platform).join(homedir, entry.slice(1));
}

/** A folder's name as a saved name: characters a file name may not hold become `-`. */
const nameOf = (folder: string, platform: NodeJS.Platform): string => {
  const name = pathsOf(platform)
    .basename(folder)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '');
  return name === '' ? 'plugin' : name.slice(0, 100);
};

/**
 * The saved files of each plugin folder `env.CLAUDE_CODE_PLUGIN_DIRS` names in the user's
 * `settings.json` (T99), one reserved entry each, as `saveFolder` saves them (T98). Only the
 * user settings: Claude Code takes this variable from them and not from a project's
 * `.claude/settings.json` or `settings.local.json`. A folder that is not an absolute path or
 * `~/…` (Claude Code skips it too), is gone, or is larger than the server takes, is left out
 * and said.
 */
export async function pluginDirFiles(
  settings: CollectedFile | undefined,
  options: PluginDirCollect,
): Promise<CollectedFile[]> {
  if (settings?.path !== USER_SETTINGS) return [];
  const value = pluginDirsValue(settings.content);
  if (value === null) return [];
  const path = pathsOf(options.platform);
  const separator = pluginDirsSeparator(options.platform);
  const entries = splitPluginDirs(value, separator);
  if (entries.length === 0) return [];
  const save: FolderSave = {
    platform: options.platform,
    homedir: options.homedir,
    git: (await options.git?.()) ?? null,
    onSkipped: options.onSkipped,
  };
  const saved: CollectedFile[] = [];
  for (const [index, entry] of entries.entries()) {
    const what = `plugin folder ${entry}`;
    const folder = fromHome(entry, options.homedir, options.platform);
    if (!path.isAbsolute(folder)) {
      options.onSkipped?.(what, 'it is not a full path, so Claude Code does not load it either');
      continue;
    }
    const name = nameOf(folder, options.platform);
    const files = await saveFolder(folder, { name, what }, save);
    if (files === null) continue;
    const value: SavedPluginDir = { name, entry, separator, ...files };
    saved.push(jsonFile(`${PLUGIN_DIRS_PREFIX}${String(index)}.json`, value));
  }
  return saved;
}

/** What pull needs to write plugin folders on this PC. */
export interface PluginDirRestoreDeps extends FolderPlaceDeps, FolderWriteDeps {
  readonly validator: () => Promise<PluginValidator>;
}

/** What pull's plan step decided about the saved plugin folders of one setup. */
export interface PluginDirPlan {
  /** A plugin folder was declined in the review (T97), so a later push asks first. */
  readonly declined: boolean;
  /**
   * `files` with the value in `settings.json` naming the folders pull writes, joined with this
   * PC's separator; a declined folder is taken out of it. The rest as it is.
   */
  withPluginDirs(files: readonly CollectedFile[]): CollectedFile[];
  /** Writes the folders, re-cloning first where it can; asks nothing. */
  restore(onConflict: ConflictResolver): Promise<RestoreReport>;
}

/**
 * `entries` split on `:` with a Windows drive letter joined back to its path (T104): a value
 * saved on macOS or Linux reaches a Windows PC with its home paths already written as
 * `C:/Users/…`, so `C` and `/Users/…` are one folder. A one-letter entry is never a full path,
 * so Claude Code would skip it anyway.
 */
const keepDriveLetters = (entries: readonly string[]): string[] =>
  entries.reduce<string[]>((joined, entry) => {
    const last = joined.at(-1);
    if (last !== undefined && /^[A-Za-z]$/.test(last) && /^[\\/]/.test(entry)) {
      joined[joined.length - 1] = `${last}:${entry}`;
    } else joined.push(entry);
    return joined;
  }, []);

/** How Claude Code names a folder it loads this way: its manifest's name, `@inline`. */
function inlineId(files: readonly CollectedFile[], name: string): string {
  const manifest = files.find((file) => file.path === PLUGIN_MANIFEST);
  const named = manifest
    ? valueOrNull(parseJsonWith(z.looseObject({ name: z.string() }), manifest.content))?.name
    : undefined;
  return `${printableLine(named ?? name)}@inline`;
}

/**
 * The mods among the saved plugin folders in `files` (T104): those with `hooks/hooks.json`, by
 * the id Claude Code gives them, e.g. `pd-mod@inline`. For pull's notice when this PC's Claude
 * Code is too old to load mods (T103); a saved file it cannot read is left to `planPluginDirs`.
 */
export function savedPluginDirMods(files: readonly CollectedFile[]): string[] {
  return files
    .filter((file) => file.path.startsWith(PLUGIN_DIRS_PREFIX))
    .flatMap((file) => {
      const saved = valueOrNull(readSavedPluginDir(file.content));
      if (saved === null) return [];
      const inside = savedFolderFiles(saved);
      return inside.some((entry) => entry.path === PLUGIN_HOOKS)
        ? [inlineId(inside, saved.name)]
        : [];
    });
}

/** `settings` with the value rewritten by `replace`; as it is when nothing changes. */
function rewriteSettings(
  settings: CollectedFile,
  replace: (value: string) => string,
): CollectedFile {
  const parsed = valueOrNull(parseJsonWith(JsonObjectSchema, settings.content));
  const env = parsed?.['env'];
  const value = pluginDirsValue(settings.content);
  if (parsed === null || value === null || env === null || typeof env !== 'object') {
    return settings;
  }
  const rewritten = replace(value);
  if (rewritten === value) return settings;
  return {
    ...settings,
    content: jsonFile(USER_SETTINGS, {
      ...parsed,
      env: { ...env, [PLUGIN_DIRS_VARIABLE]: rewritten },
    }).content,
  };
}

/**
 * Pull's questions about saved plugin folders (T99), before anything is written: the review of
 * each one that would be added or changed (T97), then each file that is here and differs
 * (T34). Each folder goes to the same path from home, or `~/.agentnomad/plugin-dirs/<name>`
 * when it was outside home or would land in a refused place (`homeFolderFor`).
 */
export async function planPluginDirs(
  context: LocalMarketplaceContext,
  deps: PluginDirRestoreDeps,
): Promise<PluginDirPlan> {
  const path = pathsOf(deps.platform);
  const toWrite: (FolderToWrite & { readonly saved: SavedPluginDir })[] = [];
  const used = new Set<string>();
  for (const entry of context.files.filter((file) => file.path.startsWith(PLUGIN_DIRS_PREFIX))) {
    const read = readSavedPluginDir(entry.content);
    if (!('value' in read)) {
      context.reporter.warn(
        `The saved plugin folder ${printableLine(entry.path)} could not be read: ${read.problem}`,
      );
      continue;
    }
    const saved = read.value;
    const fallbackOf = (name: string) =>
      path.join(deps.homedir, '.agentnomad', 'plugin-dirs', name);
    let fallback = fallbackOf(saved.name);
    for (let n = 2; used.has(fallback); n += 1) fallback = fallbackOf(`${saved.name}-${String(n)}`);
    const dir = homeFolderFor(saved.path, fallback, deps);
    if (used.has(dir)) continue;
    used.add(dir);
    const key = entry.path.slice(0, -'.json'.length);
    toWrite.push({
      saved,
      what: `plugin folder ${printableLine(saved.entry)}`,
      dir,
      files: savedFolderFiles(saved),
      clone: (await exists(dir)) ? null : saved.git,
      keyOf: (file) => `${key}/${file}`,
    });
  }

  // The review of each folder that would be added or changed (T97).
  const toReview: { folder: PluginFolderToReview; change: 'new' | 'changed' }[] = [];
  for (const write of toWrite) {
    const folder: PluginFolderToReview = {
      id: inlineId(write.files, write.saved.name),
      folder: printableLine(write.dir),
      files: write.files,
    };
    const change = await pluginFolderChange(write.dir, folder);
    if (change !== null) toReview.push({ folder, change });
  }
  const accepted =
    toReview.length === 0
      ? new Set<string>()
      : await askPluginFolders(toReview, await deps.validator(), context);
  const declined = new Set(
    toReview.map(({ folder }) => folder.folder).filter((folder) => !accepted.has(folder)),
  );
  const kept = toWrite.filter((write) => !declined.has(printableLine(write.dir)));

  const answers = await askFolderConflicts(kept, context, deps.platform);
  const separator = pluginDirsSeparator(deps.platform);
  return {
    declined: declined.size > 0,
    withPluginDirs(files) {
      if (toWrite.length === 0) return [...files];
      const from = toWrite[0]?.saved.separator ?? separator;
      // A folder by its full path; Windows and macOS ignore case. Compared so, an entry still
      // matches when pull kept this PC's own copy of a saved file (`/` and `\` in its path).
      const folderOf = (entry: string) => {
        const full = path.resolve(fromHome(entry, deps.homedir, deps.platform));
        return deps.platform === 'linux' ? full : full.toLowerCase();
      };
      const replace = (value: string) => {
        const entries = keepDriveLetters(splitPluginDirs(value, from));
        const writeOf = (entry: string) =>
          toWrite.find((each) => folderOf(each.saved.entry) === folderOf(entry));
        // Already naming the folders pull writes (pulled onto the same places): as it is.
        const same = entries.every((entry) => {
          const write = writeOf(entry);
          return (
            write === undefined ||
            (!declined.has(printableLine(write.dir)) && folderOf(entry) === folderOf(write.dir))
          );
        });
        if (same && from === separator) return value;
        return entries
          .flatMap((entry) => {
            const write = writeOf(entry);
            if (write === undefined) return [entry];
            return declined.has(printableLine(write.dir)) ? [] : [write.dir];
          })
          .join(separator);
      };
      return files.map((file) =>
        file.path === USER_SETTINGS ? rewriteSettings(file, replace) : file,
      );
    },
    restore: (onConflict) => writeFolders(kept, answers, onConflict, deps),
  };
}
