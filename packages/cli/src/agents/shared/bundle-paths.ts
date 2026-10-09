/*
 * Rules for bundle paths (relative, `/`-separated), for any adapter (DUP-01): pure text, so
 * the pure modules may use them too (review 16 ARCH-01: the home-folder rules live here, not
 * in the file walker, so no pure module reaches `node:fs` through them).
 */

/** Home folders for keys and cloud logins: never read for a setup, whatever links there. */
const SENSITIVE_HOME_DIRS: readonly string[] = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.config/gcloud',
  '.config/gh',
  '.password-store',
];

/** `relative` (from home, `/`-separated) is `dir` or inside a `dir` folder; any case. */
export function inHomeFolder(relative: string, dir: string): boolean {
  const [lower, folder] = [relative.toLowerCase(), dir.toLowerCase()];
  return lower === folder || lower.startsWith(`${folder}/`) || lower.includes(`/${folder}/`);
}

/** A path from the home folder inside a folder for keys and logins (any case). */
export function isSensitiveHomePath(relative: string): boolean {
  return SENSITIVE_HOME_DIRS.some((dir) => inHomeFolder(relative, dir));
}

/**
 * `path` is `folder` or inside it. `ignoreCase` where Windows and macOS would see the same
 * file (`Plugins/…` is `plugins/…` there, T43): refusals, and what push may take so that
 * pull does not refuse it.
 */
export function underFolder(
  path: string,
  folder: string,
  { ignoreCase = false }: { readonly ignoreCase?: boolean } = {},
): boolean {
  const [inside, entry] = ignoreCase ? [path.toLowerCase(), folder.toLowerCase()] : [path, folder];
  return inside === entry || inside.startsWith(`${entry}/`);
}
