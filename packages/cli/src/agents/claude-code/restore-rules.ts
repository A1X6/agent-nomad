/**
 * What the Claude Code restorer may write (T27): only paths a collector could have
 * produced (T25, T26). Anything else in a bundle, e.g. `.credentials.json`,
 * `skills/synced/...` or a path outside the target, is refused, so a damaged or tampered
 * bundle cannot write where it should not.
 */
import { BundlePathSchema } from '@agentnomad/contracts';

import { ENV_BUNDLE_PATH } from '../../env/env-section.ts';
import { RESERVED_DIR } from '../adapter.ts';
import { underFolder } from '../shared/bundle-paths.ts';
import {
  ACCOUNT_PLUGINS_PREFIX,
  ACCOUNT_SKILLS_PREFIX,
  CLAUDE_JSON_BUNDLE_PATH,
  GLOBAL_FILES,
  GLOBAL_FOLDERS,
  GLOBAL_MEMORY_FOLDERS,
  GLOBAL_REFUSED,
  HOME_SCRIPTS_PREFIX,
  LOCAL_MARKETPLACES_PREFIX,
  PLUGIN_DATA_PREFIX,
  PLUGIN_STORE_PREFIX,
  PLUGIN_VERSIONS_BUNDLE_PATH,
  PLUGINS_BUNDLE_PATH,
  PROGRAMS_BUNDLE_PATH,
  homePathProblem,
  extensionOf,
  isScript,
  TOOL_SETTINGS_BUNDLE_PATHS,
} from './global-paths.ts';
import {
  AUTO_MEMORY_BUNDLE_PREFIX,
  PROJECT_CLAUDE_FILES,
  PROJECT_CLAUDE_FOLDERS,
  PROJECT_MEMORY_FOLDERS,
  PROJECT_NEVER_SYNCED,
  PROJECT_ROOT_FILES,
} from './project-paths.ts';
import { isGeneratedInSkillsPlugin } from './skills-dir-plugins.ts';

/** Where a bundle entry belongs, or why it is refused. */
export type RestoreDestination =
  /** A path inside the target folder (base folder or project). */
  | { readonly kind: 'target'; readonly path: string }
  /** A path inside the home folder (`.agentnomad/home/...`). */
  | { readonly kind: 'home'; readonly path: string }
  /** The selected `~/.claude.json` keys, merged into that file. */
  | { readonly kind: 'claude-json' }
  /** A file in the project's auto memory folder. */
  | { readonly kind: 'auto-memory'; readonly path: string }
  /** Read by pull, never written (`programs.json`). */
  | { readonly kind: 'metadata' }
  | { readonly kind: 'refused'; readonly reason: string };

/** For refusals: Windows and macOS ignore case, so `Plugins/…` is `plugins/…` there (T43). */
const underAnyCase = (path: string, folder: string) =>
  underFolder(path, folder, { ignoreCase: true });

const refused = (reason: string): RestoreDestination => ({ kind: 'refused', reason });

/** Reserved files of a project bundle that pull reads and never writes. */
const PROJECT_METADATA: ReadonlySet<string> = new Set([
  PLUGINS_BUNDLE_PATH,
  PLUGIN_VERSIONS_BUNDLE_PATH,
  ENV_BUNDLE_PATH,
]);
/** The same for a global bundle, which also saves the programs its hooks need. */
const GLOBAL_METADATA: ReadonlySet<string> = new Set([...PROJECT_METADATA, PROGRAMS_BUNDLE_PATH]);

/** A saved local marketplace (T98): pull writes its files to a folder of its own choosing. */
const isLocalMarketplace = (path: string) =>
  path.startsWith(LOCAL_MARKETPLACES_PREFIX) &&
  !path.slice(LOCAL_MARKETPLACES_PREFIX.length).includes('/');

/** What a global entry may be written under, built once: the synced folders. */
const GLOBAL_FOLDER_PREFIXES: readonly string[] = [...GLOBAL_FOLDERS, ...GLOBAL_MEMORY_FOLDERS].map(
  (folder) => `${folder}/`,
);

/** What a project entry may be written as or under in `.claude/`, built once. */
const PROJECT_CLAUDE_PATHS: readonly string[] = PROJECT_CLAUDE_FILES.map(
  (name) => `.claude/${name}`,
);
const PROJECT_FOLDER_PREFIXES: readonly string[] = [
  ...PROJECT_CLAUDE_FOLDERS,
  ...PROJECT_MEMORY_FOLDERS,
].map((folder) => `.claude/${folder}/`);

/**
 * Home files a bundle may restore: known tool settings, or scripts that the setup's own hooks
 * or status line run (`allowedScripts`, T38). Any other file could be one that runs by itself
 * (a Startup folder, a shell or PowerShell profile) without ever being shown for review; those
 * places are refused even when a hook names them (T43).
 */
