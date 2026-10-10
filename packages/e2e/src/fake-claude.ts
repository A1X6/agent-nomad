/**
 * The `claude` command of the e2e PCs that pull (T100): pull reinstalls saved plugins with it,
 * and the real Claude Code is never run (it would clone marketplaces from the network). It
 * answers as Claude Code 2.1.296 does: `--json` result lines, and an install that records the
 * plugin in `~/.claude/plugins` at the latest version, 9.9.0, as Claude Code cannot install
 * an older one. A marketplace added from a folder (T98) is known by the name in its catalog,
 * and `plugin validate --json` passes a mod with one warning, as T97's review expects.
 *
 * Usage (built, through the launcher pc.ts writes): node dist/src/fake-claude.js <arguments>
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const plugins = join(homedir(), '.claude', 'plugins');

/** Adds `entries` to one of Claude Code's JSON files in `~/.claude/plugins`. */
async function record(file: string, entries: (json: Record<string, unknown>) => void) {
  const path = join(plugins, file);
  const json = JSON.parse(await readFile(path, 'utf8').catch(() => '{}')) as Record<
    string,
    unknown
  >;
  entries(json);
  await mkdir(plugins, { recursive: true });
  await writeFile(path, JSON.stringify(json, null, 2));
}

const ok = (command: string) => {
  process.stdout.write(`${JSON.stringify({ command, outcome: 'ok' })}\n`);
};

const args = process.argv.slice(2);
const [first, second, third, fourth] = args;
const scope = args.includes('--scope') ? args[args.indexOf('--scope') + 1] : 'user';

if (first === '--version') {
  process.stdout.write('2.1.296 (Claude Code)\n');
} else if (first === 'plugin' && second === 'marketplace' && third === 'add' && fourth) {
  // A folder (T98): known by the name in its catalog, from where it is. Else `owner/repo`:
  // known by its repository name.
  const catalog = await readFile(join(fourth, '.claude-plugin', 'marketplace.json'), 'utf8').catch(
    () => null,
  );
  await record('known_marketplaces.json', (json) => {
    if (catalog === null) {
      json[fourth.split('/').pop() ?? fourth] = { source: { source: 'github', repo: fourth } };
    } else {
      const { name } = JSON.parse(catalog) as { name: string };
      json[name] = { source: { source: 'directory', path: fourth }, installLocation: fourth };
    }
  });
  ok('marketplace-add');
} else if (first === 'plugin' && second === 'validate' && third === '--json' && fourth) {
  // A mod with one module, as Claude Code 2.1.296 reports it without an author (T96's
  // `validatePassWithWarning`): passed with a warning, exit 0.
  const file = (path: string) => `${fourth}/${path}`.replace(/\\/g, '/');
  const entry = (path: string, type: string, extra: object) => ({
    file: file(path),
    type,
    errors: [],
    warnings: [],
    notes: [],
    gatingHooks: [],
    ...extra,
  });
  const report = {
    success: true,
    strict: false,
    target: file('.claude-plugin/plugin.json'),
    manifest: entry('.claude-plugin/plugin.json', 'plugin', {
      warnings: [
        {
          path: 'author',
          message:
            'No author information provided. Consider adding author details for plugin attribution',
          code: null,
        },
      ],
    }),
    contents: [
      entry('hooks/hooks.json', 'hooks', {
        notes: ['./register.ts hooks: session.start', './register.ts calls: $.store.get'],
      }),
    ],
    advice: [],
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else if (first === 'plugin' && second === 'install' && third !== undefined) {
  await record('installed_plugins.json', (json) => {
    const installed = (json['plugins'] ?? {}) as Record<string, unknown>;
    installed[third] = [{ scope, installPath: 'x', version: '9.9.0' }];
    Object.assign(json, { version: 2, plugins: installed });
  });
  ok('install');
} else {
  process.stderr.write(`Not scripted: claude ${process.argv.slice(2).join(' ')}\n`);
  process.exitCode = 1;
}
