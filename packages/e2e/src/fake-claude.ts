/**
 * The `claude` command of the e2e PCs that pull (T100): pull reinstalls saved plugins with it,
 * and the real Claude Code is never run (it would clone marketplaces from the network). It
 * answers as Claude Code 2.1.296 does: `--json` result lines, and an install that records the
 * plugin in `~/.claude/plugins` at the latest version, 9.9.0, as Claude Code cannot install
 * an older one.
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
  // `plugin marketplace add owner/repo`: known by its repository name.
  await record('known_marketplaces.json', (json) => {
    json[fourth.split('/').pop() ?? fourth] = { source: { source: 'github', repo: fourth } };
  });
  ok('marketplace-add');
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
