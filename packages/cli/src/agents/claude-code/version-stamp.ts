/**
 * The agent version stamped into each saved setup (T32, `Bundle.agentVersion`) and the
 * check pull makes against this PC's version.
 */

/** `2.1.282` → [2, 1, 282]; pre-release suffixes are ignored for the comparison. */
function numbers(version: string): number[] {
  return (/^(\d+(?:\.\d+)*)/.exec(version)?.[1] ?? '').split('.').filter(Boolean).map(Number);
}

/** Negative when `a` is older than `b`, 0 when equal (or not comparable), positive when newer. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [numbers(a), numbers(b)];
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * What pull says about versions; `null` when there is nothing to say. Warns when the setup
 * was saved from a newer version than this PC runs, since newer settings may not work yet.
 */
export function agentVersionNotice(
  displayName: string,
  savedWith: string | null,
  here: string | null,
): string | null {
  if (savedWith === null) return null;
  if (here === null) {
    return `This setup was saved from ${displayName} ${savedWith}; the version here is unknown.`;
  }
  if (compareVersions(savedWith, here) <= 0) return null;
  return `This setup was saved from ${displayName} ${savedWith}, but this PC has ${here}. Update ${displayName} so every setting works.`;
}
