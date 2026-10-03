import { readFile, stat } from 'node:fs/promises';

import { sameBytes } from '@agentnomad/contracts';
import {
  BACKUP_MARKER,
  createMergeStrategies,
  createPathResolver,
  selectMergeStrategy,
  sourceOsOf,
  type MergeChoices,
  type PlannedWrite,
} from '@agentnomad/core';

import type {
  CollectedFile,
  ConflictResolver,
  ConflictToAsk,
  RestoreContext,
  RestoreReport,
  Restorer,
  ScopeTarget,
} from '../adapter.ts';
import { writeFileAtomically } from '../../system/files.ts';
import { pathsOf } from '../shared/detector-system.ts';
import { hookScripts, projectHookScripts } from './hook-scripts.ts';
import { findAutoMemory } from './auto-memory.ts';
import { reviewRunnable } from './command-review.ts';
import {
  CLAUDE_JSON_QUESTION,
  createClaudeJsonMerge,
  type MutableReport,
} from './claude-json-merge.ts';
import { commandsInSettings, pathWords } from './settings-commands.ts';
import { CLAUDE_JSON_BUNDLE_PATH, extensionOf } from './global-paths.ts';
import {
  globalDestination,
  projectDestination,
  type RestoreDestination,
  windowsNameProblem,
} from './restore-rules.ts';
import { isRedirectVariable } from './reviewed-settings.ts';
import type { ClaudeRunningCheck } from './running-claude.ts';

/** What pull's plan step decided for this restore (T61). */
interface ClaudeRestoreContext extends RestoreContext {
  /**
   * Leave `~/.claude.json` as it is, with the "was running" warning: Claude Code was open
   * when the plan asked, and the user chose to skip it.
   */
  readonly leaveClaudeJson?: boolean;
}

/** The Claude Code restorer, and what its plan step needs to know about `~/.claude.json`. */
export interface ClaudeCodeRestorer extends Restorer {
  restore(
    target: ScopeTarget,
    files: readonly CollectedFile[],
    onConflict: ConflictResolver,
    context?: ClaudeRestoreContext,
  ): Promise<RestoreReport>;
  /**
   * What restoring `files` would do to `~/.claude.json` here as it is now: nothing, create
   * it, or merge into it (only after the answer to its conflict question).
   */
  claudeJsonChange(files: readonly CollectedFile[]): Promise<'none' | 'new' | 'merge'>;
}

export interface RestorerOptions {
  /** Claude Code's base folder on this PC (`~/.claude` or `CLAUDE_CONFIG_DIR`). */
  readonly baseDir: string;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether `CLAUDE_CONFIG_DIR` is set: `.claude.json` then lives in the base folder. */
  readonly customConfigDir: boolean;
  /** Checked right before `~/.claude.json` is written: never while Claude Code runs. */
  readonly isClaudeRunning: ClaudeRunningCheck;
  /** Clock for backup names; injectable for tests. */
  readonly now?: () => Date;
}

/** Scripts that must use LF (a CR breaks the shell) and ones Windows runs with CRLF. */
const LF_SCRIPTS = new Set(['.sh', '.bash', '.zsh', '.fish', '.py', '.rb', '.pl', '.lua']);
const CRLF_SCRIPTS = new Set(['.bat', '.cmd']);

/** Commands that only run on one side. */
const WINDOWS_ONLY = /(\.ps1|\.psm1|\.bat|\.cmd)$|^(powershell|pwsh|cmd)(\.exe)?$/i;
const POSIX_ONLY = /(\.sh|\.bash|\.zsh|\.fish)$|^(bash|sh|zsh|fish)$/i;

/** Line endings of scripts for this OS; every other file stays byte-for-byte. */
export function lineEndingsFor(
  platform: NodeJS.Platform,
  path: string,
  content: Uint8Array,
): Uint8Array {
  const extension = extensionOf(path);
  const crlf = platform === 'win32' && CRLF_SCRIPTS.has(extension);
  if (!crlf && !LF_SCRIPTS.has(extension)) return content;
  const text = new TextDecoder().decode(content);
  const lf = text.replace(/\r\n/g, '\n');
  return new TextEncoder().encode(crlf ? lf.replace(/\n/g, '\r\n') : lf);
}

/**
 * Whether the file on disk already is the pulled one: equal as saved, or after the line-ending
 * fix above. A script kept with the other line endings (a CRLF `.py` from Git's autocrlf, an
 * LF `.cmd`) is then left alone instead of conflicting on every pull (T53).
 */
export function sameForRestore(
  platform: NodeJS.Platform,
  path: string,
  existing: Uint8Array,
  incoming: Uint8Array,
): boolean {
  return (
    sameBytes(existing, incoming) || sameBytes(existing, lineEndingsFor(platform, path, incoming))
  );
}

