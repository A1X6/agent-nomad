import { readdir, stat } from 'node:fs/promises';
import type { PlatformPath } from 'node:path';

import type { CollectedFile, RestorePlanContext } from '../adapter.ts';
import type { FileGatherer } from '../shared/file-gathering.ts';
import { isUsableSkillName, readSyncedSkills } from './account-skills.ts';
import { ACCOUNT_PLUGINS_PREFIX } from './global-paths.ts';
import {
  isGeneratedInPlugin,
  PLUGIN_MANIFEST,
  SKILLS_DIR_MARKETPLACE,
} from './skills-dir-plugins.ts';
import {
  NOT_OWN_SCOPES,
  readSyncedPluginsOf,
  SYNCED_PLUGINS_DIR,
  type SyncedPlugin,
} from './synced-plugins.ts';

/**
 * Plugins from the user's claude.ai account (T101), the same rules as its skills (T42).
 * Claude Code downloads them into `~/.claude/plugins/synced/<account>/<name>/` and manages
 * that folder itself; agentnomad never writes there. On request, push saves the plugin folders
 * of the user's **own** uploads (marketplace scope `account`, My Uploads) under a reserved
 * bundle folder; never claude.ai's directory, an organization's, nor one claude.ai installs by
 * itself. Pull can add them back as plugins in `~/.claude/skills/<name>/`, which Claude Code
 * loads as `<name>@skills-dir`, on a PC that does not get them from its own claude.ai sync.
 * "The plugin's files" are the folder named after the plugin next to the manifest, taken
 * whole minus the skipped names and what Claude Code generates in it (`.claude-plugin/types/`).
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

const isFile = async (path: string) => (await stat(path).catch(() => null))?.isFile() ?? false;

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
        leftOut.push(`${name} (its name cannot be a folder in ~/.claude/skills)`);
        continue;
      }
      if (own.has(name)) continue;
      const dir = path.join(accountDir, name);
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

/**
 * The user's own synced plugins as bundle files, under `.agentnomad/account-plugins/<name>/`,
 * without what Claude Code generates in a plugin (T97).
 */
export async function collectAccountPlugins(
  files: FileGatherer,
  plugins: SyncedAccountPlugins,
): Promise<CollectedFile[]> {
  const found: CollectedFile[] = [];
  for (const plugin of plugins.own) {
    const prefix = `${ACCOUNT_PLUGINS_PREFIX}${plugin.name}`;
    const generated = (bundlePath: string) =>
      bundlePath.startsWith(`${prefix}/`) &&
      isGeneratedInPlugin(bundlePath.slice(prefix.length + 1));
    found.push(...(await files.walk(plugin.dir, prefix, generated)));
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

/** Names on this PC a saved plugin must not take, lower case. */
export interface NamesHere {
  /** Plugins and skills this PC already gets from its own claude.ai sync. */
  readonly syncedNames: ReadonlySet<string>;
  /** Folders in `~/.claude/skills/` (local skills and plugins), with those the pull writes. */
  readonly localNames: ReadonlySet<string>;
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
  const byName = new Map<string, CollectedFile[]>();
  for (const file of bundleFiles) {
    if (!file.path.startsWith(ACCOUNT_PLUGINS_PREFIX)) continue;
    const rest = file.path.slice(ACCOUNT_PLUGINS_PREFIX.length);
    const name = rest.split('/')[0] ?? '';
    if (!isUsableSkillName(name) || rest === name) continue;
    if (isGeneratedInPlugin(rest.slice(name.length + 1))) continue;
    const pluginFiles = byName.get(name);
    if (pluginFiles === undefined) byName.set(name, [file]);
    else pluginFiles.push(file);
  }
  const toAdd: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const files: CollectedFile[] = [];
  for (const [name, pluginFiles] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (here.syncedNames.has(name.toLowerCase())) {
      skipped.push({ name, reason: 'this PC already gets it from claude.ai' });
      continue;
    }
    if (here.localNames.has(name.toLowerCase())) {
      skipped.push({ name, reason: 'you already have a local skill or plugin with this name' });
      continue;
    }
    const manifest = `${ACCOUNT_PLUGINS_PREFIX}${name}/${PLUGIN_MANIFEST}`;
    if (!pluginFiles.some((file) => file.path === manifest)) {
      skipped.push({ name, reason: `it has no ${PLUGIN_MANIFEST}` });
      continue;
    }
    toAdd.push(name);
    for (const file of pluginFiles) {
      files.push({ ...file, path: `skills/${file.path.slice(ACCOUNT_PLUGINS_PREFIX.length)}` });
    }
  }
  return { toAdd, skipped, files };
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

/** What the plan step of pull gives the question about saved plugins (T61). */
export type AccountPluginsContext = Pick<
  RestorePlanContext,
  'files' | 'prompter' | 'reporter' | 'assumeYes' | 'parts'
>;

/**
 * Saved claude.ai plugins (T101): listed, and offered as plugins in `skills/<name>/` only
 * after a yes or `--account-plugins` (`--yes` alone never adds them). Returns the files to
 * add, as `skills/<name>/...`; the plugin review (T97) then checks them like any plugin folder.
 */
export async function askAccountPlugins(
  context: AccountPluginsContext,
  here: NamesHere,
): Promise<readonly CollectedFile[]> {
  const plan = planAccountPlugins(context.files, here);
  if (plan.toAdd.length === 0 && plan.skipped.length === 0) return [];
  context.reporter.info(
    [
      'Plugins from your claude.ai account on the other PC:',
      ...plan.toAdd.map((name) => `  + ${name}@${SKILLS_DIR_MARKETPLACE} (skills/${name})`),
      ...plan.skipped.map((plugin) => `  - ${plugin.name}: skipped, ${plugin.reason}`),
    ].join('\n'),
  );
  if (plan.toAdd.length === 0) return [];
  const add =
    context.parts.get(ACCOUNT_PLUGINS_PART) ??
    (!context.assumeYes &&
      (await context.prompter.confirm(
        'Add them as local plugins in ~/.claude/skills/? Only needed if this PC uses another claude.ai account, or none.',
        false,
      )));
  if (!add) {
    context.reporter.info(
      'Not added. To add them later: agentnomad pull --global --account-plugins',
    );
    return [];
  }
  return plan.files;
}
