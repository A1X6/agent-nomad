import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import * as z from 'zod';

import type { DetectedAgent, Detector } from '../adapter.ts';

/** Environment variable that moves Claude Code's whole `~/.claude` folder elsewhere. */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** How long `claude --version` may take; it normally answers in well under a second. */
const VERSION_TIMEOUT_MS = 5_000;
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
/** Windows launchers that need a shell to run; npm installs Claude Code through these. */
const SHIM_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1']);

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
  /** Runs `file --version` without a shell; stdout, or `null` on error or timeout. */
  runVersion(file: string): Promise<string | null>;
}

/** Path rules of the PC being inspected (not of the one running the tests). */
const pathsOf = (system: DetectorSystem) => (system.platform === 'win32' ? win32 : posix);

/** Environment lookup that ignores case on Windows, where `Path` and `PATH` are the same. */
function envValue(system: DetectorSystem, name: string): string | undefined {
  if (system.platform !== 'win32') return system.env[name];
  const key = Object.keys(system.env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : system.env[key];
}

/** `CLAUDE_CONFIG_DIR` when set, else `~/.claude` (`%USERPROFILE%\.claude` on Windows). */
export function claudeConfigDir(system: DetectorSystem): string {
  const path = pathsOf(system);
  const configured = envValue(system, CLAUDE_CONFIG_DIR_ENV)?.trim();
  if (configured) return path.resolve(configured);
  return path.join(system.homedir, '.claude');
}

/** First version number in `claude --version` output, e.g. `2.1.282 (Claude Code)`. */
export function parseVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output)?.[1] ?? null;
}

/**
 * The `claude` command the user's shell would run: the first match on PATH, then the
 * native installer's folder (`~/.local/bin`), which some shells leave off PATH.
 */
export function findClaudeExecutable(system: DetectorSystem): Promise<string | null> {
  return findExecutable(system, 'claude');
}

/**
 * The file the shell would run for command `command`: PATH in order (PATHEXT order on
 * Windows), then `~/.local/bin`. `null` when it is not installed.
 */
export async function findExecutable(
  system: DetectorSystem,
  command: string,
): Promise<string | null> {
  const windows = system.platform === 'win32';
  const path = pathsOf(system);
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

const PackageVersionSchema = z.object({ version: z.string() });

/**
 * Version of the found command. A Windows npm shim (`claude.cmd`) is not run, because
 * that needs a shell; its version is read from the package it launches instead.
 */
async function versionOf(system: DetectorSystem, executable: string): Promise<string | null> {
  const path = pathsOf(system);
  if (system.platform === 'win32' && SHIM_EXTENSIONS.has(path.extname(executable).toLowerCase())) {
    const manifest = await system.readText(
      path.join(
        path.dirname(executable),
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'package.json',
      ),
    );
    if (manifest === null) return null;
    try {
      const parsed = PackageVersionSchema.safeParse(JSON.parse(manifest));
      return parsed.success ? parseVersion(parsed.data.version) : null;
    } catch {
      return null;
    }
  }
  const output = await system.runVersion(executable);
  return output === null ? null : parseVersion(output);
}

/**
 * Is Claude Code on this PC (T24)? Yes when the `claude` command is found or its config
 * folder exists: a folder alone still holds a setup worth pushing, and pulling into it
 * works before Claude Code is installed.
 */
export function createClaudeCodeDetector(system: DetectorSystem): Detector {
  return {
    async detect(): Promise<DetectedAgent> {
      const baseDir = claudeConfigDir(system);
      const [hasFolder, executable] = await Promise.all([
        system.isDirectory(baseDir),
        findClaudeExecutable(system),
      ]);
      if (!hasFolder && executable === null) {
        return { installed: false, baseDir: null, version: null };
      }
      return {
        installed: true,
        baseDir,
        version: executable === null ? null : await versionOf(system, executable),
      };
    },
  };
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
    runVersion(file) {
      return new Promise((done) => {
        execFile(
          file,
          ['--version'],
          { timeout: VERSION_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
          (error, stdout) => {
            done(error ? null : stdout);
          },
        );
      });
    },
  };
}
