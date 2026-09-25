import * as z from 'zod';

import type { CollectedFile } from '../agents/adapter.ts';
import { commandWords } from '../agents/claude-code/file-gathering.ts';
import { HOME_SCRIPTS_PREFIX, SCRIPT_EXTENSIONS } from '../agents/claude-code/global-paths.ts';

/**
 * Things in a setup that run programs on this PC (T34): hooks, the status line and MCP
 * servers. Pull shows the new or changed ones and asks before writing them.
 */
export interface RunnableEntry {
  /** The bundle file it lives in, e.g. `settings.json` or `.mcp.json`. */
  readonly file: string;
  /** What it is, e.g. `hook PreToolUse`, `status line`, `MCP server github`. */
  readonly label: string;
  /** What runs, e.g. `~/.claude/hooks/check.sh` or `npx gh-mcp` or a URL. */
  readonly command: string;
}

export interface ReviewedEntry extends RunnableEntry {
  readonly change: 'new' | 'changed';
}

const SETTINGS_FILES = new Set([
  'settings.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
]);
const MCP_FILES = new Set(['.mcp.json', '.agentnomad/claude.json']);

const Json = z.record(z.string(), z.unknown());
const Hooks = z.record(
  z.string(),
  z.array(
    z.looseObject({ hooks: z.array(z.looseObject({ command: z.string().optional() })).optional() }),
  ),
);
const Command = z.looseObject({ command: z.string().optional() });
const Servers = z.record(
  z.string(),
  z.looseObject({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
  }),
);

function parse(file: CollectedFile): Record<string, unknown> | null {
  try {
    const parsed = Json.safeParse(JSON.parse(new TextDecoder().decode(file.content)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Every hook, status line and MCP server command in these files. */
export function runnableEntries(files: readonly CollectedFile[]): RunnableEntry[] {
  const entries: RunnableEntry[] = [];
  for (const file of files) {
    const json = SETTINGS_FILES.has(file.path) || MCP_FILES.has(file.path) ? parse(file) : null;
    if (json === null) continue;
    if (SETTINGS_FILES.has(file.path)) {
      const hooks = Hooks.safeParse(json['hooks']);
      for (const [event, groups] of Object.entries(hooks.success ? hooks.data : {})) {
        for (const group of groups) {
          for (const hook of group.hooks ?? []) {
            if (hook.command !== undefined)
              entries.push({ file: file.path, label: `hook ${event}`, command: hook.command });
          }
        }
      }
      const statusLine = Command.safeParse(json['statusLine']);
      if (statusLine.success && statusLine.data.command !== undefined) {
        entries.push({ file: file.path, label: 'status line', command: statusLine.data.command });
      }
    }
    const servers = Servers.safeParse(json['mcpServers']);
    for (const [name, server] of Object.entries(servers.success ? servers.data : {})) {
      const command = server.url ?? [server.command ?? '', ...(server.args ?? [])].join(' ').trim();
      if (command !== '') entries.push({ file: file.path, label: `MCP server ${name}`, command });
    }
  }
  return entries;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);

/**
 * Incoming script files that one of the incoming commands runs, matched by path: the
 * command names the script's path within the base folder, the project or (for
 * `.agentnomad/home/...`) the home folder, e.g. `…/.claude/hooks/check.sh` runs `hooks/check.sh`.
 */
function scriptsRun(incoming: readonly CollectedFile[], commands: readonly string[]) {
  const words = commands.flatMap((command) =>
    commandWords(command).map((word) => word.replace(/\\/g, '/')),
  );
  return incoming.filter((file) => {
    if (!SCRIPT_EXTENSIONS.has(/(\.[^./]+)$/.exec(file.path)?.[1]?.toLowerCase() ?? '')) {
      return false;
    }
    const relative = file.path.startsWith(HOME_SCRIPTS_PREFIX)
      ? file.path.slice(HOME_SCRIPTS_PREFIX.length)
      : file.path;
    return words.some((word) => word === relative || word.endsWith(`/${relative}`));
  });
}

/**
 * The incoming entries that are not already on this PC exactly as they are: new ones, a
 * status line or MCP server whose command changed, and scripts those commands run whose
 * content is new or changed here (T38: a changed `check.sh` behind an unchanged hook
 * command is shown too). Unchanged ones are not asked about.
 */
export function reviewRunnable(
  incoming: readonly CollectedFile[],
  current: readonly CollectedFile[],
): ReviewedEntry[] {
  const here = runnableEntries(current);
  // Restored paths use forward slashes on Windows (T10), existing ones often backslashes:
  // the same command either way.
  const normal = (command: string) => command.replace(/\\/g, '/');
  const same = (a: RunnableEntry, b: RunnableEntry) =>
    a.label === b.label && normal(a.command) === normal(b.command);
  const entries = runnableEntries(incoming);
  const commands: ReviewedEntry[] = entries
    .filter((entry) => !here.some((existing) => same(existing, entry)))
    .map((entry) => ({
      ...entry,
      // A status line or MCP server with the same name but another command is a change.
      change:
        !entry.label.startsWith('hook ') && here.some((existing) => existing.label === entry.label)
          ? ('changed' as const)
          : ('new' as const),
    }));
  const scripts: ReviewedEntry[] = scriptsRun(
    incoming,
    entries.map((entry) => entry.command),
  ).flatMap((file) => {
    const existing = current.find((entry) => entry.path === file.path);
    if (existing && sameBytes(existing.content, file.content)) return [];
    return [
      {
        file: file.path,
        label: 'script',
        command: file.path.startsWith(HOME_SCRIPTS_PREFIX)
          ? `~/${file.path.slice(HOME_SCRIPTS_PREFIX.length)}`
          : file.path,
        change: existing ? ('changed' as const) : ('new' as const),
      },
    ];
  });
  return [...commands, ...scripts];
}
