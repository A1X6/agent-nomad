import * as z from 'zod';

import type { CollectedFile } from '../agents/adapter.ts';

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

/**
 * The incoming entries that are not already on this PC exactly as they are: new ones, and
 * a status line or MCP server whose command changed. Unchanged ones are not asked about.
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
  return runnableEntries(incoming)
    .filter((entry) => !here.some((existing) => same(existing, entry)))
    .map((entry) => ({
      ...entry,
      // A status line or MCP server with the same name but another command is a change.
      change:
        !entry.label.startsWith('hook ') && here.some((existing) => existing.label === entry.label)
          ? ('changed' as const)
          : ('new' as const),
    }));
}
