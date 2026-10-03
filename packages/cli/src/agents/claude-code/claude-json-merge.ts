import { stat } from 'node:fs/promises';

import { BACKUP_MARKER, backupStamp } from '@agentnomad/core';
import * as z from 'zod';

import type { CollectedFile, ConflictQuestion, ConflictResolver } from '../adapter.ts';
import {
  CLAUDE_JSON_BUNDLE_PATH,
  CLAUDE_JSON_MCP_KEY,
  CLAUDE_JSON_PREFERENCE_KEYS,
} from './global-paths.ts';
import { ClaudeJsonError } from './global-collector.ts';
import type { ClaudeRunningCheck } from './running-claude.ts';

/** `~/.claude.json`'s question: never replaced, only merged or skipped. */
export const CLAUDE_JSON_QUESTION: ConflictQuestion = {
  overwriteAllowed: false,
  message: '~/.claude.json: add your MCP servers and preferences (your login and history stay)?',
};

/** What a restore has done so far; the merge adds to it. */
export interface MutableReport {
  written: string[];
  skipped: string[];
  backups: string[];
  warnings: string[];
}

export interface ClaudeJsonMergeOptions {
  /** Where `~/.claude.json` is on this PC. */
  readonly claudeJsonFile: string;
  /** Checked right before the file is written: never while Claude Code runs. */
  readonly isClaudeRunning: ClaudeRunningCheck;
  /** The file's bytes, `'folder'` when a folder is in its place, `null` when missing. */
  readonly readExisting: (nativePath: string) => Promise<Uint8Array | 'folder' | null>;
  /** Writes so a crash never leaves half a file; `mode` `null` leaves the default. */
  readonly writeAtomically: (
    nativePath: string,
    content: Uint8Array,
    mode: number | null,
  ) => Promise<void>;
  /** `''` when nothing is at `nativePath`, else the first free `-2`, `-3`, …. */
  readonly freeSuffix: (nativePath: string) => Promise<string>;
  /** Clock for backup names. */
  readonly now?: () => Date;
}

/** The `~/.claude.json` merge of the Claude Code restorer (T43; SOLID-05). */
export interface ClaudeJsonMerge {
  /**
   * What restoring the pulled `file` would do here as it is now: nothing, create it, or
   * merge into it.
   */
  change(file: CollectedFile): Promise<'none' | 'new' | 'merge'>;
  /**
   * Merges the pulled keys into `~/.claude.json`, keeping everything else in it. `leave`:
   * the plan chose to skip it because Claude Code was running.
   */
  merge(
    file: CollectedFile,
    onConflict: ConflictResolver,
    report: MutableReport,
    leave: boolean,
  ): Promise<void>;
}

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `current` with the incoming keys merged in: servers by name (incoming wins), preference
 * keys replaced. A Map keeps a key named "__proto__" plain data. `unchanged` compares the
 * keys, not the bytes, since Claude Code formats the file its own way.
 */
function mergeInto(current: Record<string, unknown>, incoming: Record<string, unknown>) {
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
  const unchanged = Object.keys(incoming).every(
    (key) => JSON.stringify(current[key]) === JSON.stringify(merged.get(key)),
  );
  return { merged, unchanged };
}

/** The keys of a pulled `~/.claude.json` that are restored, and the ones left out. */
function claudeJsonKeys(file: CollectedFile) {
  const parsed = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(new TextDecoder().decode(file.content)));
  const allowed = new Set([CLAUDE_JSON_MCP_KEY, ...CLAUDE_JSON_PREFERENCE_KEYS]);
  const incoming = Object.fromEntries(Object.entries(parsed).filter(([key]) => allowed.has(key)));
  const ignored = Object.keys(parsed).filter((key) => !allowed.has(key));
  return { incoming, ignored };
}

/**
 * Only the keys push saves are taken (T43): the MCP servers and the preference keys. Anything
 * else, such as `projects` (local MCP servers and folder trust) or account state, is left out.
 */
export function createClaudeJsonMerge(options: ClaudeJsonMergeOptions): ClaudeJsonMerge {
  const { claudeJsonFile } = options;

  /** `~/.claude.json` as it is now, parsed: `existing` is `null` when missing. */
  async function readClaudeJson() {
    const existing = await options.readExisting(claudeJsonFile);
    if (existing === null || existing === 'folder') return { existing, current: {} };
    try {
      const current = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(new TextDecoder().decode(existing)));
      return { existing, current };
    } catch (error) {
      throw new ClaudeJsonError(claudeJsonFile, { cause: error });
    }
  }

  return {
    async change(file) {
      try {
        const keys = claudeJsonKeys(file).incoming;
        if (Object.keys(keys).length === 0) return 'none';
        const { existing, current } = await readClaudeJson();
        if (existing === 'folder') return 'none';
        if (existing === null) return 'new';
        return mergeInto(current, keys).unchanged ? 'none' : 'merge';
      } catch {
        // A file that cannot be read is reported by the restore itself.
        return 'none';
      }
    },

    async merge(file, onConflict, report, leave) {
      const { incoming, ignored } = claudeJsonKeys(file);
      if (ignored.length > 0) {
        report.warnings.push(
          `Left out of ${claudeJsonFile}: ${ignored.map((key) => JSON.stringify(key)).join(', ')} (only MCP servers and preferences are restored there).`,
        );
      }
      if (Object.keys(incoming).length === 0) return;

      const before = await readClaudeJson();
      if (before.existing === 'folder') {
        report.skipped.push(file.path);
        return;
      }
      if (before.existing !== null) {
        if (mergeInto(before.current, incoming).unchanged) return;
        const choice = await onConflict(CLAUDE_JSON_BUNDLE_PATH, CLAUDE_JSON_QUESTION);
        if (choice === 'skip') {
          report.skipped.push(file.path);
          return;
        }
      }
      // Asked in the plan (T61): skipped there, or open again now that nobody can be asked.
      if (leave || (await options.isClaudeRunning())) {
        report.skipped.push(file.path);
        report.warnings.push(
          `${claudeJsonFile} was left as it is because Claude Code or the Claude app was running; pull again later to add your MCP servers and preferences.`,
        );
        return;
      }
      // Read again now that Claude Code is closed: it may have saved the file meanwhile (T43).
      const { existing, current } = await readClaudeJson();
      if (existing === 'folder') {
        report.skipped.push(file.path);
        return;
      }
      const { merged, unchanged } = mergeInto(current, incoming);
      if (existing !== null && unchanged) return;
      const content = new TextEncoder().encode(
        `${JSON.stringify(Object.fromEntries(merged), null, 2)}\n`,
      );
      const mode = existing === null ? 0o600 : (await stat(claudeJsonFile)).mode & 0o777;
      if (existing !== null) {
        const name = `${claudeJsonFile}${BACKUP_MARKER}${backupStamp(options.now?.() ?? new Date())}`;
        const backup = name + (await options.freeSuffix(name));
        await options.writeAtomically(backup, existing, mode);
        report.backups.push(backup);
      }
      await options.writeAtomically(claudeJsonFile, content, mode);
      report.written.push(file.path);
    },
  };
}
