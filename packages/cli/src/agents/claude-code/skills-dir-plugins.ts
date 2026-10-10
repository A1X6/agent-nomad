/*
 * Plugins and mods in `~/.claude/skills/` (T97). The folder is copied whole (T25); a folder
 * there with `.claude-plugin/plugin.json` is a plugin that Claude Code loads as
 * `<name>@skills-dir`, and with `hooks/hooks.json` it runs code inside Claude Code (a mod's
 * modules, or classic command hooks). Pure text rules on bundle paths, for the collector, the
 * restore rules, the push summary and the pull review.
 */
import type { CollectedFile } from '../adapter.ts';
import { compareVersions } from '../notices.ts';
import { CLAUDE_CODE_PATHS as DATA } from './claude-code-paths.data.ts';

/** The marketplace Claude Code names for a plugin found in `skills/<name>/`. */
export const SKILLS_DIR_MARKETPLACE = 'skills-dir';

/** A plugin's manifest, from the plugin's folder. */
const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';

/** The hooks file of a plugin: classic command hooks, or a mod's modules. */
export const PLUGIN_HOOKS = 'hooks/hooks.json';

/** The first Claude Code that loads mods (2.1.287, T103). */
const MODS_SINCE = DATA.plugins.modsSince;

/** Folders inside a plugin that Claude Code writes itself, e.g. `.claude-plugin/types`. */
const GENERATED_IN_PLUGIN: readonly string[] = DATA.plugins.generatedInPlugin;

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
  const rest = splitSkillsPath(path)?.[1].toLowerCase();
  if (rest === undefined) return false;
  return GENERATED_IN_PLUGIN.some((folder) => {
    const lower = folder.toLowerCase();
    return rest === lower || rest.startsWith(`${lower}/`);
  });
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

/** The plugin folders among global bundle files: those with `.claude-plugin/plugin.json`. */
export function skillsPluginFolders(files: readonly CollectedFile[]): SkillsPluginFolder[] {
  const byName = new Map<string, CollectedFile[]>();
  for (const file of files) {
    const split = splitSkillsPath(file.path);
    if (split === null || split[0] === 'synced') continue;
    const [name, rest] = split;
    const list = byName.get(name) ?? [];
    list.push({ ...file, path: rest });
    byName.set(name, list);
  }
  return [...byName]
    .filter(([, inside]) => inside.some((file) => file.path === PLUGIN_MANIFEST))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, inside]) => ({
      name,
      id: `${name}@${SKILLS_DIR_MARKETPLACE}`,
      folder: `skills/${name}`,
      files: inside,
      mod: inside.some((file) => file.path === PLUGIN_HOOKS),
    }));
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
 */
export function modsVersionNotice(
  files: readonly CollectedFile[],
  here: string | null,
): string | null {
  if (here === null || compareVersions(here, MODS_SINCE) >= 0) return null;
  const mods = skillsPluginFolders(files).filter((folder) => folder.mod);
  if (mods.length === 0) return null;
  const names = mods.map((folder) => folder.id).join(', ');
  return `This setup has mods (${names}), which need Claude Code ${MODS_SINCE} or newer, but this PC has ${here}. Update Claude Code so they load.`;
}
