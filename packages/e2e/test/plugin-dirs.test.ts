import { delimiter, dirname, join } from 'node:path';

import { expect, it } from 'vitest';

import { FAKE_CLAUDE, MOD_MODULE, writeMod } from '../src/fixtures.ts';
import { expectNoLeaks, secretsOf } from '../src/leaks.ts';
import { startLocalServer } from '../src/local-server.ts';
import { newPc, read, write, type RunResult } from '../src/pc.ts';

/**
 * T99: plugin folders the user settings load through `env.CLAUDE_CODE_PLUGIN_DIRS`, one in
 * home and one outside it, restore on a second PC, and the value there names the folders pull
 * wrote. Push and pull run on this OS only (cross-OS is T104), so it runs once, never in the
 * CI step jobs.
 */
const USER = { username: 'e2e-plugin-dirs', password: 'amber-harbor-violet-sketch-73' };
const LOGIN = ['--username', USER.username, '--password-stdin'];
const stdin = `${USER.password}\n`;

const ok = (result: RunResult) => {
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result;
};

/** The value in the settings of the PC whose home is `home`. */
async function valueOf(home: string): Promise<string | undefined> {
  const settings = JSON.parse(await read(join(home, '.claude', 'settings.json'))) as {
    env?: Record<string, string>;
  };
  return settings.env?.['CLAUDE_CODE_PLUGIN_DIRS'];
}

it.skipIf(process.env['E2E_STEP'] !== undefined)(
  'plugin folders set in CLAUDE_CODE_PLUGIN_DIRS restore on a second PC, the value pointing at them',
  async () => {
    const server = await startLocalServer(undefined);
    const first = await newPc('pd-first', { apiUrl: server.url, keychain: false });
    const second = await newPc('pd-second', {
      apiUrl: server.url,
      keychain: false,
      claude: FAKE_CLAUDE,
    });
    try {
      // On the first PC: one folder in home, one outside it, both in the user settings.
      const inHome = join(first.home, 'dev', 'pd-home');
      const outside = join(dirname(first.home), 'pd-outside');
      await writeMod(inHome, 'pd-home');
      await writeMod(outside, 'pd-outside');
      await write(
        join(first.home, '.claude', 'settings.json'),
        JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: [inHome, outside].join(delimiter) } }),
      );
      ok(await first.run(['register', ...LOGIN, '--yes'], stdin));
      ok(await first.run(['push', '--global', '--yes']));

      ok(await second.run(['login', ...LOGIN], stdin));
      const pulled = ok(await second.run(['pull', '--global', '--yes', '--allow-commands']));
      const said = `${pulled.stdout}\n${pulled.stderr}`;
      const here = [
        join(second.home, 'dev', 'pd-home'),
        join(second.home, '.agentnomad', 'plugin-dirs', 'pd-outside'),
      ];
      for (const dir of here) {
        expect(await read(join(dir, 'hooks', 'register.ts'))).toBe(MOD_MODULE);
      }
      // Reviewed before it was written (T97), as Claude Code names a folder it loads this way.
      expect(said).toContain('+ pd-home@inline');
      // Claude Code on this PC loads the folders pull wrote.
      expect(await valueOf(second.home)).toBe(here.join(delimiter));

      // Pulling again writes nothing and asks nothing.
      const again = ok(
        await second.run(['pull', '--global', '--merge', '--yes', '--allow-commands']),
      );
      expect(again.stdout).toContain('Restored the Claude Code global setup: 0 written');

      expectNoLeaks(server, await secretsOf(USER, first, second), [
        MOD_MODULE,
        'pd-home',
        'pd-outside',
      ]);
    } finally {
      await Promise.all([first.remove(), second.remove()]);
      await server.close();
    }
  },
);
