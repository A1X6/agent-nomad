/*
 * Plugins and mods in `~/.claude/skills/` (T97). The folder is copied whole (T25); a folder
 * there with `.claude-plugin/plugin.json` is a plugin that Claude Code loads as
 * `<name>@skills-dir`, and with `hooks/hooks.json` it runs code inside Claude Code (a mod's
 * modules, or classic command hooks). Pure text rules on bundle paths, for the collector, the
 * restore rules, the push summary and the pull review.
 */
import type { CollectedFile } from '../adapter.ts';
import { compareVersions } from '../notices.ts';
import { foldedName, underFolder } from '../shared/bundle-paths.ts';
import { CLAUDE_CODE_PATHS as DATA } from './claude-code-paths.data.ts';

/** The marketplace Claude Code names for a plugin found in `skills/<name>/`. */
export const SKILLS_DIR_MARKETPLACE = 'skills-dir';

/** A plugin's manifest, from the plugin's folder. */
export const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';

/** The hooks file of a plugin: classic command hooks, or a mod's modules. */
export const PLUGIN_HOOKS = 'hooks/hooks.json';

/** The first Claude Code that loads mods (2.1.287, T103). */
const MODS_SINCE = DATA.plugins.modsSince;

/** Folders inside a plugin that Claude Code writes itself, e.g. `.claude-plugin/types`. */
const GENERATED_IN_PLUGIN: readonly string[] = DATA.plugins.generatedInPlugin;

/** The parts of a plugin Claude Code starts programs from (SEC-02 of review 15). */
export const RUNS_CODE = DATA.plugins.runsCode;

/**
 * Whether two paths in a plugin's folder name one file, compared without case on every OS
 * (SEC-01): Windows and macOS open `Hooks/hooks.json` as `hooks/hooks.json`, and treating a
 * case variant as the file is the safe side on Linux too.
 */
export const samePluginPath = (a: string, b: string): boolean => foldedName(a) === foldedName(b);

/**
 * Whether a path from a plugin's folder is a part Claude Code starts programs from
 * (`hooks/hooks.json`, `.mcp.json`, `.lsp.json`, a file in `monitors/`), in any case (SEC-01).
 */
export function isRunsCodePath(pathInPlugin: string): boolean {
  const path = foldedName(pathInPlugin);
  return (
    RUNS_CODE.files.some((file) => path === foldedName(file)) ||
    RUNS_CODE.folders.some((folder) => path.startsWith(`${foldedName(folder)}/`))
  );
}

/** `skills/<name>/<rest>` → `[name, rest]`, `null` for any other path. */
function splitSkillsPath(path: string): readonly [string, string] | null {
  const match = /^skills\/([^/]+)\/(.+)$/.exec(path);
  return match?.[1] === undefined || match[2] === undefined ? null : [match[1], match[2]];
}

/**
 * Whether a global bundle path is inside a folder Claude Code generates in a skills-folder
 * plugin (`skills/<name>/.claude-plugin/types/...`): never pushed, never written. Compared
 * without case, as Windows and macOS see one folder.
 */
export function isGeneratedInSkillsPlugin(path: string): boolean {
  const rest = splitSkillsPath(path)?.[1];
  return rest !== undefined && isGeneratedInPlugin(rest);
}

/**
 * Whether a path from a plugin's folder (`.claude-plugin/types/x.d.ts`) is inside a folder
 * Claude Code generates there; also for saved claude.ai plugins (T101). Without case.
 */
export function isGeneratedInPlugin(pathInPlugin: string): boolean {
  return GENERATED_IN_PLUGIN.some((folder) =>
    underFolder(pathInPlugin, folder, { ignoreCase: true }),
  );
}

