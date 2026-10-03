import { posix, win32 } from 'node:path';

/** A folder as one comparable key on this OS: resolved, and lowercase on Windows (paths ignore case there). */
export function pathKey(folder: string, platform: NodeJS.Platform): string {
  const resolved = (platform === 'win32' ? win32 : posix).resolve(folder);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Same folder on this OS: Windows paths ignore case. */
export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}
