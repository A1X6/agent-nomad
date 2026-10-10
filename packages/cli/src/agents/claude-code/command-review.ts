import { sameBytes } from '@agentnomad/contracts';
import * as z from 'zod';

import type { CollectedFile, ReviewedEntry, RunnableEntry } from '../adapter.ts';
import { LOADER_VARIABLE } from '../../env/loader-variables.ts';
import { JsonObjectSchema, parseJsonWith, valueOrNull } from '../../system/json.ts';
import { MCP_FILES, SETTINGS_FILES } from './env-files.ts';
import {
  commandsInSettings,
  commandText,
  commandWords,
  hookItems,
  pathWords,
} from './settings-commands.ts';
import {
  GLOBAL_SETTINGS_FILES,
  HOME_SCRIPTS_PREFIX,
  isScript,
  TOOL_CONFIG_FILES,
} from './global-paths.ts';
import { COMMAND_SETTINGS, isRedirectVariable } from './reviewed-settings.ts';
import { runnableInMarkdown } from './runnable-markdown.ts';

/*
 * Things in a Claude Code setup that run programs on this PC (T34, T44), as Claude Code's
 * docs describe them: hooks, the status line, settings that run a command, loader
 * environment variables, MCP servers, and skill, command and subagent files with commands
 * that run by themselves. Pull shows the new or changed ones and asks before writing them;
 * it reaches this review through the restorer (T61).
 */

/**
 * `permissions.defaultMode` values that let Claude act without asking (T56, Claude Code's
 * settings reference). `auto` and `bypassPermissions` take effect only from user settings;
 * `acceptEdits` from any settings file. `default`, `manual`, `plan` and `dontAsk` ask or deny.
 */
const LOOSENING_MODES: Readonly<
  Record<string, { readonly note: string; readonly userOnly: boolean } | undefined>
> = {
  bypassPermissions: { note: 'Claude asks nothing', userOnly: true },
  auto: { note: 'Claude acts without asking; a classifier checks its actions', userOnly: true },
  acceptEdits: {
    note: 'Claude edits files and runs mkdir, mv and the like without asking',
    userOnly: false,
  },
};

/**
 * Labels that many entries share (each hook, allow rule or directory is one entry): a new
 * one beside others is new, never a change of the others.
 */
const LIST_LABELS = /^(hook |setting permissions\.(allow|additionalDirectories)$)/;

/** Folders whose Markdown files are skills, custom commands or subagents. */
const MARKDOWN_FOLDERS = /^(\.claude\/)?(skills|commands|agents)\//;

const Command = z.looseObject({ command: z.string().optional() });

const parse = (file: CollectedFile) => valueOrNull(parseJsonWith(JsonObjectSchema, file.content));

/** JSON with sorted keys, so two copies of the same object compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Restored paths use forward slashes on Windows (T10), existing ones often backslashes. */
const slashes = (command: string) => command.replace(/\\/g, '/');

const entry = (file: string, label: string, command: string, identity = slashes(command)) => ({
  file,
  label,
  command,
  identity,
});

/**
 * A part of a file that cannot be read as Claude Code expects (SEC-01): shown as its JSON,
 * so pull still asks about it instead of leaving it out of the review.
 */
const unreadable = (file: string, label: string, value: unknown) =>
  entry(file, `${label} (unreadable)`, stable(value), stable(value));

/** An MCP server as shown: what runs or where it connects, plus what else it carries. */
function describeServer(server: Record<string, unknown>): string {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const args = Array.isArray(server['args']) ? server['args'].map(text) : [];
  const main =
    text(server['url']) || [text(server['command']), ...args].filter((part) => part).join(' ');
  const extras = [
    ...(typeof server['headersHelper'] === 'string'
      ? [`runs ${server['headersHelper']} for its headers`]
      : []),
    // Names only: values may be secrets.
    ...(typeof server['env'] === 'object' && server['env'] !== null
      ? [`env: ${Object.keys(server['env']).join(', ')}`]
      : []),
    ...(typeof server['headers'] === 'object' && server['headers'] !== null
      ? [`headers: ${Object.keys(server['headers']).join(', ')}`]
      : []),
  ];
  return extras.length > 0 ? `${main}  (${extras.join('; ')})` : main;
}