/** Hook and status line commands that will likely not run on `platform` (from another OS). */
export function hooksForOtherOs(settingsJson: string, platform: NodeJS.Platform): string[] {
  const foreign = platform === 'win32' ? POSIX_ONLY : WINDOWS_ONLY;
  return commandsInSettings(settingsJson)
    .filter((words) => pathWords(words).some((word) => foreign.test(word)))
    .map((words) => words.join(' '));
}

/**
 * Writes a pulled Claude Code setup to this PC (T27). Only paths a collector could have
 * produced are written; existing files that differ are resolved with the user's choice
 * (T11 strategies); `~/.claude.json` is only ever merged, and never while Claude Code runs.
 * It never asks: every answer comes from pull's plan step (T61).
 */
export function createClaudeCodeRestorer(options: RestorerOptions): ClaudeCodeRestorer {
  const path = pathsOf(options.platform);
  const os = sourceOsOf(options.platform);
  const resolver = createPathResolver({ os, homeDir: options.homedir });
  const strategies = createMergeStrategies(options.now ? { now: options.now } : {});
  /** Claude Code's settings and MCP files are JSON: the one merge its files need (SOLID-07). */
  const mergeChoices: MergeChoices = {
    merges: [strategies.jsonMerge],
    fallback: strategies.textSideBySide,
    overwrite: strategies.overwrite,
  };
  const claudeJsonFile = options.customConfigDir
    ? path.join(options.baseDir, '.claude.json')
    : path.join(options.homedir, '.claude.json');

  async function readExisting(nativePath: string): Promise<Uint8Array | 'folder' | null> {
    const info = await stat(nativePath).catch(() => null);
    if (info === null) return null;
    if (!info.isFile()) return 'folder';
    return new Uint8Array(await readFile(nativePath));
  }

  /** `''` when nothing is at `nativePath`, else the first free `-2`, `-3`, … (T45). */
  async function freeSuffix(nativePath: string): Promise<string> {
    const taken = async (candidate: string) => (await stat(candidate).catch(() => null)) !== null;
    if (!(await taken(nativePath))) return '';
    for (let number = 2; ; number += 1) {
      if (!(await taken(`${nativePath}-${String(number)}`))) return `-${String(number)}`;
    }
  }

  /**
   * Writes to a temporary file and swaps it in, so a crash never leaves half a file. A linked
   * file is written where it really is, so the link stays (T53).
   */
  async function writeAtomically(nativePath: string, content: Uint8Array, mode: number | null) {
    await writeFileAtomically(nativePath, content, {
      followLink: true,
      platform: options.platform,
      ...(mode !== null && { mode }),
    });
  }

  const claudeJson = createClaudeJsonMerge({
    claudeJsonFile,
    isClaudeRunning: options.isClaudeRunning,
    readExisting,
    writeAtomically,
    freeSuffix,
    ...(options.now && { now: options.now }),
  });

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

  return {
    reviewRunnable,
    isRedirectVariable,

    /**
     * Each file here that differs, in the order `restore` meets them. `~/.claude.json` is
     * listed whenever the setup has it: its other keys are not collected, so whether it
     * would change is only known while writing.
     */
    conflicts(incoming, current): ConflictToAsk[] {
      const found: ConflictToAsk[] = [];
      // One lookup table, not a search per file: a setup may hold thousands (PERF-01).
      const byPath = new Map(current.map((entry) => [entry.path, entry]));
      for (const file of [...incoming].sort((a, b) => (a.path < b.path ? -1 : 1))) {
        const here = byPath.get(file.path);
        const claudeJson = file.path === CLAUDE_JSON_BUNDLE_PATH;
        if (here === undefined && !claudeJson) continue;
        if (
          here !== undefined &&
          sameForRestore(options.platform, file.path, here.content, file.content)
        )
          continue;
        found.push({
          path: file.path,
          question: claudeJson ? CLAUDE_JSON_QUESTION : { overwriteAllowed: true },
        });
      }
      return found;
    },

    async claudeJsonChange(incoming) {
      const file = incoming.find((entry) => entry.path === CLAUDE_JSON_BUNDLE_PATH);
      return file === undefined ? 'none' : claudeJson.change(file);
    },

    async restore(target, incoming, onConflict, context: ClaudeRestoreContext = {}) {
      const report: MutableReport = { written: [], skipped: [], backups: [], warnings: [] };
      // A question the user cancelled (Ctrl+C) or that cannot be asked without a terminal
      // stops the whole restore; only a problem with the entry itself is skipped (T53).
      let stopped: { readonly error: unknown } | undefined;
      const stopping =
        <A extends unknown[], R>(question: (...args: A) => Promise<R>) =>
        async (...args: A): Promise<R> => {
          try {
            return await question(...args);
          } catch (error) {
            stopped = { error };
            throw error;
          }
        };
      const ask = stopping(onConflict);
      const projectScripts = new Set(
        target.kind === 'project'
          ? incoming
              .filter((entry) =>
                ['.claude/settings.json', '.claude/settings.local.json'].includes(entry.path),
              )
              .flatMap((entry) =>
                projectHookScripts(new TextDecoder().decode(entry.content), {
                  projectDir: target.projectDir,
                  platform: options.platform,
                }).map((script) => script.bundlePath),
              )
          : [],
      );
      const settings = incoming.find((entry) => entry.path === 'settings.json');
      const globalScripts = new Set(
        settings
          ? hookScripts(new TextDecoder().decode(settings.content), options).map(
              (script) => script.bundlePath,
            )
          : [],
      );
      const destinationOf = (path: string): RestoreDestination => {
        const windowsProblem = options.platform === 'win32' ? windowsNameProblem(path) : null;
        if (windowsProblem !== null) return { kind: 'refused', reason: windowsProblem };
        return target.kind === 'global'
          ? globalDestination(path, globalScripts)
          : projectDestination(path, projectScripts);
      };

      let memory: Promise<string | null> | undefined;
      const memoryDir = () =>
        (memory ??= (async () => {
          if (target.kind !== 'project') return null;
          const location = await findAutoMemory({ ...options, projectDir: target.projectDir });
          if (location.kind === 'folder') return location.dir;
          report.warnings.push(
            location.kind === 'shared'
              ? 'Auto memory was not restored: autoMemoryDirectory in your user settings is shared by every project.'
              : location.kind === 'refused'
                ? `Auto memory was not restored to ${location.dir}, the folder autoMemoryDirectory names: ${location.reason}.`
                : 'Auto memory was not restored: this project path is too long to find its memory folder.',
          );
          return null;
        })());

      /** Writes one entry; a problem with it is thrown and reported by the loop below. */
      async function restoreEntry(file: CollectedFile): Promise<void> {
        const destination = destinationOf(file.path);
        if (destination.kind === 'refused') {
          report.skipped.push(file.path);
          report.warnings.push(`Refused "${file.path}": ${destination.reason}.`);
          return;
        }
        if (destination.kind === 'metadata') return;
        if (destination.kind === 'claude-json') {
          await claudeJson.merge(file, ask, report, context.leaveClaudeJson === true);
          return;
        }

        const nativePath = await nativePathOf(target, destination, memoryDir);
        if (nativePath === null) {
          report.skipped.push(file.path);
          return;
        }

        const content = lineEndingsFor(options.platform, file.path, file.content);
        const existing = await readExisting(nativePath);
        if (existing === 'folder') {
          report.skipped.push(file.path);
          report.warnings.push(`Skipped "${file.path}": a folder with that name exists.`);
          return;
        }
        const existingMode = existing === null ? null : (await stat(nativePath)).mode & 0o777;

        let writes: readonly PlannedWrite[];
        if (existing === null) {
          writes = [{ path: file.path, content }];
        } else if (sameForRestore(options.platform, file.path, existing, file.content)) {
          return;
        } else {
          const choice = await ask(file.path, { overwriteAllowed: true });
          if (choice === 'skip') {
            report.skipped.push(file.path);
            return;
          }
          writes = selectMergeStrategy(mergeChoices, choice, file.path).resolve({
            path: file.path,
            existing,
            incoming: content,
          });
        }

        for (const write of writes) {
          // Backups and side-by-side copies sit next to the file, with a marker suffix; a
          // name already taken (two pulls in one second) gets a number, never replaced (T45).
          const replacing = write.path === file.path;
          const suffix = replacing
            ? ''
            : await freeSuffix(nativePath + write.path.slice(file.path.length));
          const writePath = nativePath + write.path.slice(file.path.length) + suffix;
          await writeAtomically(
            writePath,
            write.content,
            replacing ? modeFor(file, write.content, existingMode) : existingMode,
          );
          if (write.path.includes(BACKUP_MARKER)) report.backups.push(write.path + suffix);
          else report.written.push(write.path + suffix);
        }
      }

      // Windows and macOS ignore case and Unicode form, so two entries a Linux PC keeps apart
      // (`Notes.md`, `notes.md`) would land on one file here: only the first is written (T43).
      const foldsNames = options.platform === 'win32' || options.platform === 'darwin';
      const seen = new Map<string, string>();
      for (const file of [...incoming].sort((a, b) => (a.path < b.path ? -1 : 1))) {
        if (foldsNames) {
          const folded = file.path.normalize('NFC').toLowerCase();
          const first = seen.get(folded);
          if (first !== undefined) {
            report.skipped.push(file.path);
            report.warnings.push(
              `Skipped "${file.path}": on this PC it is the same file as "${first}".`,
            );
            continue;
          }
          seen.set(folded, file.path);
        }
        // One bad entry is skipped with a warning; it never stops the rest of the restore.
        try {
          await restoreEntry(file);
        } catch (error) {
          if (stopped !== undefined) throw stopped.error;
          report.skipped.push(file.path);
          report.warnings.push(
            `Skipped "${file.path}": ${error instanceof Error ? error.message : String(error)}.`,
          );
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
