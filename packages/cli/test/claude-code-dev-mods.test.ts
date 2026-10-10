import path, { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { useTempDir, writeTestFile } from './fakes.ts';
import { devModsNotice, readDevMods } from '../src/index.ts';

/** Mods in development (T103): `<base>/dev-mods/<session>/<mod>/`, named by push, never pushed. */

let base: string;
useTempDir('agentnomad-dev-mods-', (dir) => (base = join(dir, '.claude')));

/** A mod Claude Code keeps for one session. */
const devMod = (session: string, mod: string) =>
  writeTestFile(join(base, 'dev-mods', session, mod, '.claude-plugin', 'plugin.json'));

describe('mods in development (T103)', () => {
  it('lists each mod two levels down, sorted, each once', async () => {
    await devMod('session-b', 'probe-mod');
    await devMod('session-a', 'draft-mod');
    await devMod('session-a', 'probe-mod');
    expect(await readDevMods(path, base)).toEqual(['draft-mod', 'probe-mod']);
  });

  it('lists no file as a mod', async () => {
    await writeTestFile(join(base, 'dev-mods', 'session-a', 'notes.txt'));
    expect(await readDevMods(path, base)).toEqual([]);
  });

  it('lists nothing without dev-mods/', async () => {
    expect(await readDevMods(path, base)).toEqual([]);
  });
});

describe("push's notice on mods in development (T103)", () => {
  it('names each mod and how to keep it', () => {
    expect(devModsNotice(['draft-mod', 'probe-mod'])).toBe(
      'Mods in development (dev-mods/) are not saved, and Claude Code deletes them after a while: draft-mod, probe-mod. To keep one, move it to skills/ or a marketplace.',
    );
  });

  it('says nothing without mods', () => {
    expect(devModsNotice([])).toBeNull();
  });
});
