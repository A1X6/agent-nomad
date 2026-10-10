import { execFile } from 'node:child_process';
import { mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { startLocalServer } from '../src/local-server.ts';
import { newPc, read, write, type RunResult } from '../src/pc.ts';

/**
 * T98: marketplaces added from a local folder, each with a mod installed, restore on a second
 * PC: a folder outside git (and outside home), a clean clone of a reachable remote (a local
 * bare repository), a remote deleted before the pull, and a repository with an unpushed
 * commit, an edit, a new file and an ignored one. Push and pull run on this OS only (the bare
 * repositories are folders here), so it runs once, never in the CI step jobs.
 */
const run = promisify(execFile);
const FAKE_CLAUDE = fileURLToPath(new URL('../dist/src/fake-claude.js', import.meta.url));
const LOGIN = ['--username', 'e2e-markets', '--password-stdin'];
const stdin = 'quartz-lantern-meadow-pilot-58\n';

const MOD_MODULE =
  'export function register(on, options) {\n  on("session.start", async ($, e) => {\n    await $.store.get("e2e-seen");\n  });\n}\n';
const EDIT = '# Edited, not committed\n';
const NEW_FILE = 'A new file, not committed.\n';

/** A marketplace named `name` in `dir`, with the mod `lm-mod` in it. */
async function marketplace(dir: string, name: string): Promise<void> {
  await write(
    join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name,
      owner: { name: 'e2e' },
      plugins: [{ name: 'lm-mod', source: './lm-mod' }],
    }),
  );
  await write(
    join(dir, 'lm-mod', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'lm-mod' }),
  );
  await write(
    join(dir, 'lm-mod', 'hooks', 'hooks.json'),
    JSON.stringify({ modules: ['./register.ts'] }),
  );
  await write(join(dir, 'lm-mod', 'hooks', 'register.ts'), MOD_MODULE);
  await write(join(dir, 'README.md'), `# ${name}\n`);
}

/** Runs git in `cwd` with no user or system configuration of this machine. */
async function git(cwd: string, config: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'e2e',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'e2e',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
    },
  });
  return stdout.trim();
}

