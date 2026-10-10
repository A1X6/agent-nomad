import { readFile } from 'node:fs/promises';
import type { PlatformPath } from 'node:path';

import * as z from 'zod';

import { isMissing } from '../../system/files.ts';
import { parseJsonWith, valueOrNull } from '../../system/json.ts';

/**
 * Where Claude Code keeps the plugins of each claude.ai account it syncs:
 * `plugins/synced/<account>/` in its base folder. Claude Code manages it; agentnomad never
 * writes there. Claude Code 2.1.296 names each account folder `<org-uuid>_<account-uuid>`
 * (lower case; `unbound` in place of the account uuid when there is none) and keeps its own
 * `.staging` and `.trash` there; agentnomad takes any folder whose name does not start with a
 * dot as an account, so a new name pattern still reads.
 */
export const SYNCED_PLUGINS_DIR = 'plugins/synced';

/*
 * `plugins/synced/<account>/manifest.json` and `.marketplaces.json`, read from the Claude Code
 * 2.1.296 program: which claude.ai marketplace each synced plugin is from, and each
 * marketplace's `scope` (`account`: the user's uploads; `org`: an organization's; `default`:
 * claude.ai's directory). Only the fields used here are checked, each entry on its own;
 * anything else means agentnomad cannot tell.
 *
 * The manifest is `{ lastUpdated: number, plugins?: [...], staleDirs?: [...] }`; one with
 * neither `lastUpdated` nor `plugins` is not one. In an entry (schema `smt`) a `generation`
 * or `presentsAs` of the wrong type counts as absent, as Claude Code's `.catch(void 0)` does.
 */
const PluginsManifestSchema = z
  .looseObject({ lastUpdated: z.number().optional(), plugins: z.array(z.unknown()).optional() })
  .refine((manifest) => manifest.lastUpdated !== undefined || manifest.plugins !== undefined);
const PluginEntrySchema = z.looseObject({
  pluginId: z.string().optional(),
  name: z.string().optional(),
  marketplaceName: z.string().optional(),
  installationPreference: z.string().optional(),
  presentsAs: z.string().optional().catch(undefined),
  generation: z.int().min(2).optional().catch(undefined),
});
/**
 * `.marketplaces.json` is `{ etag?, parserVersion?, rows: [...] }` in 2.1.296; a bare list of
 * rows (a hand-written file) still reads. Each row (schema `vqn`) has `name`, `display_name`,
 * `scope?`, `source`, `id?` and `updated_at`; a row without `scope` cannot tell. The
 * `.marketplace-<id>.json` file Claude Code writes next to it for each claude.ai marketplace
 * is not read: the rows carry the scope.
 */
const MarketplacesSchema = z.union([
  z.looseObject({ rows: z.array(z.unknown()) }).transform((list) => list.rows),
  z.array(z.unknown()),
]);
const MarketplaceSchema = z.looseObject({ name: z.string(), scope: z.string().optional() });

/** One entry of an account's synced plugins manifest, with its marketplace's scope. */
export interface SyncedPlugin {
  readonly pluginId: string | undefined;
  readonly name: string | undefined;
  /** The `scope` of its marketplace; `undefined` when `.marketplaces.json` cannot tell. */
  readonly scope: string | undefined;
  /** `available`, `required`, `auto_install` or `not_available` (2.1.295). */
  readonly installationPreference: string | undefined;
  /** How claude.ai presents the plugin (2.1.296); read, not used yet. */
  readonly presentsAs: string | undefined;
  /** The `generation` of its folder, 2 or more (2.1.296); `undefined` for the first one. */
  readonly generation: number | undefined;
}

/**
 * The name of a synced plugin's folder in its account folder, Claude Code 2.1.296's function
 * `udo`: `join(root, name)` when `generation` is absent or 1, and
 * `join(root, \`${basename(name)}~g${generation}\`)` from 2. Its sidecar is
 * `<folder>.meta.json`. Only for names usable as one folder (`isUsableSkillName`).
 */
export const syncedPluginFolder = (plugin: {
  readonly name: string;
  readonly generation?: number | undefined;
}): string =>
  plugin.generation === undefined || plugin.generation < 2
    ? plugin.name
    : `${plugin.name}~g${String(plugin.generation)}`;

/**
 * The synced plugins of one account; `'no list'` when Claude Code keeps no
 * `.marketplaces.json` there, `'unreadable'` when it or the manifest cannot be read.
 */
export type SyncedPlugins = readonly SyncedPlugin[] | 'no list' | 'unreadable';

/** Reads the synced plugins of the account folder `accountDir`. Never throws. */
export async function readSyncedPluginsOf(
  path: PlatformPath,
  accountDir: string,
): Promise<SyncedPlugins> {
  const read = (file: string) => readFile(path.join(accountDir, file), 'utf8');
  // `undefined`: no file; `null`: a file that cannot be read.
  const marketplacesText = await read('.marketplaces.json').catch((error: unknown) =>
    isMissing(error) ? undefined : null,
  );
  if (marketplacesText === undefined) return 'no list';
  const pluginsText = await read('manifest.json').catch(() => null);
  const marketplaces =
    marketplacesText === null
      ? null
      : valueOrNull(parseJsonWith(MarketplacesSchema, marketplacesText));
  const manifest =
    pluginsText === null ? null : valueOrNull(parseJsonWith(PluginsManifestSchema, pluginsText));
  if (marketplaces === null || manifest === null) return 'unreadable';
  const scopeOf = new Map<string, string>();
  for (const row of marketplaces) {
    const marketplace = MarketplaceSchema.safeParse(row);
    if (marketplace.success && marketplace.data.scope !== undefined) {
      scopeOf.set(marketplace.data.name, marketplace.data.scope);
    }
  }
  return (manifest.plugins ?? []).flatMap((entry) => {
    const plugin = PluginEntrySchema.safeParse(entry);
    if (!plugin.success) return [];
    const { pluginId, name, marketplaceName, installationPreference, presentsAs, generation } =
      plugin.data;
    return [
      {
        pluginId,
        name,
        scope: marketplaceName === undefined ? undefined : scopeOf.get(marketplaceName),
        installationPreference,
        presentsAs,
        generation,
      },
    ];
  });
}

/** Marketplace scopes whose plugins are never the user's own. */
export const NOT_OWN_SCOPES: ReadonlySet<string> = new Set(['org', 'default']);
