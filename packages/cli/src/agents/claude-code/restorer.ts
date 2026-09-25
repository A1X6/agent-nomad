import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

import type { SourceOs } from '@agentnomad/contracts';
import {
  BACKUP_MARKER,
  createMergeStrategies,
  createPathResolver,
  selectMergeStrategy,
  type PlannedWrite,
} from '@agentnomad/core';
import * as z from 'zod';

import type {
  CollectedFile,
  ConflictResolver,
  RestoreContext,
  Restorer,
  ScopeTarget,
} from '../adapter.ts';
import { findAutoMemory } from './auto-memory.ts';
import { commandsInSettings, commandWords, createFileGatherer } from './file-gathering.ts';
import { CLAUDE_JSON_BUNDLE_PATH, CLAUDE_JSON_MCP_KEY } from './global-paths.ts';
import { ClaudeJsonError } from './global-collector.ts';
import {
  globalDestination,
  projectDestination,
  projectHookScripts,
  type RestoreDestination,
} from './restore-rules.ts';
import type { ClaudeRunningCheck } from './running-claude.ts';

/** The user's answer while Claude Code is running: try again after closing it, or skip. */
export type ClaudeRunningAnswer = 'retry' | 'skip';

export interface RestorerOptions {
  /** Claude Code's base folder on this PC (`~/.claude` or `CLAUDE_CONFIG_DIR`). */
  readonly baseDir: string;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether `CLAUDE_CONFIG_DIR` is set: `.claude.json` then lives in the base folder. */
  readonly customConfigDir: boolean;
  readonly isClaudeRunning: ClaudeRunningCheck;
  /** Asks the user to close Claude Code (then `retry`) or to leave `~/.claude.json` alone. */
  readonly onClaudeRunning: () => Promise<ClaudeRunningAnswer>;
  /** Clock for backup names; injectable for tests. */
  readonly now?: () => Date;
}

/** Scripts that must use LF (a CR breaks the shell) and ones Windows runs with CRLF. */
const LF_SCRIPTS = new Set(['.sh', '.bash', '.zsh', '.fish', '.py', '.rb', '.pl', '.lua']);
const CRLF_SCRIPTS = new Set(['.bat', '.cmd']);

