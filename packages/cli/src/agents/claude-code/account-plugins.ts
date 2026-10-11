import { readdir } from 'node:fs/promises';
import type { PlatformPath } from 'node:path';

import * as z from 'zod';

import { isFile } from '../../system/files.ts';
import { parseJsonWith } from '../../system/json.ts';
import type { CollectedFile } from '../adapter.ts';
import { jsonFile, type FileGatherer } from '../shared/file-gathering.ts';
import {
  askSavedCopies,
  filesInSkills,
  NAME_NOT_A_FOLDER,
  planSavedCopies,
  savedCopiesIn,
  sortedCopies,
  type NamesHere,
  type SavedCopiesContext,
  type SavedCopiesPlan,
  type SavedCopy,
} from './account-copies.ts';
import { isUsableSkillName, readSyncedSkills } from './account-skills.ts';
import { ACCOUNT_PLUGINS_PREFIX } from './global-paths.ts';
import { SAVED_FOLDER_SHAPE, savedFilesOf, savedFolderFiles } from './local-marketplaces.ts';
import {
  isGeneratedInPlugin,
  PLUGIN_MANIFEST,
  SKILLS_DIR_MARKETPLACE,
} from './skills-dir-plugins.ts';
import {
  NOT_OWN_SCOPES,
  readSyncedPluginsOf,
  SYNCED_PLUGINS_DIR,
  syncedPluginFolder,
  type SyncedPlugin,
} from './synced-plugins.ts';

/**
 * Plugins from the user's claude.ai account (T101), the same rules as its skills (T42).
 * Claude Code downloads them into `~/.claude/plugins/synced/<account>/<folder>/` and manages
 * that folder itself; agentnomad never writes there. On request, push saves the plugin folders
 * of the user's **own** uploads (marketplace scope `account`, My Uploads) under a reserved
 * bundle folder; never claude.ai's directory, an organization's, nor one claude.ai installs by
 * itself. Pull can add them back as plugins in `~/.claude/skills/<name>/`, which Claude Code
 * loads as `<name>@skills-dir`, on a PC that does not get them from its own claude.ai sync.
 * "The plugin's files" are its folder next to the manifest (`<name>`, or `<name>~g<N>` from its
 * generation 2, {@link syncedPluginFolder}), taken whole minus the skipped names and what
 * Claude Code generates in it (`.claude-plugin/types/`). The bundle keeps the plain `<name>`.
 */

/** The id of the optional part for saved claude.ai plugins (T101); also the flag name. */
export const ACCOUNT_PLUGINS_PART = 'account-plugins';

/** `installationPreference` values for plugins claude.ai installs by itself, never saved. */
const INSTALLED_BY_CLAUDE_AI = new Set(['required', 'auto_install']);

/** Why a synced plugin is not the user's own, or `null` when it is. When in doubt, left out. */
function leftOutReason(plugin: SyncedPlugin): string | null {
  if (plugin.scope !== undefined && NOT_OWN_SCOPES.has(plugin.scope)) {
    return 'it comes from your organization or claude.ai, not from you';
  }
  if (plugin.scope !== 'account') {
    return 'agentnomad cannot tell which claude.ai marketplace it comes from';
  }
  const preference = plugin.installationPreference;
  if (preference !== undefined && INSTALLED_BY_CLAUDE_AI.has(preference)) {
    return 'claude.ai installs it by itself on every PC signed in to the account';
  }
  return null;
}

export interface SyncedAccountPlugins {
  /** The user's own plugins, with their folder on this PC. */
  readonly own: readonly { readonly name: string; readonly dir: string }[];
  /** Every synced plugin name on this PC (any marketplace), lower case, to avoid a duplicate. */
  readonly allNames: ReadonlySet<string>;
  /** Why an account's plugins could not be read, one sentence per account; `null` when fine. */
  readonly problem: string | null;
  /** What push says before saving them: plugins left out with why; `null` when nothing. */
  readonly notice: string | null;
}

/** Whether an account folder holds any folder of a plugin (not Claude Code's dot files). */
const hasPluginFolder = async (accountDir: string) =>
  (await readdir(accountDir, { withFileTypes: true }).catch(() => [])).some(
    (entry) => entry.isDirectory() && !entry.name.startsWith('.'),
  );

