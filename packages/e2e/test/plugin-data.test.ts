import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { FAKE_CLAUDE, writeMod } from '../src/fixtures.ts';
import { expectNoLeaks, secretsOf } from '../src/leaks.ts';
import { startLocalServer } from '../src/local-server.ts';
import { newPc, read, write, type RunResult } from '../src/pc.ts';

/**
 * T102: a mod's saved choice (its `$.store` file) pushed with `--plugin-data` on one PC is
 * there on the second PC after the pull, once the mod is back; the data a removed plugin left
 * in `plugins/data/` never goes into the bundle, so the second PC, which has a plugin of that
 * id installed, gets none of it. Runs on this OS only, never in the CI step jobs.
 */
const USER = { username: 'e2e-plugin-data', password: 'amber-harbor-violet-cedar-71' };
const LOGIN = ['--username', USER.username, '--password-stdin'];
const stdin = `${USER.password}\n`;

const MOD = 'data-mod';
const MOD_MODULE =
  'export function register(on, options) {\n  on("session.start", async ($, e) => {\n    await $.store.set("theme", "dark");\n  });\n}\n';
/** `plugins/store/<file>` of `data-mod@skills-dir`: the safe id, `-`, 12 hex of its SHA-256. */
const STORE_FILE = 'data-mod_skills-dir-9980417a25ab.json';
const CHOICE = '{"theme":"dark"}';
/** A plugin removed on the first PC whose data folder stayed behind. */
const LEFTOVER_ID = 'gone-plugin@inline';
const LEFTOVER_FOLDER = 'gone-plugin-inline';

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const ok = (result: RunResult) => {
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result;
};

it.skipIf(process.env['E2E_STEP'] !== undefined)(
  "a mod's saved choice survives push and pull; a removed plugin's data never goes",
  async () => {
    const server = await startLocalServer(undefined);
    const first = await newPc('data-first', { apiUrl: server.url, keychain: false });
    const second = await newPc('data-second', {
      apiUrl: server.url,
      keychain: false,
      claude: FAKE_CLAUDE,
    });
    try {
      const claude = join(first.home, '.claude');
      await writeMod(join(claude, 'skills', MOD), MOD, MOD_MODULE);
      await write(join(claude, 'plugins', 'store', STORE_FILE), CHOICE);
      await write(join(claude, 'plugins', 'data', LEFTOVER_FOLDER, 'state.json'), '{"old":1}');

      ok(await first.run(['register', ...LOGIN, '--yes'], stdin));
      ok(await first.run(['push', '--global', '--yes', '--plugin-data']));

      // The second PC has a plugin with the leftover's id: saved data of it would be written.
      await write(
        join(second.home, '.claude', 'plugins', 'installed_plugins.json'),
        JSON.stringify({
          version: 2,
          plugins: { [LEFTOVER_ID]: [{ scope: 'user', installPath: 'x', version: '1.0.0' }] },
        }),
      );
      ok(await second.run(['login', ...LOGIN], stdin));
      const pulled = ok(
        await second.run(['pull', '--global', '--yes', '--allow-commands', '--plugin-data']),
      );
      const said = `${pulled.stdout}\n${pulled.stderr}`;
      const here = join(second.home, '.claude');
      expect(await read(join(here, 'skills', MOD, 'hooks', 'register.ts'))).toBe(MOD_MODULE);
      expect(await read(join(here, 'plugins', 'store', STORE_FILE))).toBe(CHOICE);
      expect(said).toContain(`Put back plugin data: ${STORE_FILE}.`);
      expect(said).not.toContain(LEFTOVER_FOLDER);
      expect(await exists(join(here, 'plugins', 'data', LEFTOVER_FOLDER))).toBe(false);

      expectNoLeaks(server, await secretsOf(USER, first, second), [
        CHOICE,
        MOD_MODULE,
        STORE_FILE,
        LEFTOVER_FOLDER,
      ]);
    } finally {
      await Promise.all([first.remove(), second.remove()]);
      await server.close();
    }
  },
);
