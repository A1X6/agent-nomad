import { readFile, stat } from 'node:fs/promises';

import { BACKUP_MARKER, backupStamp } from '@agentnomad/core';
import * as z from 'zod';

import { isJsonObject, JsonObjectSchema, strings } from '../../system/json.ts';
import { printableLine } from '../../ui/printable.ts';
import type { CollectedFile, ConflictQuestion, ConflictResolver, ScopeTarget } from '../adapter.ts';
import { pathsOf } from '../shared/detector-system.ts';
import { repositoryRoot } from './auto-memory.ts';
import {
  CLAUDE_JSON_BUNDLE_PATH,
  CLAUDE_JSON_MCP_KEY,
  CLAUDE_JSON_PREFERENCE_KEYS,
} from './global-paths.ts';
import { CLAUDE_JSON_PROJECT_BUNDLE_PATH, CLAUDE_JSON_PROJECT_KEYS } from './project-paths.ts';
import type { ClaudeRunningCheck } from './running-claude.ts';

/** `~/.claude.json` could not be read as JSON (e.g. Claude Code was writing it). */
export class ClaudeJsonError extends Error {
  constructor(path: string, options?: ErrorOptions) {
    super(`Could not read ${path}. If Claude Code is running, try again in a moment.`, options);
    this.name = 'ClaudeJsonError';
  }
}

/** `~/.claude.json`'s question: never replaced, only merged or skipped. */
export const CLAUDE_JSON_QUESTION: ConflictQuestion = {
  overwriteAllowed: false,
  message: '~/.claude.json: add your MCP servers and preferences (your login and history stay)?',
};

/**
 * The same for a project's entry in it (T109), naming what is added and why it is asked, in
 * the words of push's summary: e.g. `MCP servers notes; .mcp.json servers approved: db`.
 */
export const claudeJsonProjectQuestion = (items: readonly string[]): ConflictQuestion => ({
  overwriteAllowed: false,
  message: `~/.claude.json: add this project's ${items.join('; ')} to its entry for this folder? Claude Code keeps them there next to your login and the folder's trust, which stay as they are. Merge (the default) adds them; Skip leaves the file as it is.`,
});

/** Whether `path` is a saved part of `~/.claude.json`: the global one or a project's (T109). */
export const isClaudeJsonPath = (path: string): boolean =>
  path === CLAUDE_JSON_BUNDLE_PATH || path === CLAUDE_JSON_PROJECT_BUNDLE_PATH;

/** The question for a saved part of `~/.claude.json`. */
export const claudeJsonQuestion = (file: CollectedFile): ConflictQuestion =>
  file.path === CLAUDE_JSON_PROJECT_BUNDLE_PATH
    ? claudeJsonProjectQuestion(projectPartItems(file))
    : CLAUDE_JSON_QUESTION;

/** Where `~/.claude.json` is: in the base folder when `CLAUDE_CONFIG_DIR` is set, else home. */
export const claudeJsonFileOf = (place: {
  readonly baseDir: string;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
  readonly customConfigDir: boolean;
}): string =>
  pathsOf(place.platform).join(
    place.customConfigDir ? place.baseDir : place.homedir,
    '.claude.json',
  );

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
  /** How this PC writes a project's path as its key in the file (T109). */
  readonly platform: NodeJS.Platform;
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
   * merge into it. A project's part (T109) goes into the entry of `target`'s folder.
   */
  change(file: CollectedFile, target?: ScopeTarget): Promise<'none' | 'new' | 'merge'>;
  /**
   * Merges the pulled keys into `~/.claude.json`, keeping everything else in it. `leave`:
   * the plan chose to skip it because Claude Code was running.
   */
  merge(
    file: CollectedFile,
    onConflict: ConflictResolver,
    report: MutableReport,
    leave: boolean,
    target?: ScopeTarget,
  ): Promise<void>;
}

/**
 * `~/.claude.json` at `file`, parsed, or `null` when it is missing. Push reads it for the
 * global and the project setup alike (T109).
 */
export async function readClaudeJsonFile(file: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ClaudeJsonError(file, { cause: error });
  }
  const all = JsonObjectSchema.safeParse(parsed);
  if (!all.success) throw new ClaudeJsonError(file, { cause: all.error });
  return all.data;
}

/**
 * The key of `projectDir` in `projects`, as Claude Code 2.1.296 writes it (T109): the folder
 * as given, with `/` for `\` on Windows and no change of case. On Windows, which ignores case,
 * an entry already there under another case of the same path is the one used. Claude Code
 * gives it the main repository's root (`repositoryRoot`), so callers pass that (BUG-02).
 */
export function projectKeyOf(
  projects: Record<string, unknown>,
  projectDir: string,
  platform: NodeJS.Platform,
): string {
  if (platform !== 'win32') return projectDir;
  const key = projectDir.replaceAll('\\', '/');
  if (Object.hasOwn(projects, key)) return key;
  const folded = key.toLowerCase();
  return Object.keys(projects).find((name) => name.toLowerCase() === folded) ?? key;
}

