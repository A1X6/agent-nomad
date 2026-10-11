import { readdir, readFile } from 'node:fs/promises';

import { BACKUP_MARKER, INCOMING_MARKER } from '@agentnomad/core';

import { TEMP_MARKER } from '../../system/files.ts';
import { RESERVED_DIR, type ScopeTarget } from '../adapter.ts';
import { pathsOf } from '../shared/detector-system.ts';
import {
  GLOBAL_MEMORY_FILES,
  globalImportPlace,
  importsOf,
  isMemoryFile,
  PROJECT_MEMORY_FILES,
  projectImportPlace,
  type ImportPathContext,
  type ImportPlace,
  type MemoryFileNames,
} from './claude-md-imports.ts';
import {
  GLOBAL_FILES,
  GLOBAL_FOLDERS,
  GLOBAL_KNOWN_STATE,
  GLOBAL_MEMORY_FOLDERS,
  GLOBAL_SETTINGS_FILES,
  IGNORED_COPY_PATTERNS,
  NEVER_SYNCED,
} from './global-paths.ts';
import { hookScripts, projectHookScripts } from './hook-scripts.ts';
import {
  PROJECT_CLAUDE_FILES,
  PROJECT_CLAUDE_FOLDERS,
  PROJECT_KNOWN_STATE,
  PROJECT_MEMORY_FOLDERS,
  PROJECT_NEVER_SYNCED,
  PROJECT_SETTINGS_FILES,
} from './project-paths.ts';

export interface UnknownFilesInput {
  /** Claude Code's base folder (`~/.claude` or `CLAUDE_CONFIG_DIR`). */
  readonly baseDir: string;
  readonly platform: NodeJS.Platform;
  /** The home folder, to find the scripts the hooks and status line run (T49). */
  readonly homedir?: string;
}

/**
 * Top-level names in the base folder that hold a script the global hooks or status line
 * run (T49): push saves those scripts by that route (T25), so such a folder, e.g. `bin/`,
 * is not unknown (`hooks/` is synced whole, T112). A folder with no such script is still reported.
 */
async function hookScriptNames(input: UnknownFilesInput): Promise<string[]> {
  if (input.homedir === undefined) return [];
  const path = pathsOf(input.platform);
  const names: string[] = [];
  for (const file of GLOBAL_SETTINGS_FILES) {
    const settings = await readFile(path.join(input.baseDir, file), 'utf8').catch(() => null);
    if (settings === null) continue;
    names.push(
      ...hookScripts(settings, {
        homedir: input.homedir,
        baseDir: input.baseDir,
        platform: input.platform,
      })
        .map((script) => script.bundlePath)
        .filter((bundlePath) => !bundlePath.startsWith(`${RESERVED_DIR}/`))
        .map(topLevel),
    );
  }
  return names;
}

/**
 * The bundle paths of the files the memory files `names` of the setup in `folder` import on
 * this PC (T111), as push follows them.
 */
async function importedOnThisPc(
  folder: string,
  names: MemoryFileNames,
  place: (nativePath: string) => ImportPlace,
  context: ImportPathContext,
): Promise<string[]> {
  const path = pathsOf(context.platform);
  const rulesDir = path.join(folder, ...names.rules.split('/'));
  const rules = await readdir(rulesDir, { recursive: true }).catch(() => []);
  const memoryFiles = [];
  for (const bundlePath of [
    ...names.files,
    ...rules.map((rule) => names.rules + rule.split(path.sep).join('/')),
  ]) {
    if (!isMemoryFile(names, bundlePath)) continue;
    const content = await readFile(path.join(folder, ...bundlePath.split('/'))).catch(() => null);
    if (content !== null) memoryFiles.push({ path: bundlePath, content });
  }
  const { files } = await importsOf(
    folder,
    names,
    memoryFiles,
    {
      place,
      read: (nativePath) => readFile(nativePath, 'utf8').catch(() => null),
      isFile: () => Promise.resolve(false),
    },
    context,
  );
  return files.map((file) => file.bundlePath);
}

/**
 * Top-level names in the base folder that hold a file `CLAUDE.md` or the rules import (T111):
 * push saves those files by that route, so such a folder is not unknown either.
 */
