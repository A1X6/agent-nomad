import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import { runProgram } from '../../system/run-program.ts';

/*
 * What any agent's detector reads from this PC, and finding a command on PATH like a shell
 * does (ARCH-02): nothing here is specific to one agent.
 */

/** How long `<command> --version` may take; agents normally answer in well under a second. */
const VERSION_TIMEOUT_MS = 5_000;
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** What the detector reads from this PC; injected so every OS can be tested anywhere. */
export interface DetectorSystem {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  isDirectory(path: string): Promise<boolean>;
  /** A file this user may run (on Windows: any file). */
  isExecutable(path: string): Promise<boolean>;
  /** `null` when the file cannot be read. */
  readText(path: string): Promise<string | null>;
  /** The path with every link resolved; `null` when it does not exist. */
  realPath(path: string): Promise<string | null>;
  /** Runs `file --version` without a shell; stdout, or `null` on error or timeout. */
  runVersion(file: string): Promise<string | null>;
}

/**
 * The parts of DetectorSystem that finding a command on PATH reads (SOLID-06): callers and
 * their tests need nothing else.
 */
export type ExecutableLookupSystem = Pick<
  DetectorSystem,
  'platform' | 'homedir' | 'env' | 'isExecutable'
>;

/** Path rules of the PC being inspected (not of the one running the tests). */
export const pathsOf = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

/** Environment lookup that ignores case on Windows, where `Path` and `PATH` are the same. */
export function envValue(
  system: Pick<DetectorSystem, 'platform' | 'env'>,
  name: string,
): string | undefined {
  if (system.platform !== 'win32') return system.env[name];
  const key = Object.keys(system.env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : system.env[key];
}

/**
 * The file the shell would run for command `command`: PATH in order (PATHEXT order on
 * Windows), then `~/.local/bin`. `null` when it is not installed.
 */
export async function findExecutable(
  system: ExecutableLookupSystem,
  command: string,
): Promise<string | null> {
  const windows = system.platform === 'win32';
  const path = pathsOf(system.platform);
  const folders = (envValue(system, 'PATH') ?? '')
    .split(path.delimiter)
    .map((folder) => folder.trim().replace(/^"(.*)"$/, '$1'))
    // Relative PATH entries depend on the current folder, which is not safe to trust.
    .filter((folder) => folder !== '' && path.isAbsolute(folder));
  folders.push(path.join(system.homedir, '.local', 'bin'));

  const names = windows
    ? (envValue(system, 'PATHEXT') ?? DEFAULT_PATHEXT)
        .split(';')
        .filter((extension) => extension.startsWith('.'))
        .map((extension) => `${command}${extension.toLowerCase()}`)
    : [command];

  for (const folder of folders) {
    for (const name of names) {
      const candidate = path.join(folder, name);
      if (await system.isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** The real PC. */
export function nodeDetectorSystem(
  env: Readonly<Record<string, string | undefined>>,
  homedir: string,
  platform: NodeJS.Platform = process.platform,
): DetectorSystem {
  return {
    platform,
    homedir,
    env,
    async isDirectory(path) {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    async isExecutable(path) {
      try {
        if (!(await stat(path)).isFile()) return false;
        if (platform !== 'win32') await access(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    async readText(path) {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
    async realPath(path) {
      try {
        return await realpath(path);
      } catch {
        return null;
      }
    },
    async runVersion(file) {
      const { stdout, error } = await runProgram(file, ['--version'], {
        timeoutMs: VERSION_TIMEOUT_MS,
      });
      return error ? null : stdout;
    },
  };
}