/** Commands that only run on one side. */
const WINDOWS_ONLY = /(\.ps1|\.psm1|\.bat|\.cmd)$|^(powershell|pwsh|cmd)(\.exe)?$/i;
const POSIX_ONLY = /(\.sh|\.bash|\.zsh|\.fish)$|^(bash|sh|zsh|fish)$/i;

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Line endings of scripts for this OS; every other file stays byte-for-byte. */
export function lineEndingsFor(
  platform: NodeJS.Platform,
  path: string,
  content: Uint8Array,
): Uint8Array {
  const extension = /(\.[^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  const crlf = platform === 'win32' && CRLF_SCRIPTS.has(extension);
  if (!crlf && !LF_SCRIPTS.has(extension)) return content;
  const text = new TextDecoder().decode(content);
  const lf = text.replace(/\r\n/g, '\n');
  return new TextEncoder().encode(crlf ? lf.replace(/\n/g, '\r\n') : lf);
}

/** Hook and status line commands that will likely not run on `platform` (from another OS). */
export function hooksForOtherOs(settingsJson: string, platform: NodeJS.Platform): string[] {
  const foreign = platform === 'win32' ? POSIX_ONLY : WINDOWS_ONLY;
  return commandsInSettings(settingsJson).filter((command) =>
    commandWords(command).some((word) => foreign.test(word)),
  );
}

/**
 * Writes a pulled Claude Code setup to this PC (T27). Only paths a collector could have
 * produced are written; existing files that differ are resolved with the user's choice
 * (T11 strategies); `~/.claude.json` is only ever merged, and never while Claude Code runs.
 */
export function createClaudeCodeRestorer(options: RestorerOptions): Restorer {
  const files = createFileGatherer(options.platform);
  const { path } = files;
  const os: SourceOs =
    options.platform === 'win32' || options.platform === 'darwin' ? options.platform : 'linux';
  const resolver = createPathResolver({ os, homeDir: options.homedir });
  const strategies = createMergeStrategies(options.now ? { now: options.now } : {});
  const claudeJsonFile = options.customConfigDir
    ? path.join(options.baseDir, '.claude.json')
    : path.join(options.homedir, '.claude.json');

  async function readExisting(nativePath: string): Promise<Uint8Array | 'folder' | null> {
    const info = await stat(nativePath).catch(() => null);
    if (info === null) return null;
    if (!info.isFile()) return 'folder';
    return new Uint8Array(await readFile(nativePath));
  }

  /** Writes to a temporary file and swaps it in, so a crash never leaves half a file. */
  async function writeAtomically(nativePath: string, content: Uint8Array, mode: number | null) {
    await mkdir(path.dirname(nativePath), { recursive: true });
    const temp = path.join(
      path.dirname(nativePath),
      `.${path.basename(nativePath)}.agentnomad-tmp-${randomBytes(4).toString('hex')}`,
    );
    try {
      await writeFile(temp, content, { flag: 'wx', ...(mode !== null && { mode }) });
      if (mode !== null && options.platform !== 'win32') await chmod(temp, mode);
      await rename(temp, nativePath);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  /** Permissions: a replaced file keeps its own; new scripts may run on macOS and Linux. */
  function modeFor(file: CollectedFile, content: Uint8Array, existingMode: number | null) {
    if (options.platform === 'win32') return null;
    const runnable =
      file.executable || (content[0] === 0x23 && content[1] === 0x21); /* starts with "#!" */
    if (existingMode !== null) return runnable ? existingMode | 0o111 : existingMode;
    return runnable ? 0o755 : null;
  }

  /** The OS path of a destination, or `null` when it has no place on this PC. */
  async function nativePathOf(
    target: ScopeTarget,
    destination: RestoreDestination,
    memoryDir: () => Promise<string | null>,
  ): Promise<string | null> {
    switch (destination.kind) {
      case 'target':
        return resolver.toNativePath(
          target.kind === 'global' ? options.baseDir : target.projectDir,
          destination.path,
        );
      case 'home':
        return resolver.toNativePath(options.homedir, destination.path);
      case 'auto-memory': {
        const dir = await memoryDir();
        return dir === null ? null : resolver.toNativePath(dir, destination.path);
      }
      default:
        return null;
    }
  }

  /** Merges the selected keys into `~/.claude.json`, keeping everything else in it. */
  async function mergeClaudeJson(
    file: CollectedFile,
    onConflict: ConflictResolver,
    report: MutableReport,
  ): Promise<void> {
    const incoming = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(new TextDecoder().decode(file.content)));
    const existing = await readExisting(claudeJsonFile);
    if (existing === 'folder') {
      report.skipped.push(file.path);
      return;
    }
    let current: Record<string, unknown> = {};
    if (existing !== null) {
      try {
        current = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(new TextDecoder().decode(existing)));
      } catch (error) {
        throw new ClaudeJsonError(claudeJsonFile, { cause: error });
      }
    }
    // Servers merge by name (incoming wins); preference keys are replaced. A Map keeps a
    // key named "__proto__" plain data.
    const merged = new Map(Object.entries(current));
    for (const [key, value] of Object.entries(incoming)) {
      const before = merged.get(key);
      merged.set(
        key,
        key === CLAUDE_JSON_MCP_KEY && isJsonObject(before) && isJsonObject(value)
          ? Object.fromEntries([...Object.entries(before), ...Object.entries(value)])
          : value,
      );
    }
    // Claude Code formats the file its own way, so compare the keys, not the bytes.
    const unchanged =
      existing !== null &&
      Object.keys(incoming).every(
        (key) => JSON.stringify(current[key]) === JSON.stringify(merged.get(key)),
      );
    if (unchanged) return;
    const content = new TextEncoder().encode(
      `${JSON.stringify(Object.fromEntries(merged), null, 2)}\n`,
    );
    if (existing !== null) {
      const choice = await onConflict(CLAUDE_JSON_BUNDLE_PATH, { overwriteAllowed: false });
      if (choice === 'skip') {
        report.skipped.push(file.path);
        return;
      }
    }
    while (await options.isClaudeRunning()) {
      if ((await options.onClaudeRunning()) === 'skip') {
        report.skipped.push(file.path);
        report.warnings.push(
          `${claudeJsonFile} was left as it is because Claude Code was running; pull again later to add your MCP servers and preferences.`,
        );
        return;
      }
    }
    const mode = existing === null ? 0o600 : (await stat(claudeJsonFile)).mode & 0o777;
    if (existing !== null) {
      const backup = `${claudeJsonFile}${BACKUP_MARKER}${stamp(options.now?.() ?? new Date())}`;
      await writeAtomically(backup, existing, mode);
      report.backups.push(backup);
    }
    await writeAtomically(claudeJsonFile, content, mode);
    report.written.push(file.path);
  }

  return {
    async restore(target, incoming, onConflict, context: RestoreContext = {}) {
      const report: MutableReport = { written: [], skipped: [], backups: [], warnings: [] };
      const hookScripts = projectHookScripts(
        incoming
          .filter((entry) =>
            ['.claude/settings.json', '.claude/settings.local.json'].includes(entry.path),
          )
          .map((entry) => new TextDecoder().decode(entry.content)),
      );
      const destinationOf = (path: string) =>
        target.kind === 'global' ? globalDestination(path) : projectDestination(path, hookScripts);

      let memory: Promise<string | null> | undefined;
      const memoryDir = () =>
        (memory ??= (async () => {
          if (target.kind !== 'project') return null;
          const location = await findAutoMemory({ ...options, projectDir: target.projectDir });
          if (location.kind === 'folder') return location.dir;
          report.warnings.push(
            location.kind === 'shared'
              ? 'Auto memory was not restored: autoMemoryDirectory in your user settings is shared by every project.'
              : 'Auto memory was not restored: this project path is too long to find its memory folder.',
          );
          return null;
        })());

      for (const file of [...incoming].sort((a, b) => (a.path < b.path ? -1 : 1))) {
        const destination = destinationOf(file.path);
        if (destination.kind === 'refused') {
          report.skipped.push(file.path);
          report.warnings.push(`Refused "${file.path}": ${destination.reason}.`);
          continue;
        }
        if (destination.kind === 'metadata') continue;
        if (destination.kind === 'claude-json') {
          await mergeClaudeJson(file, onConflict, report);
          continue;
        }

        let nativePath: string | null;
        try {
          nativePath = await nativePathOf(target, destination, memoryDir);
        } catch (error) {
          report.skipped.push(file.path);
          report.warnings.push(`Skipped "${file.path}": ${(error as Error).message}.`);
          continue;
        }
        if (nativePath === null) {
          report.skipped.push(file.path);
          continue;
        }

        const content = lineEndingsFor(options.platform, file.path, file.content);
        const existing = await readExisting(nativePath);
        if (existing === 'folder') {
          report.skipped.push(file.path);
          report.warnings.push(`Skipped "${file.path}": a folder with that name exists.`);
          continue;
        }
        const existingMode = existing === null ? null : (await stat(nativePath)).mode & 0o777;

        let writes: readonly PlannedWrite[];
        if (existing === null) {
          writes = [{ path: file.path, content }];
        } else if (sameBytes(existing, content)) {
          continue;
        } else {
          const choice = await onConflict(file.path, { overwriteAllowed: true });
          if (choice === 'skip') {
            report.skipped.push(file.path);
            continue;
          }
          writes = selectMergeStrategy(strategies, choice, file.path).resolve({
            path: file.path,
            existing,
            incoming: content,
          });
        }

        for (const write of writes) {
          // Backups and side-by-side copies sit next to the file, with a marker suffix.
          const writePath = nativePath + write.path.slice(file.path.length);
          const replacing = write.path === file.path;
          await writeAtomically(
            writePath,
            write.content,
            replacing ? modeFor(file, write.content, existingMode) : existingMode,
          );
          if (write.path.includes(BACKUP_MARKER)) report.backups.push(write.path);
          else report.written.push(write.path);
        }
      }

      if (context.sourceOs !== undefined && context.sourceOs !== os) {
        const settingsPaths =
          target.kind === 'global'
            ? ['settings.json']
            : ['.claude/settings.json', '.claude/settings.local.json'];
        for (const file of incoming.filter((entry) => settingsPaths.includes(entry.path))) {
          for (const command of hooksForOtherOs(
            new TextDecoder().decode(file.content),
            options.platform,
          )) {
            report.warnings.push(
              `This hook or status line came from ${context.sourceOs} and will likely not run here: ${command}`,
            );
          }
        }
      }
      return report;
    },
  };
}

interface MutableReport {
  written: string[];
  skipped: string[];
  backups: string[];
  warnings: string[];
}

/** Same format as the T11 backup names: `20260925T120000Z`. */
const stamp = (date: Date) =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