/** `dir` as a repository with every file committed and pushed to a new bare `remote`. */
async function pushedRepo(dir: string, remote: string, config: string): Promise<void> {
  await git(dirname(remote), config, 'init', '--bare', '--quiet', '-b', 'main', remote);
  await git(dir, config, 'init', '--quiet', '-b', 'main');
  await git(dir, config, 'add', '-A');
  await git(dir, config, 'commit', '--quiet', '-m', 'marketplace');
  await git(dir, config, 'remote', 'add', 'origin', remote);
  await git(dir, config, 'push', '--quiet', '-u', 'origin', 'main');
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const ok = (result: RunResult) => {
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result;
};

const NAMES = ['lm-clean', 'lm-gone', 'lm-plain', 'lm-unpushed'] as const;

it.skipIf(process.env['E2E_STEP'] !== undefined)(
  'local marketplaces with a mod restore on a second PC, re-cloned where the remote has the commit',
  async () => {
    const server = await startLocalServer(undefined);
    const remotes = await realpath(await mkdtemp(join(tmpdir(), 'agentnomad-e2e-remotes-')));
    const config = join(remotes, 'gitconfig');
    await writeFile(config, '');
    const first = await newPc('lm-first', { apiUrl: server.url, keychain: false });
    const second = await newPc('lm-second', {
      apiUrl: server.url,
      keychain: false,
      claude: FAKE_CLAUDE,
    });
    try {
      // On the first PC: four marketplaces, each added from its folder, each mod installed.
      const folders: Record<(typeof NAMES)[number], string> = {
        // Outside home and outside git: pull writes it to ~/.agentnomad/marketplaces.
        'lm-plain': join(dirname(first.home), 'market-plain'),
        'lm-clean': join(first.home, 'markets', 'clean'),
        'lm-gone': join(first.home, 'markets', 'gone'),
        'lm-unpushed': join(first.home, 'markets', 'unpushed'),
      };
      for (const name of NAMES) await marketplace(folders[name], name);
      await pushedRepo(folders['lm-clean'], join(remotes, 'clean.git'), config);
      await pushedRepo(folders['lm-gone'], join(remotes, 'gone.git'), config);
      const unpushed = folders['lm-unpushed'];
      await write(join(unpushed, '.gitignore'), 'secret.log\n');
      await pushedRepo(unpushed, join(remotes, 'unpushed.git'), config);
      await write(join(unpushed, 'CHANGELOG.md'), 'Committed, never pushed.\n');
      await git(unpushed, config, 'add', 'CHANGELOG.md');
      await git(unpushed, config, 'commit', '--quiet', '-m', 'not pushed');
      await write(join(unpushed, 'README.md'), EDIT);
      await write(join(unpushed, 'notes.md'), NEW_FILE);
      await write(join(unpushed, 'secret.log'), 'ignored by git\n');
      const cleanCommit = await git(folders['lm-clean'], config, 'rev-parse', 'HEAD');

      const plugins = join(first.home, '.claude', 'plugins');
      await write(
        join(plugins, 'known_marketplaces.json'),
        JSON.stringify(
          Object.fromEntries(
            NAMES.map((name) => [name, { source: { source: 'directory', path: folders[name] } }]),
          ),
        ),
      );
      await write(
        join(plugins, 'installed_plugins.json'),
        JSON.stringify({
          version: 2,
          plugins: Object.fromEntries(
            NAMES.map((name) => [
              `lm-mod@${name}`,
              [{ scope: 'user', installPath: 'x', version: 'unknown' }],
            ]),
          ),
        }),
      );
      ok(await first.run(['register', ...LOGIN, '--yes'], stdin));
      expect(ok(await first.run(['push', '--global', '--yes'])).stdout).toContain(
        'Saved the Claude Code global setup',
      );
      // The remote of lm-gone is gone by the time the second PC pulls.
      await rm(join(remotes, 'gone.git'), { recursive: true, force: true });

      ok(await second.run(['login', ...LOGIN], stdin));
      const pulled = ok(await second.run(['pull', '--global', '--yes', '--allow-commands']));
      const said = `${pulled.stdout}\n${pulled.stderr}`;
      const here = {
        'lm-plain': join(second.home, '.agentnomad', 'marketplaces', 'lm-plain'),
        'lm-clean': join(second.home, 'markets', 'clean'),
        'lm-gone': join(second.home, 'markets', 'gone'),
        'lm-unpushed': join(second.home, 'markets', 'unpushed'),
      };
      for (const name of NAMES) {
        expect(await read(join(here[name], 'lm-mod', 'hooks', 'register.ts'))).toBe(MOD_MODULE);
        expect(said).toContain(`+ lm-mod@${name}`);
      }
      // Re-cloned at the saved commit, and the folder is as git left it on the first PC.
      expect(await git(here['lm-clean'], config, 'rev-parse', 'HEAD')).toBe(cleanCommit);
      expect(await git(here['lm-clean'], config, 'status', '--porcelain')).toBe('');
      // No re-clone: the remote is gone, or the commit was never pushed. The files came.
      expect(said).toContain('Could not re-clone the marketplace lm-gone');
      expect(await exists(join(here['lm-gone'], '.git'))).toBe(false);
      expect(await exists(join(here['lm-unpushed'], '.git'))).toBe(false);
      expect(await read(join(here['lm-unpushed'], 'README.md'))).toBe(EDIT);
      expect(await read(join(here['lm-unpushed'], 'notes.md'))).toBe(NEW_FILE);
      expect(await read(join(here['lm-unpushed'], 'CHANGELOG.md'))).toBe(
        'Committed, never pushed.\n',
      );
      expect(await exists(join(here['lm-unpushed'], 'secret.log'))).toBe(false);
      expect(await readdir(here['lm-plain'])).not.toContain('.git');

      // Claude Code added each one from the folder pull wrote, and installed each mod.
      const known = JSON.parse(
        await read(join(second.home, '.claude', 'plugins', 'known_marketplaces.json')),
      ) as Record<string, { source: { path?: string } }>;
      for (const name of NAMES) expect(known[name]?.source.path).toBe(here[name]);
      expect(said).toContain(
        'Reinstalled lm-mod@lm-clean, lm-mod@lm-gone, lm-mod@lm-plain, lm-mod@lm-unpushed.',
      );

      // Pulling again writes nothing and asks nothing.
      const again = ok(
        await second.run(['pull', '--global', '--merge', '--yes', '--allow-commands']),
      );
      expect(again.stdout).toContain('Restored the Claude Code global setup: 0 written');
    } finally {
      await Promise.all([
        first.remove(),
        second.remove(),
        rm(remotes, { recursive: true, force: true }),
      ]);
      await server.close();
    }
  },
);
