/*
 * Rules for bundle paths (relative, `/`-separated), for any adapter (DUP-01): pure text, so
 * the pure modules may use them too.
 */

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
