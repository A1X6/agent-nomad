import { underFolder } from '../shared/bundle-paths.ts';
import { pathsOf } from '../shared/detector-system.ts';
import { bundlePathInside } from '../shared/file-gathering.ts';
import { commandsInSettings, pathWords } from './settings-commands.ts';
import {
  GLOBAL_REFUSED,
  HOME_SCRIPTS_PREFIX,
  homePathProblem,
  SCRIPT_EXTENSIONS,
} from './global-paths.ts';
import { PROJECT_NEVER_SYNCED } from './project-paths.ts';

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
 * The scripts that the hooks and status line in a global `settings.json` run (T25), as push
 * collects them and pull allows them back (T38): script files in the base folder (not never-
 * synced ones nor Claude Code's own state, T55) or elsewhere in the home folder (never in folders for keys and logins, nor
 * in ones whose files run by themselves, T43).
 * Push saves only these; pull writes a home-folder file only when it is one of these, so a
 * bundle cannot place other files that run by themselves (a Startup folder, a shell profile).
 */
export function hookScripts(settingsJson: string, context: HookScriptContext): HookScript[] {
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
      let bundlePath: string;
      if (inBase !== null) {
        if (GLOBAL_REFUSED.some((entry) => under(inBase, entry))) continue;
        bundlePath = inBase;
      } else if (inHome !== null && homePathProblem(inHome) === null) {
        bundlePath = HOME_SCRIPTS_PREFIX + inHome;
      } else {
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
 * of these (DUP-03: one rule for both).
 */
export function projectHookScripts(
  settingsJson: string,
  context: ProjectHookScriptContext,
): HookScript[] {
  const path = pathsOf(context.platform);
  const project =
    /^(\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\}|%CLAUDE_PROJECT_DIR%)(?=[\\/]|$)/i;
  const found = new Map<string, HookScript>();
  for (const words of commandsInSettings(settingsJson)) {
    for (const word of pathWords(words)) {
      // Backslashes are separators on every OS: the bundle may come from Windows.
      const expanded = word.replace(project, () => context.projectDir).replace(/\\/g, '/');
      // The home folder, other variables and another OS's absolute paths are not in the project.
      if (!path.isAbsolute(expanded) && /^([A-Za-z]:|\/|~|\$|%)/.test(expanded)) continue;
      if (!SCRIPT_EXTENSIONS.has(path.extname(expanded).toLowerCase())) continue;
      const nativePath = path.resolve(context.projectDir, expanded);
      const bundlePath = bundlePathInside(path, context.projectDir, nativePath);
      if (bundlePath === null || PROJECT_NEVER_SYNCED.some((entry) => under(bundlePath, entry))) {
        continue;
      }
      found.set(bundlePath, { nativePath, bundlePath });
    }
  }
  return [...found.values()];
}