function settingsEntries(file: CollectedFile, json: Record<string, unknown>): RunnableEntry[] {
  const entries: RunnableEntry[] = [];
  // One hook at a time: a malformed one is shown as unreadable and hides no other (SEC-01).
  for (const item of hookItems(json['hooks'])) {
    if (!('hook' in item)) {
      const label = item.event === null ? 'hooks' : `hook ${item.event}`;
      entries.push(unreadable(file.path, label, item.unreadable));
      continue;
    }
    const { event, hook } = item;
    if (hook.command !== undefined) {
      const command = commandText(hook.command, hook.args);
      // Exec form is compared by its words (review 6 SEC-01): moving a text between one
      // argument (data) and a shell command line (run) is a change, even when they read alike.
      // The prefixes keep the two apart even for a shell command that is that JSON text.
      const identity =
        hook.args === undefined
          ? `shell ${slashes(command)}`
          : `exec ${stable({ command: slashes(hook.command), args: hook.args.map(slashes) })}`;
      entries.push(entry(file.path, `hook ${event}`, command, identity));
    } else if (hook.type === 'http' && hook.url !== undefined) {
      // Sends what the hook sees (tool input, prompts) to that address.
      entries.push(entry(file.path, `hook ${event} (sends data to)`, hook.url));
    }
  }
  const statusLine = Command.safeParse(json['statusLine']);
  if (statusLine.success && statusLine.data.command !== undefined) {
    entries.push(entry(file.path, 'status line', statusLine.data.command));
  }
  for (const key of COMMAND_SETTINGS) {
    const value = json[key];
    const nested = Command.safeParse(value);
    const command =
      typeof value === 'string' ? value : nested.success ? nested.data.command : undefined;
    if (command !== undefined) entries.push(entry(file.path, `setting ${key}`, command));
  }
  const env = JsonObjectSchema.safeParse(json['env']);
  for (const [name, value] of Object.entries(env.success ? env.data : {})) {
    // In a settings `env` block they reach Claude Code and every hook it starts. Redirect
    // variables send its requests elsewhere or choose what it runs commands with (T55).
    if (LOADER_VARIABLE.test(name) || isRedirectVariable(name)) {
      entries.push(entry(file.path, `setting env ${name}`, `${name}=${String(value)}`));
    }
  }
  // A starting mode that lets Claude act without asking, from the files it takes effect in.
  const permissions = JsonObjectSchema.safeParse(json['permissions']);
  const mode = permissions.success ? permissions.data['defaultMode'] : undefined;
  const loosening = typeof mode === 'string' ? LOOSENING_MODES[mode] : undefined;
  if (
    loosening !== undefined &&
    (!loosening.userOnly || GLOBAL_SETTINGS_FILES.includes(file.path))
  ) {
    entries.push(
      entry(file.path, 'setting permissions.defaultMode', `${String(mode)} (${loosening.note})`),
    );
  }
  // Rules that approve tools and folders Claude may use without asking, from any settings
  // file (a project's after the folder is trusted): one entry each, so only new ones show.
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  for (const key of ['allow', 'additionalDirectories']) {
    for (const rule of strings(permissions.success ? permissions.data[key] : undefined)) {
      entries.push(entry(file.path, `setting permissions.${key}`, rule));
    }
  }
  // The sandbox block as a whole: a change anywhere in it may open commands or the network.
  const sandbox = JsonObjectSchema.safeParse(json['sandbox']);
  if (sandbox.success) {
    const shown = stable(sandbox.data);
    entries.push(entry(file.path, 'setting sandbox', shown, shown));
  }
  if (json['enableAllProjectMcpServers'] === true) {
    entries.push(
      entry(
        file.path,
        'setting enableAllProjectMcpServers',
        "true (a project's .mcp.json servers start without asking)",
      ),
    );
  }
  return entries;
}

/**
 * The MCP servers of a file, one at a time (SEC-01): a server that is not an object, or a
 * `mcpServers` block that is not one, is shown as unreadable and hides no other server.
 */
function serverEntries(file: CollectedFile, servers: unknown): RunnableEntry[] {
  if (servers === undefined) return [];
  const all = JsonObjectSchema.safeParse(servers);
  if (!all.success) return [unreadable(file.path, 'MCP servers', servers)];
  return Object.entries(all.data).flatMap(([name, value]) => {
    const server = JsonObjectSchema.safeParse(value);
    if (!server.success) return [unreadable(file.path, `MCP server ${name}`, value)];
    const shown = describeServer(server.data);
    return shown === ''
      ? []
      : [entry(file.path, `MCP server ${name}`, shown, slashes(stable(server.data)))];
  });
}

/**
 * Everything in these files that runs programs: hooks (commands and addresses they send to),
 * the status line, command settings, loader variables in `env`, permission settings that
 * stop Claude Code asking, MCP servers (the whole definition is compared), and skill,
 * command and subagent files with commands that run by themselves.
 */
function runnableEntries(files: readonly CollectedFile[]): RunnableEntry[] {
  const entries: RunnableEntry[] = [];
  for (const file of files) {
    if (MARKDOWN_FOLDERS.test(file.path) && file.path.toLowerCase().endsWith('.md')) {
      const found = runnableInMarkdown(new TextDecoder().decode(file.content));
      const kind = /(skills|commands|agents)\//.exec(file.path)?.[1] ?? 'skills';
      const label = { skills: 'skill', commands: 'command', agents: 'subagent' }[kind] ?? 'skill';
      if (found.length > 0) {
        entries.push(entry(file.path, `${label} ${file.path}`, found.join(', '), stable(found)));
      }
      continue;
    }
    const json = SETTINGS_FILES.has(file.path) || MCP_FILES.has(file.path) ? parse(file) : null;
    if (json === null) continue;
    if (SETTINGS_FILES.has(file.path)) entries.push(...settingsEntries(file, json));
    entries.push(...serverEntries(file, json['mcpServers']));
  }
  return entries;
}

const folderOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);

/**
 * A file that can run as a program when a command names it (T55): a script extension, no
 * extension at all (`bin/run`), the executable bit, or a `#!` first line. A data file that a
 * command only reads (`jq … config.json`) is not one.
 */
const isProgram = (file: CollectedFile) =>
  isScript(file.path) ||
  !/\.[^./]+$/.test(file.path) ||
  file.executable ||
  (file.content[0] === 0x23 && file.content[1] === 0x21);

/**
 * Incoming script files that a command runs, matched by path: the command names the
 * script's path within the base folder, the project or (for `.agentnomad/home/...`) the home
 * folder, e.g. `…/.claude/hooks/check.sh` runs `hooks/check.sh`. Commands come from the
 * incoming setup and from this PC's own (T44: a hook already here runs a changed script
 * too), and scripts next to a run script count as well (a helper it loads). A named file
 * counts whatever its name when it can run as a program (T55: `skills/tool/bin/run`). A path
 * counts wherever a command names it: inside a quoted command line, or next to shell
 * punctuation (SEC-01).
 */
function scriptsRun(incoming: readonly CollectedFile[], runs: readonly (readonly string[])[]) {
  const words = runs.flatMap((run) => pathWords(run).map(slashes));
  const relativeOf = (path: string) =>
    path.startsWith(HOME_SCRIPTS_PREFIX) ? path.slice(HOME_SCRIPTS_PREFIX.length) : path;
  const run = new Set(
    incoming.filter((file) => {
      if (!isProgram(file)) return false;
      const relative = relativeOf(file.path);
      return words.some((word) => word === relative || word.endsWith(`/${relative}`));
    }),
  );
  const folders = new Set([...run].map((file) => folderOf(file.path)).filter((folder) => folder));
  return incoming.filter(
    (file) => run.has(file) || (isScript(file.path) && folders.has(folderOf(file.path))),
  );
}

/**
 * The incoming entries that are not already on this PC exactly as they are: new ones, ones
 * whose definition changed, scripts that commands run whose content is new or changed here
 * (T38: a changed `check.sh` behind an unchanged hook command is shown too), and tool
 * settings that can hold commands. Unchanged ones are not asked about.
 */
export function reviewRunnable(
  incoming: readonly CollectedFile[],
  current: readonly CollectedFile[],
): ReviewedEntry[] {
  const here = runnableEntries(current);
  const entries = runnableEntries(incoming);
  // Lookup tables, not a search per entry or file: a setup may hold thousands (PERF-01).
  const hereLabels = new Map<string, Set<string>>();
  for (const existing of here) {
    const identities = hereLabels.get(existing.label) ?? new Set<string>();
    identities.add(existing.identity);
    hereLabels.set(existing.label, identities);
  }
  const currentByPath = new Map(current.map((file) => [file.path, file]));
  const commands: ReviewedEntry[] = entries
    .filter((item) => hereLabels.get(item.label)?.has(item.identity) !== true)
    .map((item) => ({
      ...item,
      // A named entry (not one of a list) that is here with another definition is a change.
      change:
        !LIST_LABELS.test(item.label) && hereLabels.has(item.label)
          ? ('changed' as const)
          : ('new' as const),
    }));

  const newOrChanged = (file: CollectedFile) => {
    const existing = currentByPath.get(file.path);
    if (existing && sameBytes(existing.content, file.content)) return null;
    return existing ? ('changed' as const) : ('new' as const);
  };
  // What every entry shows, and the words hooks and the status line really run with: an
  // exec-form hook's `args` element may hold spaces (BUG-01).
  const settingsRuns = [...incoming, ...current]
    .filter((file) => SETTINGS_FILES.has(file.path))
    .flatMap((file) => commandsInSettings(new TextDecoder().decode(file.content)));
  const scripts: ReviewedEntry[] = scriptsRun(incoming, [
    ...[...entries, ...here].map((item) => commandWords(item.command)),
    ...settingsRuns,
  ]).flatMap((file) => {
    const change = newOrChanged(file);
    if (change === null) return [];
    const shown = file.path.startsWith(HOME_SCRIPTS_PREFIX)
      ? `~/${file.path.slice(HOME_SCRIPTS_PREFIX.length)}`
      : file.path;
    return [{ ...entry(file.path, 'script', shown), change }];
  });

  // Settings of status line tools can hold commands of their own (ccstatusline's Custom
  // Command widget), so a new or changed copy is shown too.
  const toolSettings = new Set(
    Object.values(TOOL_CONFIG_FILES)
      .flat()
      .map((path) => HOME_SCRIPTS_PREFIX + path),
  );
  const tools: ReviewedEntry[] = incoming
    .filter((file) => toolSettings.has(file.path))
    .flatMap((file) => {
      const change = newOrChanged(file);
      if (change === null) return [];
      const shown = `~/${file.path.slice(HOME_SCRIPTS_PREFIX.length)}`;
      return [{ ...entry(file.path, 'tool settings (can run commands)', shown), change }];
    });
  return [...commands, ...scripts, ...tools];
}
