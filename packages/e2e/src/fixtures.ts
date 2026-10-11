import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { write } from './pc.ts';

/** The `claude` command of the PCs that pull (T100): installs plugins at version 9.9.0. */
export const FAKE_CLAUDE = fileURLToPath(new URL('../dist/src/fake-claude.js', import.meta.url));

/**
 * The module of a mod: it runs code inside Claude Code (T97). Claude Code 2.1.296's validate
 * passes a mod made of it by {@link writeMod}.
 */
export const MOD_MODULE =
  'export function register(on, options) {\n  on("session.start", async ($, e) => {\n    await $.store.get("e2e-mod-seen");\n  });\n}\n';
export const MOD_HOOKS = JSON.stringify({ modules: ['./register.ts'] });

/** The mod `name` as a plugin folder `dir` of its own, its module `module`. */
export async function writeMod(dir: string, name: string, module = MOD_MODULE): Promise<void> {
  await write(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
  await write(join(dir, 'hooks', 'hooks.json'), MOD_HOOKS);
  await write(join(dir, 'hooks', 'register.ts'), module);
}

/** A marketplace named `name` in the folder `dir` (T98), with the mod `lm-mod` in it. */
export async function writeLocalMarketplace(dir: string, name: string): Promise<void> {
  await write(
    join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name,
      owner: { name: 'e2e' },
      plugins: [{ name: 'lm-mod', source: './lm-mod' }],
    }),
  );
  await writeMod(join(dir, 'lm-mod'), 'lm-mod');
}
