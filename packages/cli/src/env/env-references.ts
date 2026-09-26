import * as z from 'zod';

/** A file of a collected setup (only path and bytes are needed here). */
export interface ScannedFile {
  readonly path: string;
  readonly content: Uint8Array;
}

/** Variables Claude Code sets itself for hooks and servers; never the user's secrets. */
export const CLAUDE_OWN_VARIABLES = new Set([
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_CONFIG_DIR',
]);

/** `${NAME}` or `${NAME:-default}`, as Claude Code expands them. */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

/** Files that can hold `${VAR}` references: MCP servers and settings. */
const MCP_FILES = new Set(['.mcp.json', '.agentnomad/claude.json']);
const SETTINGS_FILES = new Set([
  'settings.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
]);

export interface EnvUsage {
  readonly name: string;
  /** Where it is used, e.g. `MCP server github (.mcp.json)`; sorted, no repeats. */
  readonly usedBy: readonly string[];
}

export interface EnvScan {
  readonly variables: readonly EnvUsage[];
  /** Set by an `env` block in the settings, so Claude Code has them without the shell. */
  readonly setBySettings: ReadonlySet<string>;
}

const JsonObjectSchema = z.record(z.string(), z.unknown());

function parseJson(file: ScannedFile): Record<string, unknown> | null {
  try {
    const parsed = JsonObjectSchema.safeParse(JSON.parse(new TextDecoder().decode(file.content)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Every `${VAR}` in a JSON value, in any string at any depth. */
function referencesIn(value: unknown): string[] {
  // Values come from JSON.parse, so they are never undefined and always stringify.
  const text = JSON.stringify(value);
  return [...text.matchAll(REFERENCE)]
    .map((match) => match[1] ?? '')
    .filter((name) => name !== '' && !CLAUDE_OWN_VARIABLES.has(name));
}

/** A readable name for a file in messages: `~/.claude.json` for the reserved entry. */
const fileLabel = (path: string) => (path === '.agentnomad/claude.json' ? '~/.claude.json' : path);

/**
 * Finds the environment variables a setup depends on (T30): `${VAR}` in MCP servers and
 * settings, with where each one is used. Never reads or returns any value.
 */
export function scanEnvReferences(files: readonly ScannedFile[], scopeLabel?: string): EnvScan {
  const usage = new Map<string, Set<string>>();
  const setBySettings = new Set<string>();
  const use = (name: string, where: string) => {
    const label = scopeLabel ? `${where}, ${scopeLabel}` : where;
    usage.set(name, (usage.get(name) ?? new Set()).add(label));
  };

  for (const file of files) {
    if (!MCP_FILES.has(file.path) && !SETTINGS_FILES.has(file.path)) continue;
    const json = parseJson(file);
    if (json === null) continue;
    const label = fileLabel(file.path);

    const servers = JsonObjectSchema.safeParse(json['mcpServers']);
    const rest = Object.fromEntries(Object.entries(json).filter(([key]) => key !== 'mcpServers'));
    if (servers.success) {
      for (const [server, config] of Object.entries(servers.data)) {
        for (const name of referencesIn(config)) use(name, `MCP server ${server} (${label})`);
      }
    }
    if (SETTINGS_FILES.has(file.path)) {
      const env = JsonObjectSchema.safeParse(json['env']);
      if (env.success) for (const name of Object.keys(env.data)) setBySettings.add(name);
    }
    for (const name of referencesIn(rest)) use(name, label);
  }

  const variables = [...usage.entries()]
    .map(([name, where]) => ({ name, usedBy: [...where].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { variables, setBySettings };
}

/** Joins scans of several setups (e.g. global and project) into one list. */
export function mergeEnvScans(scans: readonly EnvScan[]): EnvScan {
  const usage = new Map<string, Set<string>>();
  const setBySettings = new Set<string>();
  for (const scan of scans) {
    for (const variable of scan.variables) {
      const where = usage.get(variable.name) ?? new Set<string>();
      for (const place of variable.usedBy) where.add(place);
      usage.set(variable.name, where);
    }
    for (const name of scan.setBySettings) setBySettings.add(name);
  }
  return {
    variables: [...usage.entries()]
      .map(([name, where]) => ({ name, usedBy: [...where].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    setBySettings,
  };
}
