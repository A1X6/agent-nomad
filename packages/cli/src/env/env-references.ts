import * as z from 'zod';

import type { EnvReferenceFiles } from '../agents/adapter.ts';
import { parseJsonWith, valueOrNull } from '../system/json.ts';

/** A file of a collected setup (only path and bytes are needed here). */
export interface ScannedFile {
  readonly path: string;
  readonly content: Uint8Array;
}

/** `${NAME}` or `${NAME:-default}`, as Claude Code expands them. */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

interface EnvUsage {
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

/** Every `${VAR}` in a JSON value, in any string at any depth, but the agent's own. */
function referencesIn(value: unknown, ownVariables: ReadonlySet<string>): string[] {
  // Values come from JSON.parse, so they are never undefined and always stringify.
  const text = JSON.stringify(value);
  return [...text.matchAll(REFERENCE)]
    .map((match) => match[1] ?? '')
    .filter((name) => name !== '' && !ownVariables.has(name));
}

/**
 * Finds the environment variables a setup depends on (T30): `${VAR}` in the MCP servers and
 * settings files the agent names (ARCH-01), with where each one is used. Never reads or
 * returns any value.
 */
export function scanEnvReferences(
  files: readonly ScannedFile[],
  references: EnvReferenceFiles | undefined,
  scopeLabel?: string,
): EnvScan {
  const usage = new Map<string, Set<string>>();
  const setBySettings = new Set<string>();
  if (references === undefined) return { variables: [], setBySettings };
  const { mcp, settings, ownVariables } = references;
  const use = (name: string, where: string) => {
    const label = scopeLabel ? `${where}, ${scopeLabel}` : where;
    usage.set(name, (usage.get(name) ?? new Set()).add(label));
  };

  for (const file of files) {
    if (!mcp.has(file.path) && !settings.has(file.path)) continue;
    const json = valueOrNull(parseJsonWith(JsonObjectSchema, file.content));
    if (json === null) continue;
    const label = references.label?.(file.path) ?? file.path;

    const servers = JsonObjectSchema.safeParse(json['mcpServers']);
    const rest = Object.fromEntries(Object.entries(json).filter(([key]) => key !== 'mcpServers'));
    if (servers.success) {
      for (const [server, config] of Object.entries(servers.data)) {
        for (const name of referencesIn(config, ownVariables)) {
          use(name, `MCP server ${server} (${label})`);
        }
      }
    }
    if (settings.has(file.path)) {
      const env = JsonObjectSchema.safeParse(json['env']);
      if (env.success) for (const name of Object.keys(env.data)) setBySettings.add(name);
    }
    for (const name of referencesIn(rest, ownVariables)) use(name, label);
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