/**
 * The setup of `projectDir`'s entry in a parsed `~/.claude.json` (T109): its local-scope MCP
 * servers and its `.mcp.json` choices, the non-empty ones only; `null` when it has none.
 */
export function projectClaudeJson(
  all: Record<string, unknown>,
  projectDir: string,
  platform: NodeJS.Platform,
): Record<string, unknown> | null {
  const projects = isJsonObject(all['projects']) ? all['projects'] : {};
  const entry = projects[projectKeyOf(projects, projectDir, platform)];
  if (!isJsonObject(entry)) return null;
  const selected: Record<string, unknown> = {};
  for (const key of CLAUDE_JSON_PROJECT_KEYS) {
    const value = entry[key];
    const empty = isJsonObject(value)
      ? Object.keys(value).length === 0
      : !Array.isArray(value) || value.length === 0;
    if (!empty) selected[key] = value;
  }
  return Object.keys(selected).length === 0 ? null : selected;
}

/**
 * What a saved project's part of `~/.claude.json` holds, as push, pull and its question name
 * it (T109): e.g. `MCP servers db, docs` and `.mcp.json servers approved: github`.
 */
function projectPartItems(file: CollectedFile): string[] {
  let saved: unknown;
  try {
    saved = JSON.parse(new TextDecoder().decode(file.content));
  } catch {
    return [];
  }
  if (!isJsonObject(saved)) return [];
  // Names from a pulled bundle, each shown on one line (SEC-06).
  const names = (list: string[]) => list.map(printableLine).join(', ');
  const servers = isJsonObject(saved[CLAUDE_JSON_MCP_KEY])
    ? Object.keys(saved[CLAUDE_JSON_MCP_KEY])
    : [];
  const approved = strings(saved['enabledMcpjsonServers']);
  const rejected = strings(saved['disabledMcpjsonServers']);
  return [
    ...(servers.length > 0 ? [`MCP servers ${names(servers)}`] : []),
    ...(approved.length > 0 ? [`.mcp.json servers approved: ${names(approved)}`] : []),
    ...(rejected.length > 0 ? [`.mcp.json servers rejected: ${names(rejected)}`] : []),
  ];
}

/**
 * What push's summary and pull's plan say about a project's part of `~/.claude.json` (T109),
 * e.g. `~/.claude.json for this project: MCP servers db, docs; .mcp.json servers approved:
 * github`; `null` when the setup has none.
 */
export function claudeJsonProjectNote(files: readonly CollectedFile[]): string | null {
  const file = files.find((entry) => entry.path === CLAUDE_JSON_PROJECT_BUNDLE_PATH);
  const items = file === undefined ? [] : projectPartItems(file);
  return items.length === 0 ? null : `~/.claude.json for this project: ${items.join('; ')}`;
}

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
  return { merged: Object.fromEntries(merged), unchanged };
}

/** The `.mcp.json` choice lists of a project's entry, each with the other one. */
const CHOICE_LISTS = [
  ['enabledMcpjsonServers', 'disabledMcpjsonServers'],
  ['disabledMcpjsonServers', 'enabledMcpjsonServers'],
] as const;

/**
 * A project's entry with the incoming part merged in (T109): servers by name and each
 * `.mcp.json` choice by server name (incoming wins, so a server approved there is no longer
 * rejected here); every other key of the entry (trust, history) stays as it is.
 */
function mergeProjectEntry(before: Record<string, unknown>, incoming: Record<string, unknown>) {
  const entry = new Map(Object.entries(before));
  const servers = incoming[CLAUDE_JSON_MCP_KEY];
  if (isJsonObject(servers)) {
    const here = entry.get(CLAUDE_JSON_MCP_KEY);
    entry.set(
      CLAUDE_JSON_MCP_KEY,
      Object.fromEntries([
        ...Object.entries(isJsonObject(here) ? here : {}),
        ...Object.entries(servers),
      ]),
    );
  }
  for (const [list, other] of CHOICE_LISTS) {
    const names = strings(incoming[list]);
    if (names.length === 0) continue;
    entry.set(list, [...new Set([...strings(entry.get(list)), ...names])]);
    if (entry.has(other)) {
      entry.set(
        other,
        strings(entry.get(other)).filter((name) => !names.includes(name)),
      );
    }
  }
  return Object.fromEntries(entry);
}

/** One part of `~/.claude.json` a pulled file goes into: the top level or a project's entry. */
interface ClaudeJsonPart {
  /** The keys restored there; any other is left out with a warning. */
  readonly keys: ReadonlySet<string>;
  /** What the warnings say is restored there, and what a later pull would add. */
  readonly what: string;
  readonly added: string;
  /** The whole file with `incoming` merged in, and whether that changes nothing. */
  merge(
    current: Record<string, unknown>,
    incoming: Record<string, unknown>,
  ): { merged: Record<string, unknown>; unchanged: boolean };
}

