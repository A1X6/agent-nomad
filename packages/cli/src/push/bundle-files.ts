import type { BundleFile } from '@agentnomad/contracts';
import type { PathResolver } from '@agentnomad/core';

import type { CollectedFile } from '../agents/adapter.ts';

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** The file's text when it is valid UTF-8 without NUL bytes; `null` for binary files. */
export function asText(content: Uint8Array): string | null {
  if (content.includes(0)) return null;
  try {
    return strictUtf8.decode(content);
  } catch {
    return null;
  }
}

/**
 * Collected files as bundle entries (T33). Text files go in as UTF-8 with this PC's home
 * folder replaced by `{{HOME}}`, so paths work on any PC (T10); everything else as base64,
 * byte for byte.
 */
export function toBundleFiles(
  files: readonly CollectedFile[],
  resolver: PathResolver,
): BundleFile[] {
  return files.map((file) => {
    const text = asText(file.content);
    return text === null
      ? {
          path: file.path,
          executable: file.executable,
          encoding: 'base64',
          content: Buffer.from(file.content).toString('base64'),
        }
      : {
          path: file.path,
          executable: file.executable,
          encoding: 'utf8',
          content: resolver.toPortableText(text),
        };
  });
}
