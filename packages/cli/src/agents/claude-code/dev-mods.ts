import { readdir } from 'node:fs/promises';
import type { PlatformPath } from 'node:path';

import { CLAUDE_CODE_PATHS as DATA } from './claude-code-paths.data.ts';

/*
 * Mods in development (T103): while a session develops a mod, Claude Code keeps it in
 * `<base>/dev-mods/<session-id>/<mod-name>/` and deletes it after `cleanupPeriodDays`. The
 * folder is known state, never pushed; push names each mod there so the user can keep it.
 */

/** The folders in `dir`, by name; none when it cannot be read. */
async function folderNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** The names of the mods in `<baseDir>/dev-mods/`, two levels down, sorted, each once. */
export async function readDevMods(path: PlatformPath, baseDir: string): Promise<string[]> {
  const root = path.join(baseDir, DATA.plugins.devMods);
  const mods = new Set<string>();
  for (const session of await folderNames(root)) {
    for (const mod of await folderNames(path.join(root, session))) mods.add(mod);
  }
  return [...mods].sort();
}

/** What push says about mods in development, or `null` when there are none. */
export function devModsNotice(mods: readonly string[]): string | null {
  if (mods.length === 0) return null;
  return `Mods in development (dev-mods/) are not saved, and Claude Code deletes them after a while: ${mods.join(', ')}. To keep one, move it to skills/ or a marketplace.`;
}
