/** `5 KB`, `1.2 MB`. */
export const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${String(bytes)} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * A size over `limit`, never shown equal to it (UX-06): `6.0 MB`, or `5.0 MB and 1 B` when
 * the two would round to the same text.
 */
export function formatSizeOver(bytes: number, limit: number): string {
  const size = formatSize(bytes);
  return size === formatSize(limit) ? `${size} and ${formatSize(bytes - limit)}` : size;
}
