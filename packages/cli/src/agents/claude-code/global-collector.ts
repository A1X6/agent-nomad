import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import { BACKUP_MARKER, INCOMING_MARKER } from '@agentnomad/core';
import { BundlePathSchema } from '@agentnomad/contracts';
import * as z from 'zod';

import type { CollectedFile, CollectOptions, Collector, ScopeTarget } from '../adapter.ts';
import {
  CLAUDE_JSON_BUNDLE_PATH,
  CLAUDE_JSON_MCP_KEY,
  CLAUDE_JSON_PREFERENCE_KEYS,
  GLOBAL_FILES,
  GLOBAL_FOLDERS,
  GLOBAL_MEMORY_FOLDERS,
  HOME_SCRIPTS_PREFIX,
  PACKAGE_RUNNERS,
  PROGRAMS_BUNDLE_PATH,
  RUNTIME_COMMANDS,
  NEVER_SYNCED,
  SCRIPT_EXTENSIONS,
  SENSITIVE_HOME_DIRS,
  SKIPPED_NAMES,
  TOOL_CONFIG_FILES,
} from './global-paths.ts';
import type { ProgramInfo, ProgramLocator } from './programs.ts';

export interface GlobalCollectorOptions {
  /** Claude Code's base folder, from the detector (`~/.claude` or `CLAUDE_CONFIG_DIR`). */
  readonly baseDir: string;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
  /** Whether `CLAUDE_CONFIG_DIR` is set: `.claude.json` then lives in the base folder. */
  readonly customConfigDir: boolean;
  /** Looks up programs hooks and the status line run; without it none are recorded. */
  readonly findProgram?: ProgramLocator;
}

/** `~/.claude.json` could not be read as JSON (e.g. Claude Code was writing it). */
export class ClaudeJsonError extends Error {
  constructor(path: string, options?: ErrorOptions) {
    super(`Could not read ${path}. If Claude Code is running, try again in a moment.`, options);
    this.name = 'ClaudeJsonError';
  }
}

const isMarkerCopy = (name: string) =>
  name.includes(BACKUP_MARKER) || name.includes(INCOMING_MARKER);

/** True when `bundlePath` is a never-synced entry or inside one. */
const isNeverSynced = (bundlePath: string) =>
  NEVER_SYNCED.some((entry) => bundlePath === entry || bundlePath.startsWith(`${entry}/`));

const HookCommandSchema = z.looseObject({ command: z.string().optional() });
const SettingsSchema = z.looseObject({
  hooks: z
    .record(
      z.string(),
      z.array(z.looseObject({ hooks: z.array(HookCommandSchema).optional() })).optional(),
    )
    .optional(),
  statusLine: HookCommandSchema.optional(),
});

/** Commands in `settings.json` that run files: every hook, and the status line. */
export function commandsInSettings(settingsJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson);
  } catch {
    return [];
  }
  const settings = SettingsSchema.safeParse(parsed);
  if (!settings.success) return [];
  const commands = Object.values(settings.data.hooks ?? {}).flatMap((groups) =>
    (groups ?? []).flatMap((group) => (group.hooks ?? []).map((hook) => hook.command)),
  );
  commands.push(settings.data.statusLine?.command);
  return commands.filter((command): command is string => command !== undefined);
}

/** Words of a command line, with surrounding quotes removed. */
function commandWords(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
}

/** `ccstatusline@2.2.22` → `ccstatusline`; `@scope/tool@1` → `@scope/tool`. */
const withoutVersion = (spec: string) => spec.replace(/(?<=.)@[^/]*$/, '');

/**
 * The program a command starts, e.g. `ccstatusline`, or `ccstatusline` for
 * `npx -y ccstatusline@latest` (`runner`: nothing to install). `null` for a script path,
 * a shell or a runtime.
 */
export function programOf(command: string): { name: string; runner: boolean } | null {
  const words = commandWords(command);
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1;
  const first = words[index];
  if (first === undefined || /[\\/]/.test(first)) return null;
  const base = first.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (PACKAGE_RUNNERS.has(base)) {
    const spec = words.slice(index + 1).find((word) => !word.startsWith('-'));
    return spec === undefined ? null : { name: withoutVersion(spec), runner: true };
  }
  if (RUNTIME_COMMANDS.has(base) || !/^[A-Za-z0-9._-]+$/.test(first)) return null;
  return { name: base, runner: false };
}