const TOP_LEVEL: ClaudeJsonPart = {
  keys: new Set([CLAUDE_JSON_MCP_KEY, ...CLAUDE_JSON_PREFERENCE_KEYS]),
  what: 'MCP servers and preferences',
  added: 'your MCP servers and preferences',
  merge: mergeInto,
};

/** The entry of `projectDir` in `projects`, made when missing (T109). */
function projectPart(projectDir: string, platform: NodeJS.Platform): ClaudeJsonPart {
  return {
    keys: new Set(CLAUDE_JSON_PROJECT_KEYS),
    what: "this project's MCP servers and .mcp.json choices",
    added: "this project's MCP servers and .mcp.json choices",
    merge(current, incoming) {
      const projects = isJsonObject(current['projects']) ? current['projects'] : {};
      const key = projectKeyOf(projects, projectDir, platform);
      const before = isJsonObject(projects[key]) ? projects[key] : {};
      const entry = mergeProjectEntry(before, incoming);
      const merged = Object.fromEntries([
        ...Object.entries(current),
        ['projects', Object.fromEntries([...Object.entries(projects), [key, entry]])],
      ]);
      return { merged, unchanged: JSON.stringify(entry) === JSON.stringify(before) };
    },
  };
}

/** The keys of a pulled part of `~/.claude.json` that are restored, and the ones left out. */
function claudeJsonKeys(file: CollectedFile, part: ClaudeJsonPart) {
  const parsed = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(new TextDecoder().decode(file.content)));
  const incoming = Object.fromEntries(Object.entries(parsed).filter(([key]) => part.keys.has(key)));
  const ignored = Object.keys(parsed).filter((key) => !part.keys.has(key));
  return { incoming, ignored };
}

/**
 * Only the keys push saves are taken (T43): the MCP servers and the preference keys, and for
 * a project its local MCP servers and `.mcp.json` choices (T109). Anything else, such as
 * folder trust, history or account state, is left out.
 */
export function createClaudeJsonMerge(options: ClaudeJsonMergeOptions): ClaudeJsonMerge {
  const { claudeJsonFile } = options;

  /**
   * Where `file` goes: a project's part into the entry of the target's repository, which
   * Claude Code reads for every folder in it (BUG-02).
   */
  const partOf = async (file: CollectedFile, target: ScopeTarget = { kind: 'global' }) =>
    file.path === CLAUDE_JSON_PROJECT_BUNDLE_PATH && target.kind === 'project'
      ? projectPart(await repositoryRoot(target.projectDir, options.platform), options.platform)
      : TOP_LEVEL;

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
    async change(file, target) {
      try {
        const part = await partOf(file, target);
        const keys = claudeJsonKeys(file, part).incoming;
        if (Object.keys(keys).length === 0) return 'none';
        const { existing, current } = await readClaudeJson();
        if (existing === 'folder') return 'none';
        if (existing === null) return 'new';
        return part.merge(current, keys).unchanged ? 'none' : 'merge';
      } catch {
        // A file that cannot be read is reported by the restore itself.
        return 'none';
      }
    },

    async merge(file, onConflict, report, leave, target) {
      const part = await partOf(file, target);
      const { incoming, ignored } = claudeJsonKeys(file, part);
      if (ignored.length > 0) {
        report.warnings.push(
          `Left out of ${claudeJsonFile}: ${ignored.map((key) => JSON.stringify(key)).join(', ')} (only ${part.what} are restored there).`,
        );
      }
      if (Object.keys(incoming).length === 0) return;

      const before = await readClaudeJson();
      if (before.existing === 'folder') {
        report.skipped.push(file.path);
        return;
      }
      if (before.existing !== null) {
        if (part.merge(before.current, incoming).unchanged) return;
        const choice = await onConflict(file.path, claudeJsonQuestion(file));
        if (choice === 'skip') {
          report.skipped.push(file.path);
          return;
        }
      }
      // Asked in the plan (T61): skipped there, or open again now that nobody can be asked.
      if (leave || (await options.isClaudeRunning())) {
        report.skipped.push(file.path);
        report.warnings.push(
          `${claudeJsonFile} was left as it is because Claude Code or the Claude app was running; pull again later to add ${part.added}.`,
        );
        return;
      }
      // Read again now that Claude Code is closed: it may have saved the file meanwhile (T43).
      const { existing, current } = await readClaudeJson();
      if (existing === 'folder') {
        report.skipped.push(file.path);
        return;
      }
      const { merged, unchanged } = part.merge(current, incoming);
      if (existing !== null && unchanged) return;
      const content = new TextEncoder().encode(`${JSON.stringify(merged, null, 2)}\n`);
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