/** One plugin folder in `skills/`, as the bundle or this PC has it. */
export interface SkillsPluginFolder {
  /** The folder's name in `skills/`. */
  readonly name: string;
  /** How Claude Code names it: `<name>@skills-dir`. */
  readonly id: string;
  /** Its bundle path, e.g. `skills/probe-mod`. */
  readonly folder: string;
  /** Its files, with paths from the plugin folder (`.claude-plugin/plugin.json`, …). */
  readonly files: readonly CollectedFile[];
  /** It has `hooks/hooks.json`: it runs code inside Claude Code. */
  readonly mod: boolean;
}

/**
 * The `skills/<name>/` folders among global bundle files (never `skills/synced/`), grouped
 * without case on every OS (SEC-02): Windows and macOS write `Evil/` and `evil/` into one
 * folder, named as the first in path order, which the restorer writes first.
 */
function skillsFolders(files: readonly CollectedFile[]): SkillsPluginFolder[] {
  const byName = new Map<string, { name: string; files: CollectedFile[] }>();
  for (const file of files) {
    const split = splitSkillsPath(file.path);
    if (split === null || foldedName(split[0]) === 'synced') continue;
    const [name, rest] = split;
    const folder = byName.get(foldedName(name)) ?? { name, files: [] };
    if (name < folder.name) folder.name = name;
    folder.files.push({ ...file, path: rest });
    byName.set(foldedName(name), folder);
  }
  return [...byName.values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, files: inside }) => ({
      name,
      id: `${name}@${SKILLS_DIR_MARKETPLACE}`,
      folder: `skills/${name}`,
      files: inside,
      mod: inside.some((file) => samePluginPath(file.path, PLUGIN_HOOKS)),
    }));
}

/** Whether a plugin folder's files hold its manifest, in any case (SEC-01). */
export const hasManifest = (files: readonly CollectedFile[]): boolean =>
  files.some((file) => samePluginPath(file.path, PLUGIN_MANIFEST));

/** The plugin folders among global bundle files: those with `.claude-plugin/plugin.json`. */
export function skillsPluginFolders(files: readonly CollectedFile[]): SkillsPluginFolder[] {
  return skillsFolders(files).filter((folder) => hasManifest(folder.files));
}

/**
 * The folders pull's plugin review looks at (SEC-02): plugin folders, and folders with a part
 * Claude Code starts programs from, which are a plugin when this PC has their manifest.
 */
export function skillsFoldersToReview(files: readonly CollectedFile[]): SkillsPluginFolder[] {
  return skillsFolders(files).filter(
    (folder) => hasManifest(folder.files) || folder.files.some((file) => isRunsCodePath(file.path)),
  );
}

/**
 * What push's summary says about plugins in `skills/` (T97), or `null` when there are none,
 * e.g. `Plugins in skills/: notes@skills-dir, probe-mod@skills-dir (runs code)`.
 */
export function skillsPluginsNote(files: readonly CollectedFile[]): string | null {
  const folders = skillsPluginFolders(files);
  if (folders.length === 0) return null;
  const names = folders.map((folder) => `${folder.id}${folder.mod ? ' (runs code)' : ''}`);
  return `Plugins in skills/: ${names.join(', ')}`;
}

/**
 * What pull says when the setup has mods and this PC's Claude Code is older than the first
 * version that loads them (T103); `null` when the version here is unknown or new enough.
 * `elsewhere`: the ids of the setup's mods outside `skills/`, e.g. in a saved local marketplace
 * or plugin folder (T104).
 */
export function modsVersionNotice(
  files: readonly CollectedFile[],
  here: string | null,
  elsewhere: readonly string[] = [],
): string | null {
  if (here === null || compareVersions(here, MODS_SINCE) >= 0) return null;
  const mods = [
    ...skillsPluginFolders(files)
      .filter((folder) => folder.mod)
      .map((folder) => folder.id),
    ...elsewhere,
  ];
  if (mods.length === 0) return null;
  const names = mods.join(', ');
  return `This setup has mods (${names}), which need Claude Code ${MODS_SINCE} or newer, but this PC has ${here}. Update Claude Code so they load.`;
}
