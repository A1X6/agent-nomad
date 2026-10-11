import { printableLine } from '../../ui/printable.ts';
import { RESERVED_DIR } from '../adapter.ts';
import { underFolder } from '../shared/bundle-paths.ts';
import { pathsOf } from '../shared/detector-system.ts';
import { bundlePathInside } from '../shared/file-gathering.ts';
import {
  GLOBAL_REFUSED,
  HOME_SCRIPTS_PREFIX,
  extensionOf,
  homePathProblem,
} from './global-paths.ts';
import { PROJECT_NEVER_SYNCED } from './project-paths.ts';

/*
 * `@path` imports in Claude Code's memory files (T111), as the 2.1.296 program reads them
 * (function `UZn` and its loader `YU`): a `@` at the start of the text or after white space,
 * the path up to the next white space (`\ ` keeps a space), cut at `#`. Code spans, fenced
 * code blocks, HTML comments and the frontmatter are skipped. The program then follows
 * imports in imported files up to four hops (`$nr=5` files deep, counting the first one).
 */

/** How many imports deep Claude Code follows, from the memory file itself. */
export const MAX_IMPORT_HOPS = 4;

/**
 * Imported files push saves and pull writes: text documents. The program loads any text file
 * (code and scripts too, and files without an extension), but pull writes an imported file
 * without a review, so a script, code or an extension-less file (`.bashrc`, a git hook) is
 * never taken this way: push names it instead.
 */
const IMPORT_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.txt',
  '.text',
  '.rst',
  '.adoc',
  '.asciidoc',
  '.org',
  '.tex',
  '.latex',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  '.html',
  '.htm',
  '.ini',
  '.cfg',
  '.conf',
  '.properties',
  '.graphql',
  '.gql',
  '.proto',
  '.sql',
  '.log',
  '.diff',
  '.patch',
]);

/** Memory files of a global setup whose imports Claude Code follows. */
export const isGlobalMemoryFile = (bundlePath: string): boolean =>
  bundlePath === 'CLAUDE.md' || (bundlePath.startsWith('rules/') && bundlePath.endsWith('.md'));

/** The same for a project setup. */
const PROJECT_MEMORY_FILES: readonly string[] = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  '.claude/CLAUDE.md',
];
export const isProjectMemoryFile = (bundlePath: string): boolean =>
  PROJECT_MEMORY_FILES.includes(bundlePath) ||
  (bundlePath.startsWith('.claude/rules/') && bundlePath.endsWith('.md'));

/** One import as a memory file writes it. */
export interface ImportLine {
  /** 1-based. */
  readonly line: number;
  /** As written, from the `@`. */
  readonly written: string;
  /** The path it names: cut at `#`, `\ ` read as a space. */
  readonly path: string;
}

/** The program's import pattern, applied to the text outside code. */
const IMPORT = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;

/** `text` with each character but line breaks turned into a space (positions are kept). */
const blank = (text: string) => text.replace(/[^\r\n]/g, ' ');

/** The frontmatter, which Claude Code reads apart from the instructions. */
const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * `text` with fenced code blocks blanked. As in CommonMark, a fence opens with at most three
 * spaces before it and closes with the same character, at least as many and nothing after.
 * A closing fence at any indentation counts, so a block is never taken as longer than it is.
 */
function withoutFences(text: string): string {
  const lines = text.split('\n');
  let open: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (open === null) {
      const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      const marks = fence?.[1];
      if (marks === undefined || (marks.startsWith('`') && fence?.[2]?.includes('`'))) continue;
      open = marks;
    } else {
      const fence = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (fence !== undefined && fence[0] === open[0] && fence.length >= open.length) open = null;
    }
    lines[index] = blank(line);
  }
  return lines.join('\n');
}

/**
 * `text` with code spans and HTML comments blanked. A code span closes with a run of as many
 * backticks before the paragraph ends; an escaped backtick opens none. An unclosed span or
 * comment is plain text, so its imports still count.
 */
