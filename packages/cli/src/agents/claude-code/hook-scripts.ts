import { underFolder } from '../shared/bundle-paths.ts';
import { pathsOf } from '../shared/detector-system.ts';
import { bundlePathInside } from '../shared/file-gathering.ts';
import {
  GLOBAL_REFUSED,
  HOME_SCRIPTS_PREFIX,
  homePathProblem,
  SCRIPT_EXTENSIONS,
} from './global-paths.ts';
import { PROJECT_NEVER_SYNCED } from './project-paths.ts';
import { commandsInSettings, pathWords } from './settings-commands.ts';

export interface HookScriptContext {
  readonly homedir: string;
  /** Claude Code's base folder (`~/.claude` or `CLAUDE_CONFIG_DIR`). */
  readonly baseDir: string;
  readonly platform: NodeJS.Platform;
}

/** A script a hook or the status line runs: where it is, and its bundle path. */
export interface HookScript {
  readonly nativePath: string;
  /** `hooks/a.sh` in the base folder, or `.agentnomad/home/...` elsewhere in the home. */
  readonly bundlePath: string;
}

/** Compared without case, as pull refuses them (Windows and macOS ignore it). */
const under = (path: string, folder: string) => underFolder(path, folder, { ignoreCase: true });

/**
 * Told about each script a hook or the status line runs that push cannot take (T112): the
 * script as the settings write it, and why. A word without a script extension is a program
 * or an argument, not a script, and is never told.
 */
export type SkippedScript = (what: string, reason: string) => void;

/**
 * `onSkipped` telling each script once, however many commands or settings files run it; for
 * a collector to pass to every call of one push.
 */
export function onceEachScript(onSkipped: SkippedScript | undefined): SkippedScript | undefined {
  if (onSkipped === undefined) return undefined;
  const told = new Set<string>();
  return (what, reason) => {
    if (told.has(what)) return;
    told.add(what);
    onSkipped(what, reason);
  };
}

/** How a skipped script is named where push lists what it left out. */
const scriptLabel = (word: string) => `script ${word}`;

/** Why a script in `folder` (a never-synced or known-state entry) is left out. */
const neverSyncedReason = (folder: string) => `it is in ${folder}, which is never synced`;

/**
 * The scripts that the hooks and status line in a global `settings.json` run (T25), as push
 * collects them and pull allows them back (T38): script files in the base folder (not never-
 * synced ones nor Claude Code's own state, T55) or elsewhere in the home folder (never in
 * folders for keys and logins, nor in ones whose files run by themselves, T43).
 * Push saves only these; pull writes a home-folder file only when it is one of these, so a
 * bundle cannot place other files that run by themselves (a Startup folder, a shell profile).
 * Every other script they run is told to `onSkipped` (T112), so none is left out in silence.
 */
export function hookScripts(
  settingsJson: string,
  context: HookScriptContext,
  onSkipped?: SkippedScript,
): HookScript[] {
  const path = pathsOf(context.platform);
  const home = /^(~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)(?=[\\/]|$)/i;
  const config = /^(\$CLAUDE_CONFIG_DIR|\$\{CLAUDE_CONFIG_DIR\}|%CLAUDE_CONFIG_DIR%)(?=[\\/]|$)/i;

  const relativeInside = (folder: string, file: string) => bundlePathInside(path, folder, file);

  const found = new Map<string, HookScript>();
  for (const words of commandsInSettings(settingsJson)) {
    for (const word of pathWords(words)) {
      const expanded = word
        .replace(home, () => context.homedir)
        .replace(config, () => context.baseDir);
      if (!path.isAbsolute(expanded)) continue;
      const nativePath = path.normalize(expanded);
      if (!SCRIPT_EXTENSIONS.has(path.extname(nativePath).toLowerCase())) continue;

      const inBase = relativeInside(context.baseDir, nativePath);
      const inHome = relativeInside(context.homedir, nativePath);
      const skip = (reason: string) => onSkipped?.(scriptLabel(word), reason);
      let bundlePath: string;
      if (inBase !== null) {
        const refused = GLOBAL_REFUSED.find((entry) => under(inBase, entry));
        if (refused !== undefined) {
          skip(neverSyncedReason(refused));
          continue;
        }
        bundlePath = inBase;
      } else if (inHome !== null) {
        const problem = homePathProblem(inHome);
        if (problem !== null) {
          skip(`it is in ${problem}`);
          continue;
        }
        bundlePath = HOME_SCRIPTS_PREFIX + inHome;
      } else {
        skip('it is outside the home folder');
        continue;
      }
      found.set(bundlePath, { nativePath, bundlePath });
    }
  }
  return [...found.values()];
}

export interface ProjectHookScriptContext {
  readonly projectDir: string;
  readonly platform: NodeJS.Platform;
}

/**
 * The scripts that the hooks and status line in a project's settings run, when they are
 * inside the project: written as `$CLAUDE_PROJECT_DIR/...`, relative to the project (hooks
 * start there) or as an absolute path inside it (T26). Bundle paths are project-relative.
 * Push collects only these and pull writes a script outside `.claude/` only when it is one
 * of these (DUP-03: one rule for both). Every other script they run is told to `onSkipped`
 * (T112).
 */
export function projectHookScripts(
  settingsJson: string,
  context: ProjectHookScriptContext,
  onSkipped?: SkippedScript,
): HookScript[] {
  const path = pathsOf(context.platform);
  const project =
    /^(\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\}|%CLAUDE_PROJECT_DIR%)(?=[\\/]|$)/i;
  const found = new Map<string, HookScript>();
  for (const words of commandsInSettings(settingsJson)) {
    for (const word of pathWords(words)) {
      // Backslashes are separators on every OS: the bundle may come from Windows.
      const expanded = word.replace(project, () => context.projectDir).replace(/\\/g, '/');
      if (!SCRIPT_EXTENSIONS.has(path.extname(expanded).toLowerCase())) continue;
      const skip = (reason: string) => onSkipped?.(scriptLabel(word), reason);
      // The home folder, other variables and another OS's absolute paths are not in the project.
      const elsewhere = !path.isAbsolute(expanded) && /^([A-Za-z]:|\/|~|\$|%)/.test(expanded);
      const nativePath = path.resolve(context.projectDir, expanded);
      const bundlePath = elsewhere ? null : bundlePathInside(path, context.projectDir, nativePath);
      if (bundlePath === null) {
        skip('it is outside the project');
        continue;
      }
      const refused = PROJECT_NEVER_SYNCED.find((entry) => under(bundlePath, entry));
      if (refused !== undefined) {
        skip(neverSyncedReason(refused));
        continue;
      }
      found.set(bundlePath, { nativePath, bundlePath });
    }
  }
  return [...found.values()];
}