/** What `~/.claude/plugins/synced/` holds on this PC. Never throws; unreadable parts are said. */
export async function readSyncedPlugins(
  path: PlatformPath,
  baseDir: string,
): Promise<SyncedAccountPlugins> {
  const root = path.join(baseDir, ...SYNCED_PLUGINS_DIR.split('/'));
  const own = new Map<string, string>();
  const allNames = new Set<string>();
  const problems: string[] = [];
  const notices: string[] = [];
  const accounts = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const account of accounts) {
    if (!account.isDirectory() || account.name.startsWith('.')) continue;
    const accountDir = path.join(root, account.name);
    const where = `${SYNCED_PLUGINS_DIR}/${account.name}`;
    const plugins = await readSyncedPluginsOf(path, accountDir);
    if (plugins === 'unreadable') {
      problems.push(
        `Claude Code's list of synced plugins (${where}/manifest.json and .marketplaces.json) is missing or in a format agentnomad does not know.`,
      );
      continue;
    }
    if (plugins === 'no list') {
      if (await hasPluginFolder(accountDir)) {
        notices.push(
          `Claude Code keeps no list of claude.ai marketplaces for account ${account.name} (${where}/.marketplaces.json), so your own plugins cannot be told apart from your organization's or claude.ai's: none were saved.`,
        );
      }
      continue;
    }
    const leftOut: string[] = [];
    for (const plugin of plugins) {
      const { name } = plugin;
      if (name === undefined) continue;
      allNames.add(name.toLowerCase());
      const reason = leftOutReason(plugin);
      if (reason !== null) {
        leftOut.push(`${name} (${reason})`);
        continue;
      }
      if (!isUsableSkillName(name)) {
        leftOut.push(`${name} (${NAME_NOT_A_FOLDER})`);
        continue;
      }
      if (own.has(name)) continue;
      const dir = path.join(
        accountDir,
        syncedPluginFolder({ name, generation: plugin.generation }),
      );
      if (!(await isFile(path.join(dir, ...PLUGIN_MANIFEST.split('/'))))) {
        leftOut.push(`${name} (its folder here has no ${PLUGIN_MANIFEST})`);
        continue;
      }
      own.set(name, dir);
    }
    if (leftOut.length > 0) {
      notices.push(
        `Plugins not saved from claude.ai account ${account.name}: ${leftOut.join(', ')}.`,
      );
    }
  }
  return {
    own: [...own.entries()]
      .map(([name, dir]) => ({ name, dir }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    allNames,
    problem: problems.length === 0 ? null : problems.join(' '),
    notice: notices.length === 0 ? null : notices.join(' '),
  };
}

/** A saved claude.ai plugin, `.agentnomad/account-plugins/<name>.json` (UX-02). */
const SavedPluginSchema = z.strictObject({ name: z.string(), files: SAVED_FOLDER_SHAPE.files });

/** The bundle path of a saved claude.ai plugin: one file each, as for local marketplaces. */
const bundlePathOf = (name: string) => `${ACCOUNT_PLUGINS_PREFIX}${name}.json`;

/**
 * The user's own synced plugins as bundle files, one `.agentnomad/account-plugins/<name>.json`
 * each, without what Claude Code generates in a plugin (T97). One file per plugin, so an older
 * CLI, which refuses an unknown reserved entry with a warning, warns once per plugin (UX-02).
 */
export async function collectAccountPlugins(
  files: FileGatherer,
  plugins: SyncedAccountPlugins,
): Promise<CollectedFile[]> {
  const found: CollectedFile[] = [];
  for (const plugin of plugins.own) {
    const prefix = `${plugin.name}/`;
    const generated = (path: string) =>
      path.startsWith(prefix) && isGeneratedInPlugin(path.slice(prefix.length));
    const inside = (await files.walk(plugin.dir, plugin.name, generated)).map((file) => ({
      ...file,
      path: file.path.slice(prefix.length),
    }));
    found.push(
      jsonFile(bundlePathOf(plugin.name), { name: plugin.name, files: savedFilesOf(inside) }),
    );
  }
  return found;
}

export interface AccountPluginPlan {
  /** Plugins that can be added here, by folder name. */
  readonly toAdd: readonly string[];
  /** Plugins left out, with why. */
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
  /** The files to write, as global bundle paths (`skills/<name>/...`). */
  readonly files: readonly CollectedFile[];
}

/**
 * The saved plugins in `bundleFiles`: one `<name>.json` each (UX-02), or a folder of files as
 * bundles saved before that keep them; a file that cannot be read is skipped with why.
 */
function savedPlugins(bundleFiles: readonly CollectedFile[]) {
  const copies = new Map<string, SavedCopy>();
  const unreadable: { name: string; reason: string }[] = [];
  for (const file of bundleFiles) {
    const name = file.path.slice(ACCOUNT_PLUGINS_PREFIX.length, -'.json'.length);
    if (file.path !== bundlePathOf(name) || name.includes('/') || !isUsableSkillName(name)) {
      continue;
    }
    const read = parseJsonWith(SavedPluginSchema, file.content);
    if (!('value' in read) || read.value.name !== name) {
      const problem = 'value' in read ? 'it holds another plugin' : read.problem;
      unreadable.push({ name, reason: `its saved copy could not be read (${problem})` });
      continue;
    }
    const files = savedFolderFiles(read.value).filter((entry) => !isGeneratedInPlugin(entry.path));
    copies.set(name, { name, files });
  }
  const inFolders = savedCopiesIn(
    ACCOUNT_PLUGINS_PREFIX,
    bundleFiles,
    isUsableSkillName,
    isGeneratedInPlugin,
  ).filter((copy) => !copies.has(copy.name));
  return { copies: sortedCopies([...copies.values(), ...inFolders]), unreadable };
}

/** The saved plugins pull may add here, as {@link planAccountPlugins} says. */
function planPlugins(bundleFiles: readonly CollectedFile[], here: NamesHere): SavedCopiesPlan {
  const { copies, unreadable } = savedPlugins(bundleFiles);
  const plan = planSavedCopies(
    copies,
    here,
    'you already have a local skill or plugin with this name',
    (copy) =>
      copy.files.some((file) => file.path === PLUGIN_MANIFEST)
        ? null
        : `it has no ${PLUGIN_MANIFEST}`,
  );
  return { toAdd: plan.toAdd, skipped: [...plan.skipped, ...unreadable] };
}

/**
 * Which saved account plugins pull may add on this PC as plugins in `skills/<name>/`: not one
 * this PC already gets from its own claude.ai sync, and never over a local skill or plugin of
 * the same name.
 */
export function planAccountPlugins(
  bundleFiles: readonly CollectedFile[],
  here: NamesHere,
): AccountPluginPlan {
  const plan = planPlugins(bundleFiles, here);
  return {
    toAdd: plan.toAdd.map((copy) => copy.name),
    skipped: plan.skipped,
    files: filesInSkills(plan.toAdd),
  };
}

/**
 * The folders in `~/.claude/skills/` (base folder `baseDir`) and those a pull is about to
 * write there (`incoming`, bundle files), lower case: names a saved claude.ai skill or plugin
 * must not take.
 */
export async function localSkillNames(
  path: PlatformPath,
  baseDir: string,
  incoming: readonly CollectedFile[],
): Promise<ReadonlySet<string>> {
  const here = (
    await readdir(path.join(baseDir, 'skills'), { withFileTypes: true }).catch(() => [])
  )
    .filter((entry) => entry.isDirectory() && entry.name !== 'synced')
    .map((entry) => entry.name);
  const writing = incoming.flatMap((file) => {
    const [folder, name, rest] = file.path.split('/');
    return folder === 'skills' && name !== undefined && name !== 'synced' && rest !== undefined
      ? [name]
      : [];
  });
  return new Set([...here, ...writing].map((name) => name.toLowerCase()));
}

/**
 * The names a saved plugin must not take on this PC: what its own claude.ai sync brings
 * (plugins and skills), and the folders in `skills/` with those the pull is about to write.
 */
export async function namesHere(
  path: PlatformPath,
  baseDir: string,
  incoming: readonly CollectedFile[],
): Promise<NamesHere> {
  const plugins = await readSyncedPlugins(path, baseDir);
  const skills = await readSyncedSkills(path, baseDir);
  return {
    syncedNames: new Set([...plugins.allNames, ...skills.allNames]),
    localNames: await localSkillNames(path, baseDir, incoming),
  };
}

/**
 * Saved claude.ai plugins (T101): listed, and added as plugins in `skills/<name>/` unless the
 * user says no or `--no-account-plugins` (`--yes` adds them, T114). Returns the files to add,
 * as `skills/<name>/...`; the plugin review (T97) then checks them like any plugin folder.
 */
export async function askAccountPlugins(
  context: SavedCopiesContext,
  here: NamesHere,
): Promise<readonly CollectedFile[]> {
  const plan = planPlugins(context.files, here);
  const { add } = await askSavedCopies(context, plan, {
    heading: 'Plugins from your claude.ai account on the other PC:',
    line: (copy) => `${copy.name}@${SKILLS_DIR_MARKETPLACE} (skills/${copy.name})`,
    question:
      'Add them as local plugins in ~/.claude/skills/? Only needed if this PC uses another claude.ai account, or none. Added unless you say no.',
    part: ACCOUNT_PLUGINS_PART,
  });
  return add ? filesInSkills(plan.toAdd) : [];
}
