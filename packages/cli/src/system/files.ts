import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Nothing is at the path: the only file error that may count as "empty" (BUG-06). */
export const isMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/**
 * Where to write `path`: a file linked from a dotfiles folder (stow, chezmoi) is written where
 * it really is, so the link stays (T46). Only a link is followed: a plain or missing file
 * keeps the path as given.
 */
export async function writeTargetOf(path: string): Promise<string> {
  const link = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  return link?.isSymbolicLink() ? realpath(path) : path;
}

export interface AtomicWriteOptions {
  /** Mode of the new file; on macOS and Linux also set with `chmod`, so the umask cannot change it. */
  readonly mode?: number;
  /** Mode of a folder created for it. */
  readonly dirMode?: number;
  /** Write a linked file where it really is, so the link stays (T53). */
  readonly followLink?: boolean;
  /** Runs on the finished temporary file before it takes the real name (T46). */
  readonly beforeRename?: (temp: string) => Promise<void>;
  /** For `chmod`: Windows file modes only control writing. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Writes to a temporary file next to the target and swaps it in, so a crash never leaves half
 * a file. Returns the path written (the link's target when `followLink` follows one).
 */
export async function writeFileAtomically(
  path: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<string> {
  const target = options.followLink === true ? await writeTargetOf(path) : path;
  const folder = dirname(target);
  await mkdir(folder, {
    recursive: true,
    ...(options.dirMode !== undefined && { mode: options.dirMode }),
  });
  // Named so the agents' scans recognise a leftover one (`unknown-files.ts`).
  const temp = join(
    folder,
    `.${basename(target)}.agentnomad-tmp-${randomBytes(4).toString('hex')}`,
  );
  const { mode } = options;
  try {
    await writeFile(temp, content, { flag: 'wx', ...(mode !== undefined && { mode }) });
    if (mode !== undefined && (options.platform ?? process.platform) !== 'win32') {
      await chmod(temp, mode);
    }
    await options.beforeRename?.(temp);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return target;
}