function homeDestination(
  relative: string,
  allowedScripts: ReadonlySet<string>,
): RestoreDestination {
  const problem = homePathProblem(relative);
  if (problem !== null) return refused(problem);
  const bundlePath = HOME_SCRIPTS_PREFIX + relative;
  if (TOOL_SETTINGS_BUNDLE_PATHS.has(bundlePath) || allowedScripts.has(bundlePath)) {
    return { kind: 'home', path: relative };
  }
  return refused('no hook or status line in this setup runs it');
}

/**
 * Where a global bundle entry goes. `allowedScripts`: bundle paths of the scripts the setup's
 * own hooks and status line run (from its `settings.json`). As in the home folder, a script
 * outside the synced folders is restored only when one of those runs it, and never in Claude
 * Code's own state (T55), so a bundle cannot replace a launcher such as
 * `chrome/chrome-native-host.bat` without it being shown for review.
 */
export function globalDestination(
  path: string,
  allowedScripts: ReadonlySet<string>,
): RestoreDestination {
  if (!BundlePathSchema.safeParse(path).success) return refused('not a safe path');
  if (path === CLAUDE_JSON_BUNDLE_PATH) return { kind: 'claude-json' };
  if (GLOBAL_METADATA.has(path) || isLocalMarketplace(path)) return { kind: 'metadata' };
  // Saved claude.ai skills (T42): written only by pull's follow-up, after asking.
  if (path.startsWith(ACCOUNT_SKILLS_PREFIX)) return { kind: 'metadata' };
  // Saved claude.ai plugins (T101): pull's plan step offers them as `skills/<name>/`.
  if (path.startsWith(ACCOUNT_PLUGINS_PREFIX)) return { kind: 'metadata' };
  // Saved plugin data (T102): pull's follow-up writes it for plugins installed here.
  if (path.startsWith(PLUGIN_DATA_PREFIX) || path.startsWith(PLUGIN_STORE_PREFIX)) {
    return { kind: 'metadata' };
  }
  if (path.startsWith(HOME_SCRIPTS_PREFIX)) {
    return homeDestination(path.slice(HOME_SCRIPTS_PREFIX.length), allowedScripts);
  }
  if (underAnyCase(path, RESERVED_DIR)) return refused('unknown agentnomad entry');
  if (GLOBAL_REFUSED.some((entry) => underAnyCase(path, entry))) return refused('never synced');
  // Claude Code writes it when it reloads a mod (T97), so push never takes it.
  if (isGeneratedInSkillsPlugin(path)) return refused('Claude Code generates it');

  const allowed =
    GLOBAL_FILES.includes(path) || GLOBAL_FOLDER_PREFIXES.some((prefix) => path.startsWith(prefix));
  if (allowed) return { kind: 'target', path };
  if (isScript(path)) {
    return allowedScripts.has(path)
      ? { kind: 'target', path }
      : refused('no hook or status line in this setup runs it');
  }
  return refused('not part of a Claude Code setup');
}

/**
 * Where a project bundle entry goes. A script outside `.claude/` is only restored when the
 * bundle's own hooks run it (`allowedScripts`, from `projectHookScripts`), so a bundle
 * cannot drop code anywhere in the project.
 */
export function projectDestination(
  path: string,
  allowedScripts: ReadonlySet<string> = new Set(),
): RestoreDestination {
  if (!BundlePathSchema.safeParse(path).success) return refused('not a safe path');
  if (PROJECT_METADATA.has(path) || isLocalMarketplace(path)) return { kind: 'metadata' };
  if (path.startsWith(`${AUTO_MEMORY_BUNDLE_PREFIX}/`)) {
    // Auto memory is Markdown notes (T43): nothing else, so no script or startup file.
    if (extensionOf(path) !== '.md') return refused('auto memory holds only Markdown files');
    return { kind: 'auto-memory', path: path.slice(AUTO_MEMORY_BUNDLE_PREFIX.length + 1) };
  }
  if (underAnyCase(path, RESERVED_DIR)) return refused('unknown agentnomad entry');
  if (PROJECT_NEVER_SYNCED.some((entry) => underAnyCase(path, entry))) {
    return refused('never synced');
  }

  const allowed =
    PROJECT_ROOT_FILES.includes(path) ||
    PROJECT_CLAUDE_PATHS.includes(path) ||
    PROJECT_FOLDER_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    (isScript(path) && (path.startsWith('.claude/') || allowedScripts.has(path)));
  return allowed ? { kind: 'target', path } : refused('not part of a Claude Code setup');
}

/**
 * Whether pull reads `path` and never writes it as a file, in a global or a project setup:
 * `plugins.json`, `programs.json`, a saved local marketplace (T98) and the like.
 */
export const isPullMetadata = (path: string): boolean =>
  globalDestination(path, new Set()).kind === 'metadata' ||
  projectDestination(path).kind === 'metadata';
