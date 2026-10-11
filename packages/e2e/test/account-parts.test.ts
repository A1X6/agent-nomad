import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { startLocalServer } from '../src/local-server.ts';
import { newPc, read, write, type RunResult } from '../src/pc.ts';

/**
 * T114: the user's own claude.ai skills (T42) and plugins (T101) are saved and put back by
 * default, so a plain `push --yes` on one PC and `pull --yes` on a second PC without that
 * claude.ai account carry both across as a local skill and a local plugin. Runs on this OS
 * only, never in the CI step jobs.
 */
const FAKE_CLAUDE = fileURLToPath(new URL('../dist/src/fake-claude.js', import.meta.url));
const LOGIN = ['--username', 'e2e-account-parts', '--password-stdin'];
const stdin = 'amber-harbor-violet-cedar-71\n';

/** The folder Claude Code 2.1.296 syncs one claude.ai account into: `<org>_<account>`. */
const ACCOUNT = '22222222-2222-4222-8222-222222222222_33333333-3333-4333-8333-333333333333';
const SKILL = 'my-custom';
const SKILL_MD = `---\nname: ${SKILL}\n---\nA skill made on claude.ai.\n`;
const PLUGIN = 'my-upload';
const PLUGIN_JSON = JSON.stringify({ name: PLUGIN, version: '1.0.0' });
const UPDATED = '2026-10-09T00:00:00Z';

const ok = (result: RunResult) => {
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result;
};

/** The claude.ai synced files of one account: a skill of the user's and a plugin they uploaded. */
async function syncedAccount(claude: string): Promise<void> {
  const skills = join(claude, 'skills', 'synced', ACCOUNT);
  const plugins = join(claude, 'plugins', 'synced', ACCOUNT);
  await write(
    join(skills, 'manifest.json'),
    JSON.stringify({
      lastUpdated: 1760000000000,
      skills: [
        {
          skillId: 'skill_02custom',
          name: SKILL,
          description: 'Mine.',
          source: 'custom',
          updatedAt: UPDATED,
        },
      ],
    }),
  );
  await write(join(skills, SKILL, 'SKILL.md'), SKILL_MD);
  await write(
    join(plugins, 'manifest.json'),
    JSON.stringify({
      lastUpdated: 1760000000000,
      plugins: [
        {
          pluginId: 'plugin_01upload',
          name: PLUGIN,
          description: 'A plugin the user uploaded.',
          version: '1.0.0',
          updatedAt: UPDATED,
          marketplaceName: 'my-uploads',
          installationPreference: 'available',
        },
      ],
    }),
  );
  await write(
    join(plugins, '.marketplaces.json'),
    JSON.stringify({
      etag: '"e2026-10-09"',
      parserVersion: 1,
      rows: [
        {
          name: 'my-uploads',
          display_name: 'My Uploads',
          scope: 'account',
          source: { source: 'claudeai' },
          id: 'mkt_03account',
          updated_at: UPDATED,
        },
      ],
    }),
  );
  await write(join(plugins, PLUGIN, '.claude-plugin', 'plugin.json'), PLUGIN_JSON);
}

it.skipIf(process.env['E2E_STEP'] !== undefined)(
  'push --yes and pull --yes carry claude.ai skills and plugins to a PC without that account',
  async () => {
    const server = await startLocalServer(undefined);
    const first = await newPc('account-first', { apiUrl: server.url, keychain: false });
    const second = await newPc('account-second', {
      apiUrl: server.url,
      keychain: false,
      claude: FAKE_CLAUDE,
    });
    try {
      await syncedAccount(join(first.home, '.claude'));
      ok(await first.run(['register', ...LOGIN, '--yes'], stdin));
      ok(await first.run(['push', '--global', '--yes']));

      ok(await second.run(['login', ...LOGIN], stdin));
      const pulled = ok(await second.run(['pull', '--global', '--yes']));
      const said = `${pulled.stdout}\n${pulled.stderr}`;
      const here = join(second.home, '.claude', 'skills');
      expect(await read(join(here, SKILL, 'SKILL.md'))).toBe(SKILL_MD);
      expect(await read(join(here, PLUGIN, '.claude-plugin', 'plugin.json'))).toBe(PLUGIN_JSON);
      expect(said).toContain(`Added ${SKILL} as local skills.`);
    } finally {
      await Promise.all([first.remove(), second.remove()]);
      await server.close();
    }
  },
);