async function importedNames(input: UnknownFilesInput): Promise<string[]> {
  const { homedir } = input;
  if (homedir === undefined) return [];
  const context = { homedir, baseDir: input.baseDir, platform: input.platform };
  const files = await importedOnThisPc(
    input.baseDir,
    GLOBAL_MEMORY_FILES,
    (nativePath) => globalImportPlace(nativePath, context),
    context,
  );
  return files.filter((bundlePath) => !bundlePath.startsWith(`${RESERVED_DIR}/`)).map(topLevel);
}

/**
 * Names in a project's `.claude/` that hold a script its hooks or status line run (T26) or a
 * file its memory files import (T111): push saves those by that route, so such a folder is
 * not unknown, as for the global setup (UX-04).
 */
async function projectSavedNames(projectDir: string, input: UnknownFilesInput) {
  const path = pathsOf(input.platform);
  const context = { projectDir, platform: input.platform };
  const read = (bundlePath: string) =>
    readFile(path.join(projectDir, ...bundlePath.split('/')), 'utf8').catch(() => null);
  const saved: string[] = [];
  for (const file of PROJECT_SETTINGS_FILES) {
    const settings = await read(file);
    if (settings !== null) {
      saved.push(...projectHookScripts(settings, context).map((script) => script.bundlePath));
    }
  }
  const { homedir } = input;
  if (homedir !== undefined) {
    saved.push(
      ...(await importedOnThisPc(
        projectDir,
        PROJECT_MEMORY_FILES,
        (nativePath) => projectImportPlace(nativePath, context),
        { homedir, platform: input.platform },
      )),
    );
  }
  return saved
    .filter((bundlePath) => bundlePath.startsWith('.claude/'))
    .map((bundlePath) => topLevel(bundlePath.slice('.claude/'.length)));
}

/** The first part of a list entry: `skills/synced` → `skills`. */
const topLevel = (entry: string) => entry.split('/')[0] ?? entry;

/** Names that are copies or temporary files, never worth reporting. */
function isCopy(name: string): boolean {
  return (
    name.includes(BACKUP_MARKER) ||
    name.includes(INCOMING_MARKER) ||
    name.includes(TEMP_MARKER) ||
    IGNORED_COPY_PATTERNS.some((pattern) => pattern.test(name))
  );
}

/**
 * Entries in Claude Code's folder that agentnomad does not know (T32): not synced, not a
 * known never-synced item, not known state. Push reports them, so nothing new that a Claude
 * Code update adds is ever skipped silently. `skills/synced/` is known (always skipped) and
 * never reported. Global: the base folder; project: the project's `.claude/` folder.
 * Folder names end in `/`.
 */
export async function findUnknownEntries(
  target: ScopeTarget,
  input: UnknownFilesInput,
): Promise<string[]> {
  const path = pathsOf(input.platform);
  const [folder, prefix, known] =
    target.kind === 'global'
      ? [
          input.baseDir,
          '',
          [
            ...GLOBAL_FILES,
            ...GLOBAL_FOLDERS,
            ...GLOBAL_MEMORY_FOLDERS,
            ...NEVER_SYNCED,
            ...GLOBAL_KNOWN_STATE,
          ].map(topLevel),
        ]
      : [
          path.join(target.projectDir, '.claude'),
          '.claude/',
          [
            ...PROJECT_CLAUDE_FILES,
            ...PROJECT_CLAUDE_FOLDERS,
            ...PROJECT_MEMORY_FOLDERS,
            ...PROJECT_KNOWN_STATE,
            ...PROJECT_NEVER_SYNCED.filter((entry) => entry.startsWith('.claude/')).map((entry) =>
              entry.slice('.claude/'.length),
            ),
          ].map(topLevel),
        ];

  const knownNames = new Set(known);
  if (target.kind === 'global') {
    // `.claude.json` sits in the base folder when CLAUDE_CONFIG_DIR is set; handled apart.
    knownNames.add('.claude.json');
    for (const name of await hookScriptNames(input)) knownNames.add(name);
    for (const name of await importedNames(input)) knownNames.add(name);
  } else {
    for (const name of await projectSavedNames(target.projectDir, input)) knownNames.add(name);
  }

  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => !knownNames.has(entry.name) && !isCopy(entry.name))
    .map((entry) => `${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`)
    .sort();
}