/** A Claude Code global collector for one PC (T25). Project scope is T26. */
export function createClaudeCodeGlobalCollector(options: GlobalCollectorOptions): Collector {
  const path = options.platform === 'win32' ? win32 : posix;
  const { baseDir, homedir } = options;
  const same = (a: string, b: string) =>
    options.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

  /** Relative path from `folder` in forward slashes, or `null` when `file` is outside it. */
  function relativeInside(folder: string, file: string): string | null {
    const relative = path.relative(folder, file);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const bundlePath = relative.split(path.sep).join('/');
    return BundlePathSchema.safeParse(bundlePath).success ? bundlePath : null;
  }

  async function fileEntry(nativePath: string, bundlePath: string): Promise<CollectedFile> {
    const [content, info] = await Promise.all([readFile(nativePath), stat(nativePath)]);
    return {
      path: bundlePath,
      content: new Uint8Array(content),
      // Only macOS and Linux record "may run"; T27 decides per OS on restore.
      executable: options.platform !== 'win32' && (info.mode & 0o111) !== 0,
    };
  }

  /** Every file under a synced folder, following links once and skipping clutter. */
  async function walk(
    folder: string,
    bundlePrefix: string,
    seen: Set<string>,
  ): Promise<CollectedFile[]> {
    let real: string;
    try {
      real = await realpath(folder);
    } catch {
      return [];
    }
    if (seen.has(real)) return [];
    seen.add(real);

    const files: CollectedFile[] = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (SKIPPED_NAMES.has(entry.name) || isMarkerCopy(entry.name)) continue;
      const bundlePath = `${bundlePrefix}/${entry.name}`;
      if (isNeverSynced(bundlePath) || !BundlePathSchema.safeParse(bundlePath).success) continue;
      const nativePath = path.join(folder, entry.name);
      // stat follows symbolic links, so linked skills folders (e.g. from a dotfiles repo) come along.
      const info = await stat(nativePath).catch(() => null);
      if (info?.isDirectory()) files.push(...(await walk(nativePath, bundlePath, seen)));
      else if (info?.isFile()) files.push(await fileEntry(nativePath, bundlePath));
    }
    return files;
  }

  async function readIfFile(nativePath: string): Promise<CollectedFile | null> {
    const info = await stat(nativePath).catch(() => null);
    return info?.isFile() ? fileEntry(nativePath, '') : null;
  }

  /** Expands `~`, `$HOME`, `%USERPROFILE%` and `$CLAUDE_CONFIG_DIR` at the start of a word. */
  function expand(word: string): string | null {
    const home = /^(~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)(?=[\\/]|$)/i;
    const config = /^(\$CLAUDE_CONFIG_DIR|\$\{CLAUDE_CONFIG_DIR\}|%CLAUDE_CONFIG_DIR%)(?=[\\/]|$)/i;
    let expanded = word.replace(home, () => homedir).replace(config, () => baseDir);
    if (!path.isAbsolute(expanded)) return null;
    expanded = path.normalize(expanded);
    return expanded;
  }

  function isSensitive(relativeToHome: string): boolean {
    return SENSITIVE_HOME_DIRS.some(
      (dir) =>
        same(relativeToHome, dir) ||
        relativeToHome.toLowerCase().startsWith(`${dir.toLowerCase()}/`),
    );
  }

  /** Script files that hooks and the status line run, if they are in the home folder. */
  async function hookScripts(settingsJson: string): Promise<CollectedFile[]> {
    const files: CollectedFile[] = [];
    for (const command of commandsInSettings(settingsJson)) {
      for (const word of commandWords(command)) {
        const nativePath = expand(word);
        if (nativePath === null) continue;
        if (!SCRIPT_EXTENSIONS.has(path.extname(nativePath).toLowerCase())) continue;

        const inBase = relativeInside(baseDir, nativePath);
        const inHome = relativeInside(homedir, nativePath);
        let bundlePath: string;
        if (inBase !== null) {
          if (isNeverSynced(inBase)) continue;
          bundlePath = inBase;
        } else if (inHome !== null && !isSensitive(inHome)) {
          bundlePath = HOME_SCRIPTS_PREFIX + inHome;
        } else {
          continue;
        }
        const file = await readIfFile(nativePath);
        if (file) files.push({ ...file, path: bundlePath });
      }
    }
    return files;
  }

  /**
   * For each program the commands run: its known settings file (e.g. ccstatusline's) and,
   * unless it runs through npx, what it is and how it was installed, so pull can check it.
   */
  async function programs(settingsJson: string): Promise<CollectedFile[]> {
    const files: CollectedFile[] = [];
    const found = new Map<string, ProgramInfo>();
    for (const command of commandsInSettings(settingsJson)) {
      const program = programOf(command);
      if (program === null) continue;
      for (const relative of TOOL_CONFIG_FILES[program.name] ?? []) {
        const file = await readIfFile(path.join(homedir, ...relative.split('/')));
        if (file) files.push({ ...file, path: HOME_SCRIPTS_PREFIX + relative });
      }
      if (!program.runner && !found.has(program.name)) {
        const info = (await options.findProgram?.(program.name)) ?? {
          command: program.name,
          npm: null,
        };
        found.set(program.name, info);
      }
    }
    if (found.size > 0 && options.findProgram) {
      const list = [...found.values()].sort((a, b) => a.command.localeCompare(b.command));
      files.push({
        path: PROGRAMS_BUNDLE_PATH,
        content: new TextEncoder().encode(`${JSON.stringify({ programs: list }, null, 2)}
`),
        executable: false,
      });
    }
    return files;
  }

  /** MCP servers and preference keys from `~/.claude.json`; nothing else in it. */
  async function claudeJson(): Promise<CollectedFile | null> {
    const file = options.customConfigDir
      ? path.join(baseDir, '.claude.json')
      : path.join(homedir, '.claude.json');
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
    const all = z.record(z.string(), z.unknown()).safeParse(parsed);
    if (!all.success) throw new ClaudeJsonError(file, { cause: all.error });

    const selected: Record<string, unknown> = {};
    const mcpServers = all.data[CLAUDE_JSON_MCP_KEY];
    if (mcpServers && typeof mcpServers === 'object' && Object.keys(mcpServers).length > 0) {
      selected[CLAUDE_JSON_MCP_KEY] = mcpServers;
    }
    for (const key of CLAUDE_JSON_PREFERENCE_KEYS) {
      if (all.data[key] !== undefined) selected[key] = all.data[key];
    }
    if (Object.keys(selected).length === 0) return null;
    return {
      path: CLAUDE_JSON_BUNDLE_PATH,
      content: new TextEncoder().encode(`${JSON.stringify(selected, null, 2)}\n`),
      executable: false,
    };
  }

  return {
    async collect(target: ScopeTarget, collectOptions: CollectOptions) {
      if (target.kind !== 'global') {
        throw new Error('The global collector only collects the global setup');
      }
      const found: CollectedFile[] = [];

      for (const name of GLOBAL_FILES) {
        const file = await readIfFile(path.join(baseDir, name));
        if (file) found.push({ ...file, path: name });
      }
      const seen = new Set<string>();
      const folders = collectOptions.includeMemory
        ? [...GLOBAL_FOLDERS, ...GLOBAL_MEMORY_FOLDERS]
        : GLOBAL_FOLDERS;
      for (const name of folders) {
        found.push(...(await walk(path.join(baseDir, name), name, seen)));
      }

      const settings = found.find((file) => file.path === 'settings.json');
      if (settings) {
        const text = new TextDecoder().decode(settings.content);
        found.push(...(await hookScripts(text)), ...(await programs(text)));
      }

      const selected = await claudeJson();
      if (selected) found.push(selected);

      // One entry per path (a hook may name a file already in a synced folder), sorted.
      const byPath = new Map(found.map((file) => [file.path, file]));
      return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },
  };
}
