import * as z from 'zod';

import type { DetectedAgent, Detector } from '../adapter.ts';
import {
  envValue,
  findExecutable,
  pathsOf,
  type DetectorSystem,
  type ExecutableLookupSystem,
} from '../shared/detector-system.ts';

/** Environment variable that moves Claude Code's whole `~/.claude` folder elsewhere. */
const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** Windows launchers that need a shell to run; npm installs Claude Code through these. */
const SHIM_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1']);

/** `CLAUDE_CONFIG_DIR` when set, else `~/.claude` (`%USERPROFILE%\.claude` on Windows). */
export function claudeConfigDir(
  system: Pick<DetectorSystem, 'platform' | 'homedir' | 'env'>,
): string {
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
export function findClaudeExecutable(system: ExecutableLookupSystem): Promise<string | null> {
  return findExecutable(system, 'claude');
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
