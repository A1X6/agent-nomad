import { readFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import * as z from 'zod';

import { parseJsonWith, valueOrNull, type JsonResult } from '../../system/json.ts';
import { samePath } from '../../system/paths.ts';

/**
 * Plugins are reinstalled, never copied (T29): push saves which marketplaces and plugins
 * are installed, and pull runs Claude Code's own `claude plugin` commands.
 */

/** A marketplace to add on the other PC; `add` is the `claude plugin marketplace add` source. */
export interface MarketplaceEntry {
  readonly name: string;
  readonly add: string;
}

type PluginScope = 'user' | 'project' | 'local';

export interface PluginEntry {
  /** `plugin@marketplace`. */
  readonly id: string;
  readonly scope: PluginScope;
  /** Built by running a command on install: needs the user's own yes. */
  readonly commandSource: boolean;
}

/** What `.agentnomad/plugins.json` holds. */
export interface PluginManifest {
  readonly marketplaces: readonly MarketplaceEntry[];
  readonly plugins: readonly PluginEntry[];
  /** Left out, with why, so push can say so. */
  readonly skipped: readonly { readonly what: string; readonly reason: string }[];
}

/**
 * One saved marketplace and one saved plugin, as pull accepts them. Push checks each entry
 * with the same schema before saving it (BUG-01), so pull never refuses what push saved.
 */
const MarketplaceEntrySchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  // Passed to `claude plugin marketplace add`: only the forms push writes (a GitHub
  // `owner/repo`, an https or git@ URL, each with an optional `#ref`), so never an
  // option, a local path or plain http (T44).
  add: z
    .string()
    .regex(
      /^([A-Za-z0-9][\w.-]*\/[\w.-]+|https:\/\/[^\s"'`&|<>^%;]+|git@[^\s"'`&|<>^%;]+)(#[^\s"'`&|<>^%;]+)?$/,
    ),
});
const PluginEntrySchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/),
  scope: z.enum(['user', 'project', 'local']),
  commandSource: z.boolean(),
});
const SkippedSchema = z.strictObject({ what: z.string(), reason: z.string() });

export const PluginManifestSchema = z.strictObject({
  marketplaces: z.array(MarketplaceEntrySchema),
  plugins: z.array(PluginEntrySchema),
  skipped: z.array(SkippedSchema),
});

/** A saved `plugins.json` as pull reads it: the entries it accepts, and the ones it refused. */
export interface SavedPlugins {
  readonly manifest: PluginManifest;
  /** Entries pull refuses, as JSON, so it can say so. */
  readonly refused: readonly string[];
}

/**
 * Reads a saved `.agentnomad/plugins.json` entry by entry (BUG-01): an entry pull refuses is
 * left out and named, and the others are still offered.
 */
export function readSavedPlugins(content: Uint8Array): JsonResult<SavedPlugins> {
  const outline = parseJsonWith(
    z.object({
      marketplaces: z.array(z.unknown()),
      plugins: z.array(z.unknown()),
      skipped: z.array(z.unknown()).optional(),
    }),
    content,
  );
  if (!('value' in outline)) return outline;
  const refused: string[] = [];
  const accepted = <S extends z.ZodType>(schema: S, entries: readonly unknown[]): z.infer<S>[] =>
    entries.flatMap((entry) => {
      const parsed = schema.safeParse(entry);
      if (parsed.success) return [parsed.data];
      refused.push(JSON.stringify(entry));
      return [];
    });
  const manifest: PluginManifest = {
    marketplaces: accepted(MarketplaceEntrySchema, outline.value.marketplaces),
    plugins: accepted(PluginEntrySchema, outline.value.plugins),
    skipped: (outline.value.skipped ?? []).flatMap((entry) => {
      const parsed = SkippedSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    }),
  };
  return { value: { manifest, refused } };
}

const SourceSchema = z.looseObject({
  source: z.string(),
  repo: z.string().optional(),
  url: z.string().optional(),
  ref: z.string().optional(),
});
const KnownMarketplacesSchema = z.record(
  z.string(),
  z.looseObject({ source: SourceSchema, installLocation: z.string().optional() }),
);
const PluginInstallSchema = z.looseObject({
  scope: z.enum(['user', 'project', 'local', 'managed']).or(z.string()),
  projectPath: z.string().optional(),
});
const InstalledPluginsSchema = z.looseObject({
  plugins: z.record(z.string(), z.array(PluginInstallSchema)),
});

type PluginInstall = z.infer<typeof PluginInstallSchema>;
const MarketplaceJsonSchema = z.looseObject({
  plugins: z.array(z.looseObject({ name: z.string(), source: z.unknown().optional() })).optional(),
});

type Source = z.infer<typeof SourceSchema>;

/**
 * The `claude plugin marketplace add` argument for a saved source: `owner/repo#ref`, a git
 * or https URL. `null` for local folders and files (they exist only on the old PC) and for
 * anything else this version does not know.
 */
export function marketplaceAddArgument(source: Source): string | null {
  const withRef = (base: string) => (source.ref ? `${base}#${source.ref}` : base);
  switch (source.source) {
    case 'github':
      return source.repo && /^[\w.-]+\/[\w.-]+$/.test(source.repo) ? withRef(source.repo) : null;
    case 'git':
      return source.url && /^(https:\/\/|git@)/.test(source.url) ? withRef(source.url) : null;
    case 'url':
      return source.url?.startsWith('https://') ? source.url : null;
    default:
      return null;
  }
}

async function readJson<S extends z.ZodType>(file: string, schema: S): Promise<z.infer<S> | null> {
  const text = await readFile(file, 'utf8').catch(() => null);
  return text === null ? null : valueOrNull(parseJsonWith(schema, text));
}

/**
 * The installs of each plugin, from Claude Code's `plugins/installed_plugins.json`; `null`
 * when it is missing or unreadable. Push and pull both read it here (BUG-03).
 */
export async function readInstalledPlugins(
  baseDir: string,
  platform: NodeJS.Platform,
): Promise<Readonly<Record<string, readonly PluginInstall[]>> | null> {
  const path = platform === 'win32' ? win32 : posix;
  const installed = await readJson(
    path.join(baseDir, 'plugins', 'installed_plugins.json'),
    InstalledPluginsSchema,
  );
  return installed?.plugins ?? null;
}

/** Whether a project install belongs to `projectDir`, compared as this OS compares paths. */
export const installedIn = (
  install: PluginInstall,
  projectDir: string,
  platform: NodeJS.Platform,
): boolean =>
  install.projectPath !== undefined && samePath(install.projectPath, projectDir, platform);

export interface PluginManifestInput {
  /** Claude Code's base folder (`~/.claude` or `CLAUDE_CONFIG_DIR`). */
  readonly baseDir: string;
  readonly platform: NodeJS.Platform;
  /** `global`: user-scope plugins; a project folder: plugins installed for that project. */
  readonly scope:
    { readonly kind: 'global' } | { readonly kind: 'project'; readonly projectDir: string };
}

/** Reads the installed plugins and their marketplaces; `null` when there are none to save. */
export async function readPluginManifest(
  input: PluginManifestInput,
): Promise<PluginManifest | null> {
  const path = input.platform === 'win32' ? win32 : posix;
  const pluginsDir = path.join(input.baseDir, 'plugins');
  const installed = await readInstalledPlugins(input.baseDir, input.platform);
  if (installed === null) return null;
  const known =
    (await readJson(path.join(pluginsDir, 'known_marketplaces.json'), KnownMarketplacesSchema)) ??
    {};

  const wanted = (entry: PluginInstall) =>
    input.scope.kind === 'global'
      ? entry.scope === 'user'
      : (entry.scope === 'project' || entry.scope === 'local') &&
        installedIn(entry, input.scope.projectDir, input.platform);

  const marketplaces = new Map<string, MarketplaceEntry>();
  const plugins: PluginEntry[] = [];
  const skipped: { what: string; reason: string }[] = [];

  for (const [id, installs] of Object.entries(installed)) {
    for (const install of installs.filter(wanted)) {
      const marketplaceName = id.split('@')[1] ?? '';
      const marketplace = known[marketplaceName];
      const add = marketplace ? marketplaceAddArgument(marketplace.source) : null;
      // Checked as pull checks it (BUG-01): pull would refuse it.
      if (!PluginEntrySchema.shape.id.safeParse(id).success) {
        skipped.push({ what: id, reason: 'unexpected plugin name' });
        continue;
      }
      if (marketplaceName.startsWith('claudeai-')) {
        skipped.push({ what: id, reason: 'comes with your claude.ai account' });
        continue;
      }
      if (!marketplace || add === null) {
        skipped.push({
          what: id,
          reason: marketplace
            ? 'its marketplace is a local folder or unknown source'
            : 'its marketplace is missing',
        });
        continue;
      }
      if (!MarketplaceEntrySchema.safeParse({ name: marketplaceName, add }).success) {
        skipped.push({ what: id, reason: 'its marketplace address has characters pull refuses' });
        continue;
      }
      marketplaces.set(marketplaceName, { name: marketplaceName, add });

      // A `command` source builds the plugin by running a command: flag it for an extra yes.
      const catalog = marketplace.installLocation
        ? await readJson(
            path.join(marketplace.installLocation, '.claude-plugin', 'marketplace.json'),
            MarketplaceJsonSchema,
          )
        : null;
      const pluginName = id.split('@')[0];
      const source = catalog?.plugins?.find((entry) => entry.name === pluginName)?.source;
      const commandSource =
        typeof source === 'object' &&
        source !== null &&
        'source' in source &&
        source.source === 'command';
      const scope: PluginScope | null =
        install.scope === 'user' || install.scope === 'project' || install.scope === 'local'
          ? install.scope
          : null;
      if (scope !== null) plugins.push({ id, scope, commandSource });
    }
  }

  if (plugins.length === 0 && skipped.length === 0) return null;
  const byName = (a: { name?: string; id?: string }, b: { name?: string; id?: string }) =>
    (a.name ?? a.id ?? '').localeCompare(b.name ?? b.id ?? '');
  return {
    marketplaces: [...marketplaces.values()].sort(byName),
    plugins: plugins.sort(byName),
    skipped,
  };
}
