/**
 * What the Claude Code restorer may write (T27): only paths a collector could have
 * produced (T25, T26). Anything else in a bundle, e.g. `.credentials.json`,
 * `skills/synced/...` or a path outside the target, is refused, so a damaged or tampered
 * bundle cannot write where it should not.
 */
import { BundlePathSchema } from '@agentnomad/contracts';
import { windowsNameProblem } from '@agentnomad/core';

import { ENV_BUNDLE_PATH } from '../../env/env-section.ts';

import {
  CLAUDE_JSON_BUNDLE_PATH,
  GLOBAL_FILES,
  GLOBAL_FOLDERS,
  GLOBAL_MEMORY_FOLDERS,
  GLOBAL_REFUSED,
  HOME_SCRIPTS_PREFIX,
  PLUGINS_BUNDLE_PATH,
  PROGRAMS_BUNDLE_PATH,
  RESERVED_DIR,
  homePathProblem,
  extensionOf,
  isScript,
  TOOL_CONFIG_FILES,
} from './global-paths.ts';
import { ACCOUNT_SKILLS_PREFIX } from './account-skills.ts';
import {
  AUTO_MEMORY_BUNDLE_PREFIX,
  PROJECT_CLAUDE_FILES,
  PROJECT_CLAUDE_FOLDERS,
  PROJECT_MEMORY_FOLDERS,
  PROJECT_NEVER_SYNCED,
  PROJECT_ROOT_FILES,
} from './project-paths.ts';

export { windowsNameProblem };

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

const under = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
/** For refusals: Windows and macOS ignore case, so `Plugins/…` is `plugins/…` there (T43). */
const underAnyCase = (path: string, folder: string) =>
  under(path.toLowerCase(), folder.toLowerCase());

const refused = (reason: string): RestoreDestination => ({ kind: 'refused', reason });

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
  const toolSettings = Object.values(TOOL_CONFIG_FILES).flat();
  if (toolSettings.includes(relative) || allowedScripts.has(HOME_SCRIPTS_PREFIX + relative))
    return { kind: 'home', path: relative };
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
  if (path === PROGRAMS_BUNDLE_PATH || path === PLUGINS_BUNDLE_PATH || path === ENV_BUNDLE_PATH) {
    return { kind: 'metadata' };
  }
  // Saved claude.ai skills (T42): written only by pull's follow-up, after asking.
  if (path.startsWith(ACCOUNT_SKILLS_PREFIX)) return { kind: 'metadata' };
  if (path.startsWith(HOME_SCRIPTS_PREFIX)) {
    return homeDestination(path.slice(HOME_SCRIPTS_PREFIX.length), allowedScripts);
  }
  if (underAnyCase(path, RESERVED_DIR)) return refused('unknown agentnomad entry');
  if (GLOBAL_REFUSED.some((entry) => underAnyCase(path, entry))) return refused('never synced');

  const allowed =
    GLOBAL_FILES.includes(path) ||
    [...GLOBAL_FOLDERS, ...GLOBAL_MEMORY_FOLDERS].some((folder) => path.startsWith(`${folder}/`));
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
  if (path === PLUGINS_BUNDLE_PATH || path === ENV_BUNDLE_PATH) return { kind: 'metadata' };
  if (path.startsWith(`${AUTO_MEMORY_BUNDLE_PREFIX}/`)) {
    // Auto memory is Markdown notes (T43): nothing else, so no script or startup file.
    if (extensionOf(path) !== '.md') return refused('auto memory holds only Markdown files');
    return { kind: 'auto-memory', path: path.slice(AUTO_MEMORY_BUNDLE_PREFIX.length + 1) };
  }
  if (underAnyCase(path, RESERVED_DIR)) return refused('unknown agentnomad entry');
  if (PROJECT_NEVER_SYNCED.some((entry) => underAnyCase(path, entry))) {
    return refused('never synced');
  }

  const claudeFolders = [...PROJECT_CLAUDE_FOLDERS, ...PROJECT_MEMORY_FOLDERS];
  const allowed =
    PROJECT_ROOT_FILES.includes(path) ||
    PROJECT_CLAUDE_FILES.some((name) => path === `.claude/${name}`) ||
    claudeFolders.some((folder) => path.startsWith(`.claude/${folder}/`)) ||
    (isScript(path) && (path.startsWith('.claude/') || allowedScripts.has(path)));
  return allowed ? { kind: 'target', path } : refused('not part of a Claude Code setup');
}
