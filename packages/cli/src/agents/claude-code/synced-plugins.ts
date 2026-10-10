import { readFile } from 'node:fs/promises';
import type { PlatformPath } from 'node:path';

import * as z from 'zod';

import { isMissing } from '../../system/files.ts';
import { parseJsonWith, valueOrNull } from '../../system/json.ts';

/**
 * Where Claude Code keeps the plugins of each claude.ai account it syncs:
 * `plugins/synced/<account>/` in its base folder. Claude Code manages it; agentnomad never
 * writes there.
 */
export const SYNCED_PLUGINS_DIR = 'plugins/synced';

/**
 * `plugins/synced/<account>/manifest.json` and `.marketplaces.json` (Claude Code 2.1.295):
 * which claude.ai marketplace each synced plugin is from, and each marketplace's `scope`
 * (`account`: the user's uploads; `org`: an organization's; `default`: claude.ai's
 * directory). The lists around the entries are not seen on a real account yet, so each entry
 * is checked on its own, and anything else means agentnomad cannot tell.
 */
const PluginsManifestSchema = z.looseObject({ plugins: z.array(z.unknown()) });
const PluginEntrySchema = z.looseObject({
  pluginId: z.string().optional(),
  name: z.string().optional(),
  marketplaceName: z.string().optional(),
  installationPreference: z.string().optional(),
});
const MarketplacesSchema = z.array(z.unknown());
const MarketplaceSchema = z.looseObject({ name: z.string(), scope: z.string() });

/** One entry of an account's synced plugins manifest, with its marketplace's scope. */
export interface SyncedPlugin {
  readonly pluginId: string | undefined;
  readonly name: string | undefined;
  /** The `scope` of its marketplace; `undefined` when `.marketplaces.json` does not list it. */
  readonly scope: string | undefined;
  /** `available`, `required`, `auto_install` or `not_available` (2.1.295). */
  readonly installationPreference: string | undefined;
}

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
  const plugins =
    pluginsText === null ? null : valueOrNull(parseJsonWith(PluginsManifestSchema, pluginsText));
  if (marketplaces === null || plugins === null) return 'unreadable';
  const scopeOf = new Map<string, string>();
  for (const row of marketplaces) {
    const marketplace = MarketplaceSchema.safeParse(row);
    if (marketplace.success) scopeOf.set(marketplace.data.name, marketplace.data.scope);
  }
  return plugins.plugins.flatMap((entry) => {
    const plugin = PluginEntrySchema.safeParse(entry);
    if (!plugin.success) return [];
    const { pluginId, name, marketplaceName, installationPreference } = plugin.data;
    return [
      {
        pluginId,
        name,
        scope: marketplaceName === undefined ? undefined : scopeOf.get(marketplaceName),
        installationPreference,
      },
    ];
  });
}

/** Marketplace scopes whose plugins are never the user's own. */
export const NOT_OWN_SCOPES: ReadonlySet<string> = new Set(['org', 'default']);
