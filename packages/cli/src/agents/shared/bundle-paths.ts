/*
 * Rules for bundle paths and paths from the home folder (relative, `/`-separated), for any
 * adapter (DUP-01): pure text, so the pure modules may use them too.
 */

/**
 * Whether a platform's file system sees names that differ only in case or Unicode form as one
 * name: Windows and macOS do (T43). The one rule for comparing names from a bundle with names
 * on this PC (review 16): with {@link foldedName} where it folds.
 */
export const foldsNames = (platform: NodeJS.Platform): boolean =>
  platform === 'win32' || platform === 'darwin';

/** A name or path as Windows and macOS compare it: Unicode NFC, lower case. */
export const foldedName = (name: string): string => name.normalize('NFC').toLowerCase();

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
  const [inside, entry] = ignoreCase ? [foldedName(path), foldedName(folder)] : [path, folder];
  return inside === entry || inside.startsWith(`${entry}/`);
}

/** Whether a bundle path is one of `folders` or inside one (case kept). */
export const underAnyFolder =
  (folders: readonly string[]) =>
  (path: string): boolean =>
    folders.some((folder) => underFolder(path, folder));

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
