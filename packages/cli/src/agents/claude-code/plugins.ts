import { readFile } from 'node:fs/promises';

import * as z from 'zod';

import { parseJsonWith, valueOrNull, type JsonResult } from '../../system/json.ts';
import { samePath } from '../../system/paths.ts';
import type { CollectedFile } from '../adapter.ts';
import { pathsOf } from '../shared/detector-system.ts';
import { jsonFile } from '../shared/file-gathering.ts';
import { PLUGIN_VERSIONS_BUNDLE_PATH, PLUGINS_BUNDLE_PATH } from './global-paths.ts';

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
/** A marketplace name as Claude Code gives one; also a file name for T98's saved folders. */
export const MarketplaceNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const MarketplaceEntrySchema = z.strictObject({
  name: MarketplaceNameSchema,
  // Passed to `claude plugin marketplace add`: only the forms push writes (a GitHub
  // `owner/repo`, an https or git@ URL, each with an optional `#ref`), so never an
  // option, a local path or plain http (T44).
  add: z
    .string()
    .regex(
      /^([A-Za-z0-9][\w.-]*\/[\w.-]+|https:\/\/[^\s"'`&|<>^%;]+|git@[^\s"'`&|<>^%;]+)(#[^\s"'`&|<>^%;]+)?$/,
    ),
});
export const PluginEntrySchema = z.strictObject({
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

/** The version of one saved plugin install, as `installed_plugins.json` gives it (T100). */
interface PluginVersionEntry {
  /** `plugin@marketplace`. */
  readonly id: string;
  readonly scope: PluginScope;
  readonly version: string;
}

/**
 * What `.agentnomad/plugin-versions.json` holds (T100). A file of its own, as `plugins.json`
 * is read strictly by older CLIs; they refuse this unknown file with a warning and go on.
 */
export interface PluginVersions {
  readonly plugins: readonly PluginVersionEntry[];
}

/** A version as Claude Code writes one: `1.2.0`, a 12-digit commit or `1.2.0-<hash>`. */
const PluginVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/);

const PluginVersionsSchema = z.strictObject({
  plugins: z.array(
    z.strictObject({
      id: PluginEntrySchema.shape.id,
      scope: PluginEntrySchema.shape.scope,
      version: PluginVersionSchema,
    }),
  ),
});

/** A saved `plugin-versions.json` as pull reads it; never throws (T100). */
export const readSavedPluginVersions = (content: Uint8Array): JsonResult<PluginVersions> =>
  parseJsonWith(PluginVersionsSchema, content);

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
  /** A `directory` source's folder (T98). */
  path: z.string().optional(),
});
const KnownMarketplacesSchema = z.record(
  z.string(),
  z.looseObject({ source: SourceSchema, installLocation: z.string().optional() }),
);
const PluginInstallSchema = z.looseObject({
  scope: z.enum(['user', 'project', 'local', 'managed']).or(z.string()),
  projectPath: z.string().optional(),
  // Checked where it is used (T100): an odd version never makes the whole file unreadable.
  version: z.unknown().optional(),
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
  const path = pathsOf(platform);
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

/** Whether an install is one of `input`'s: user scope, or installed for that project. */
const inScope = (install: PluginInstall, input: PluginManifestInput): boolean =>
  input.scope.kind === 'global'
    ? install.scope === 'user'
    : (install.scope === 'project' || install.scope === 'local') &&
      installedIn(install, input.scope.projectDir, input.platform);

/**
 * The installed version of each of `plugins` in `input`'s scope (T100): push saves them, and
 * pull reads them again after installing. Left out: a version Claude Code could not tell
 * (`unknown`, e.g. an npm source) or one in an unexpected form. `null` when none is known.
 */
export async function readPluginVersions(
  input: PluginManifestInput,
  plugins: readonly PluginEntry[],
): Promise<PluginVersions | null> {
  const installed = await readInstalledPlugins(input.baseDir, input.platform);
  const versions = plugins.flatMap(({ id, scope }) => {
    const version = PluginVersionSchema.safeParse(
      installed?.[id]?.find((install) => install.scope === scope && inScope(install, input))
        ?.version,
    );
    return version.success && version.data !== 'unknown'
      ? [{ id, scope, version: version.data }]
      : [];
  });
  return versions.length === 0 ? null : { plugins: versions };
}

/**
 * What push saves about plugins, for both collectors: `plugins.json` and, when a version is
 * known, `plugin-versions.json` (T100). Nothing when there are no plugins to save.
 */
export async function pluginFiles(input: PluginManifestInput): Promise<CollectedFile[]> {
  const manifest = await readPluginManifest(input);
  if (manifest === null) return [];
  const versions = await readPluginVersions(input, manifest.plugins);
  return [
    jsonFile(PLUGINS_BUNDLE_PATH, manifest),
    ...(versions === null ? [] : [jsonFile(PLUGIN_VERSIONS_BUNDLE_PATH, versions)]),
  ];
}

/** This PC's `plugins/known_marketplaces.json`, by name; empty when missing or unreadable. */
export async function readKnownMarketplaces(
  baseDir: string,
  platform: NodeJS.Platform,
): Promise<z.infer<typeof KnownMarketplacesSchema>> {
  const path = pathsOf(platform);
  return (
    (await readJson(
      path.join(baseDir, 'plugins', 'known_marketplaces.json'),
      KnownMarketplacesSchema,
    )) ?? {}
  );
}

/** An install's scope, or `null` for one push never saves (`managed`, or unknown). */
const scopeOf = (install: PluginInstall): PluginScope | null =>
  install.scope === 'user' || install.scope === 'project' || install.scope === 'local'
    ? install.scope
    : null;

/**
 * Whether plugin `id` has a `command` source in the catalog of the marketplace in `folder`:
 * it builds the plugin by running a command, so it is flagged for an extra yes.
 */
async function isCommandSource(
  folder: string | undefined,
  id: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (folder === undefined) return false;
  const path = pathsOf(platform);
  const catalog = await readJson(
    path.join(folder, '.claude-plugin', 'marketplace.json'),
    MarketplaceJsonSchema,
  );
  const pluginName = id.split('@')[0];
  const source = catalog?.plugins?.find((entry) => entry.name === pluginName)?.source;
  return (
    typeof source === 'object' &&
    source !== null &&
    'source' in source &&
    source.source === 'command'
  );
}

/** A marketplace added from a folder on this PC (T98), with its plugins installed in scope. */
export interface LocalMarketplace {
  readonly name: string;
  /** The folder, as `known_marketplaces.json` gives it. */
  readonly folder: string;
  readonly plugins: readonly PluginEntry[];
}

/**
 * The marketplaces added from a folder (`directory` source) that have a plugin installed in
 * `input`'s scope (T98), sorted by name. `plugins.json` still lists those plugins as skipped,
 * so older CLIs read it as before; push saves the folders on their own.
 */
export async function readLocalMarketplaces(
  input: PluginManifestInput,
): Promise<LocalMarketplace[]> {
  const installed = await readInstalledPlugins(input.baseDir, input.platform);
  if (installed === null) return [];
  const known = await readKnownMarketplaces(input.baseDir, input.platform);
  const found = new Map<string, { folder: string; plugins: PluginEntry[] }>();
  for (const [id, installs] of Object.entries(installed)) {
    const name = id.split('@')[1] ?? '';
    const folder = known[name]?.source.source === 'directory' ? known[name].source.path : undefined;
    if (
      folder === undefined ||
      !PluginEntrySchema.shape.id.safeParse(id).success ||
      !MarketplaceNameSchema.safeParse(name).success
    )
      continue;
    for (const install of installs.filter((entry) => inScope(entry, input))) {
      const scope = scopeOf(install);
      if (scope === null) continue;
      const marketplace = found.get(name) ?? { folder, plugins: [] };
      const commandSource = await isCommandSource(folder, id, input.platform);
      marketplace.plugins.push({ id, scope, commandSource });
      found.set(name, marketplace);
    }
  }
  return [...found]
    .map(([name, { folder, plugins }]) => ({
      name,
      folder,
      plugins: plugins.sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads the installed plugins and their marketplaces; `null` when there are none to save. */
export async function readPluginManifest(
  input: PluginManifestInput,
): Promise<PluginManifest | null> {
  const installed = await readInstalledPlugins(input.baseDir, input.platform);
  if (installed === null) return null;
  const known = await readKnownMarketplaces(input.baseDir, input.platform);

  const wanted = (entry: PluginInstall) => inScope(entry, input);

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

      const scope = scopeOf(install);
      if (scope !== null) {
        const commandSource = await isCommandSource(
          marketplace.installLocation,
          id,
          input.platform,
        );
        plugins.push({ id, scope, commandSource });
      }
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