function withoutInlineCode(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '\\' && index + 1 < text.length) {
      out += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4);
      const stop = end === -1 ? index + 4 : end + 3;
      out += end === -1 ? text.slice(index, stop) : blank(text.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === '`') {
      const run = /^`+/.exec(text.slice(index))?.[0] ?? '`';
      const paragraphEnd = text.slice(index).search(/\n[ \t]*\r?\n/);
      const rest = text.slice(
        index + run.length,
        paragraphEnd === -1 ? text.length : index + paragraphEnd,
      );
      const close = new RegExp(`(?<!\`)${run}(?!\`)`).exec(rest);
      const stop =
        close === null ? index + run.length : index + run.length + close.index + run.length;
      out += close === null ? run : blank(text.slice(index, stop));
      index = stop;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Whether the program takes `path` as an import (not `@/`, `@@x`, `@(x)` or a mention). */
function isImportPath(path: string): boolean {
  // Network paths are never read: looking one up can contact the host it names.
  if (/^(\/\/|\\\\)/.test(path)) return false;
  return (
    path.startsWith('./') ||
    path.startsWith('~/') ||
    (path.startsWith('/') && path !== '/') ||
    (!path.startsWith('@') && !/^[#%^&*()]+/.test(path) && /^[a-zA-Z0-9._-]/.test(path))
  );
}

/** The imports `text` (a memory file or an imported one) makes, in order. */
export function importsIn(text: string): ImportLine[] {
  const visible = withoutInlineCode(withoutFences(text.replace(FRONTMATTER, blank)));
  const found: ImportLine[] = [];
  for (const match of visible.matchAll(IMPORT)) {
    const written = match[1] ?? '';
    const hash = written.indexOf('#');
    const path = (hash === -1 ? written : written.slice(0, hash)).replaceAll('\\ ', ' ');
    if (path === '' || !isImportPath(path)) continue;
    const at = match.index + match[0].indexOf('@');
    const line = visible.slice(0, at).split('\n').length;
    found.push({ line, written: `@${written}`, path });
  }
  return found;
}

export interface ImportPathContext {
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
}

/**
 * The file an import names, from the file that makes it: `~/` is the home folder, a relative
 * path starts at the importing file's folder, and on Windows `/c/x` is `C:\x`, as the program
 * resolves it.
 */
export function resolveImport(
  importPath: string,
  fromFile: string,
  context: ImportPathContext,
): string {
  const path = pathsOf(context.platform);
  const trimmed = importPath.trim();
  if (trimmed.startsWith('~/')) return path.join(context.homedir, trimmed.slice(2));
  const drive = /^\/([a-z])\//i.exec(trimmed);
  const native =
    context.platform === 'win32' && drive?.[1] !== undefined
      ? `${drive[1]}:/${trimmed.slice(3)}`
      : trimmed;
  return path.isAbsolute(native)
    ? path.normalize(native)
    : path.resolve(path.dirname(fromFile), native);
}

/** Where an imported file goes in the bundle, or why push leaves it out. */
export type ImportPlace =
  | { readonly kind: 'bundle'; readonly bundlePath: string }
  | { readonly kind: 'refused'; readonly reason: string };

const refused = (reason: string): ImportPlace => ({ kind: 'refused', reason });

const NOT_A_DOCUMENT =
  'agentnomad saves an imported file only when it is a text document, never code, a script or a file without an extension';
const NEVER_SYNCED_FOLDER = 'it is in a folder agentnomad never syncs';

/** Compared without case, as pull refuses them (Windows and macOS ignore it). */
const under = (path: string, folder: string) => underFolder(path, folder, { ignoreCase: true });

export interface GlobalImportContext extends ImportPathContext {
  /** Claude Code's base folder (`~/.claude` or `CLAUDE_CONFIG_DIR`). */
  readonly baseDir: string;
}

/**
 * Where a file a global memory file imports goes, as the hook scripts do (T25): in the base
 * folder at its own path (not in never-synced folders nor Claude Code's state), elsewhere in
 * the home under `.agentnomad/home/` (never in folders for keys and logins, nor in ones whose
 * files run by themselves). Outside the home it cannot be placed on another PC.
 */
export function globalImportPlace(nativePath: string, context: GlobalImportContext): ImportPlace {
  const path = pathsOf(context.platform);
  if (!IMPORT_DOCUMENT_EXTENSIONS.has(extensionOf(nativePath))) return refused(NOT_A_DOCUMENT);
  const inBase = bundlePathInside(path, context.baseDir, nativePath);
  if (inBase !== null) {
    const refusedHere = [RESERVED_DIR, ...GLOBAL_REFUSED].some((entry) => under(inBase, entry));
    return refusedHere ? refused(NEVER_SYNCED_FOLDER) : { kind: 'bundle', bundlePath: inBase };
  }
  const inHome = bundlePathInside(path, context.homedir, nativePath);
  if (inHome === null) return refused('it is outside the home folder');
  const problem = homePathProblem(inHome);
  return problem === null
    ? { kind: 'bundle', bundlePath: HOME_SCRIPTS_PREFIX + inHome }
    : refused(`it is in ${problem}`);
}

export interface ProjectImportContext {
  readonly projectDir: string;
  readonly platform: NodeJS.Platform;
}

/** Where a file a project memory file imports goes: at its path in the project, if inside. */
export function projectImportPlace(nativePath: string, context: ProjectImportContext): ImportPlace {
  const path = pathsOf(context.platform);
  if (!IMPORT_DOCUMENT_EXTENSIONS.has(extensionOf(nativePath))) return refused(NOT_A_DOCUMENT);
  const inProject = bundlePathInside(path, context.projectDir, nativePath);
  if (inProject === null) return refused('it is outside the project');
  return PROJECT_NEVER_SYNCED.some((entry) => under(inProject, entry))
    ? refused(NEVER_SYNCED_FOLDER)
    : { kind: 'bundle', bundlePath: inProject };
}

/** A memory file of the setup, whose imports are followed. */
export interface MemoryFile {
  readonly nativePath: string;
  readonly bundlePath: string;
  readonly text: string;
}

/** How imports are followed: push reads this PC's files, pull reads the bundle. */
export interface ImportSource {
  /** Where an imported file goes, or why it is left out. */
  place(nativePath: string): ImportPlace;
  /** The text of a placed file, or `null` when there is none (or it cannot be taken). */
  read(nativePath: string, bundlePath: string): Promise<string | null>;
  /** Whether a left-out file exists: one that does not is not worth a warning. */
  isFile(nativePath: string): Promise<boolean>;
}

/** Who imports a file, and how. */
interface ImportedBy {
  readonly nativePath: string;
  readonly importer: string;
  readonly line: ImportLine;
}

export interface ImportsFound {
  /** Every file the memory files import, directly or through other imports, once each. */
  readonly files: readonly (ImportedBy & { readonly bundlePath: string })[];
  /** Imported files that exist but cannot be taken, with why. */
  readonly skipped: readonly (ImportedBy & { readonly reason: string })[];
}

/**
 * Follows the imports of `memoryFiles` as Claude Code does: depth first, each file once, up
 * to `MAX_IMPORT_HOPS` deep. A file that does not exist is skipped without a word, as the
 * program skips it; one that exists and cannot be taken is reported.
 */
export async function followImports(
  memoryFiles: readonly MemoryFile[],
  source: ImportSource,
  context: ImportPathContext,
): Promise<ImportsFound> {
  const seen = new Set(memoryFiles.map((file) => file.nativePath));
  const files: (ImportedBy & { bundlePath: string })[] = [];
  const skipped: (ImportedBy & { reason: string })[] = [];

  async function follow(importer: string, text: string, depth: number): Promise<void> {
    if (depth > MAX_IMPORT_HOPS) return;
    for (const line of importsIn(text)) {
      const nativePath = resolveImport(line.path, importer, context);
      if (seen.has(nativePath)) continue;
      seen.add(nativePath);
      const by = { nativePath, importer, line };
      const place = source.place(nativePath);
      if (place.kind === 'refused') {
        if (await source.isFile(nativePath)) skipped.push({ ...by, reason: place.reason });
        continue;
      }
      const imported = await source.read(nativePath, place.bundlePath);
      if (imported === null) continue;
      files.push({ ...by, bundlePath: place.bundlePath });
      await follow(nativePath, imported, depth + 1);
    }
  }

  for (const file of memoryFiles) await follow(file.nativePath, file.text, 1);
  return { files, skipped };
}

/** A path as push shows it: from `~` when it is in the home folder. */
export function shownImportPath(nativePath: string, context: ImportPathContext): string {
  const inHome = bundlePathInside(pathsOf(context.platform), context.homedir, nativePath);
  return inHome === null ? nativePath : `~/${inHome}`;
}

/** Why push left out an imported file: who imports it, on which line, and the reason. */
export const skippedImportReason = (
  skipped: ImportsFound['skipped'][number],
  context: ImportPathContext,
): string =>
  `${printableLine(shownImportPath(skipped.importer, context))} imports it on line ${String(skipped.line.line)} (${printableLine(skipped.line.written)}), but ${skipped.reason}`;
