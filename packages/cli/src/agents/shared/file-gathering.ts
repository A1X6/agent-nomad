import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import type { PlatformPath } from 'node:path';

import { BACKUP_MARKER, INCOMING_MARKER } from '@agentnomad/core';
import { BundlePathSchema } from '@agentnomad/contracts';

import { TEMP_MARKER } from '../../system/files.ts';
import type { CollectedFile } from '../adapter.ts';
import { pathsOf } from './detector-system.ts';

/*
 * Reading an agent's files for a bundle, for any adapter (ARCH-02): nothing here is
 * specific to one agent; what to take comes from the adapter's own data file.
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

/** `file` as a bundle path from `folder` (forward slashes), or `null` when it is not inside it. */
export function bundlePathInside(path: PlatformPath, folder: string, file: string): string | null {
  const relative = path.relative(folder, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const bundlePath = relative.split(path.sep).join('/');
  return BundlePathSchema.safeParse(bundlePath).success ? bundlePath : null;
}

/** Reading files for a bundle; shared by an agent's global (T25) and project (T26) collectors. */
export interface FileGatherer {
  /** Path rules of the PC being collected. */
  readonly path: PlatformPath;
  /** The file as a bundle entry, or `null` when it is not a file. */
  readIfFile(nativePath: string, bundlePath: string): Promise<CollectedFile | null>;
  /**
   * Every file under `folder`, as `bundlePrefix/...`. Follows links once (loop-safe) and
   * skips clutter, agentnomad backup copies and whatever `excluded` names.
   */
  walk(
    folder: string,
    bundlePrefix: string,
    excluded: (bundlePath: string) => boolean,
    seen?: Set<string>,
  ): Promise<CollectedFile[]>;
}

/** agentnomad's backup and incoming copies, and temporary files an interrupted write left. */
const isMarkerCopy = (name: string) =>
  name.includes(BACKUP_MARKER) || name.includes(INCOMING_MARKER) || name.includes(TEMP_MARKER);

/** A file larger than this is left out of a setup (T45): a setup is settings and text. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** What a walk skips, and where links may lead when collecting (T45). */
export interface GatherLimits {
  /** Names skipped anywhere inside a walked folder: tool state and OS clutter (agent data). */
  readonly skippedNames: ReadonlySet<string>;
  /** The home folder: a link into a folder for keys and logins is never followed. */
  readonly homedir?: string;
  /**
   * Links must stay inside this folder. For a project: a cloned repository could link
   * `.claude/skills/x` to `~/.ssh`, and push would save the keys.
   */
  readonly within?: string;
  /** Told about each file left out, with why, so push can say so. */
  readonly onSkipped?: (bundlePath: string, reason: string) => void;
}

export function createFileGatherer(platform: NodeJS.Platform, limits: GatherLimits): FileGatherer {
  const path = pathsOf(platform);

  const relativeInside = (folder: string, file: string) => bundlePathInside(path, folder, file);

  const realOrSelf = (folder: string) => realpath(folder).catch(() => folder);
  const realHome = limits.homedir === undefined ? null : realOrSelf(limits.homedir);
  const realWithin = limits.within === undefined ? null : realOrSelf(limits.within);

  /** Why the real file behind `nativePath` must not be read, or `null` (T45). */
  async function linkProblem(nativePath: string): Promise<string | null> {
    const real = await realpath(nativePath).catch(() => null);
    if (real === null) return null;
    if (realWithin !== null) {
      const within = await realWithin;
      if (real !== within && relativeInside(within, real) === null) {
        return 'it links to a place outside the project';
      }
    }
    if (realHome !== null) {
      const fromHome = relativeInside(await realHome, real);
      if (fromHome !== null && isSensitiveHomePath(fromHome)) {
        return 'it links into a folder for keys and logins';
      }
    }
    return null;
  }

  function skip(bundlePath: string, reason: string): null {
    limits.onSkipped?.(bundlePath, reason);
    return null;
  }

  async function fileEntry(nativePath: string, bundlePath: string) {
    const info = await stat(nativePath);
    if (info.size > MAX_FILE_BYTES) return skip(bundlePath, 'it is larger than 10 MB');
    return {
      path: bundlePath,
      content: new Uint8Array(await readFile(nativePath)),
      // Only macOS and Linux record "may run"; T27 decides per OS on restore.
      executable: platform !== 'win32' && (info.mode & 0o111) !== 0,
    };
  }

  async function readIfFile(nativePath: string, bundlePath: string) {
    const info = await stat(nativePath).catch(() => null);
    if (!info?.isFile()) return null;
    const problem = await linkProblem(nativePath);
    return problem === null ? fileEntry(nativePath, bundlePath) : skip(bundlePath, problem);
  }

  async function walk(
    folder: string,
    bundlePrefix: string,
    excluded: (bundlePath: string) => boolean,
    seen = new Set<string>(),
  ): Promise<CollectedFile[]> {
    let real: string;
    try {
      real = await realpath(folder);
    } catch {
      return [];
    }
    if (seen.has(real)) return [];
    seen.add(real);
    const problem = await linkProblem(folder);
    if (problem !== null) {
      skip(bundlePrefix, problem);
      return [];
    }

    const files: CollectedFile[] = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (limits.skippedNames.has(entry.name) || isMarkerCopy(entry.name)) continue;
      const bundlePath = `${bundlePrefix}/${entry.name}`;
      if (excluded(bundlePath) || !BundlePathSchema.safeParse(bundlePath).success) continue;
      const nativePath = path.join(folder, entry.name);
      // stat follows links, so linked folders (e.g. from a dotfiles repo) come along, as far
      // as the limits allow.
      const info = await stat(nativePath).catch(() => null);
      if (info?.isDirectory()) {
        files.push(...(await walk(nativePath, bundlePath, excluded, seen)));
      } else if (info?.isFile()) {
        const file = await readIfFile(nativePath, bundlePath);
        if (file) files.push(file);
      }
    }
    return files;
  }

  return { path, readIfFile, walk };
}

/** One entry per path (the last wins), sorted by path. */
export function uniqueByPath(files: readonly CollectedFile[]): CollectedFile[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const jsonFile = (bundlePath: string, value: unknown): CollectedFile => ({
  path: bundlePath,
  content: new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`),
  executable: false,
});
