/**
 * The `claude` command of the e2e PCs that pull (T100): pull reinstalls saved plugins with it,
 * and the real Claude Code is never run (it would clone marketplaces from the network). It
 * answers as Claude Code 2.1.296 does: `--json` result lines, and an install that records the
 * plugin in `~/.claude/plugins` at the latest version, 9.9.0, as Claude Code cannot install
 * an older one. A marketplace added from a folder (T98) is known by the name in its catalog,
 * and `plugin validate --json` reports on the folder it is given (T104), so pull's review of a
 * plugin or mod (T97) takes each of its three ways in the e2e: written, needs a yes, broken.
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

/**
 * `plugin validate --json <folder>` as Claude Code 2.1.296 reports it (T96, T97 probes), from
 * the folder's own files (T104): a manifest that does not parse is an error (exit 1); without
 * an author it is a warning; each module `hooks/hooks.json` names gets a `hooks:` line (the
 * events it passes to `on`) and a `calls:` line (the `$` methods it calls, sorted).
 */
async function validate(folder: string) {
  const file = (path: string) => `${folder}/${path}`.replace(/\\/g, '/');
  const text = (path: string) =>
    readFile(join(folder, ...path.split('/')), 'utf8').catch(() => null);
  const entry = (path: string, type: string, extra: object) => ({
    file: file(path),
    type,
    errors: [],
    warnings: [],
    notes: [],
    gatingHooks: [],
    ...extra,
  });
  /** A JSON file of the folder, or why it does not parse (also when it is missing). */
  const json = async (path: string): Promise<{ value: unknown } | { problem: string }> => {
    try {
      return { value: JSON.parse((await text(path)) ?? '') };
    } catch (error) {
      return { problem: `Invalid JSON syntax: ${error instanceof Error ? error.message : ''}` };
    }
  };
  const read = await json('.claude-plugin/plugin.json');
  const manifest = 'value' in read ? (read.value as { author?: unknown }) : null;
  const problem = 'problem' in read ? read.problem : '';
  const hooksRead = await json('hooks/hooks.json');
  const hooks = 'value' in hooksRead ? (hooksRead.value as { modules?: string[] }) : null;
  const notes: string[] = [];
  for (const module of hooks?.modules ?? []) {
    const source = (await text(`hooks/${module.replace(/^\.\//, '')}`)) ?? '';
    const events = [...source.matchAll(/\bon\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
    const calls = [...new Set(source.match(/\$(?:\.[A-Za-z_]\w*)+/g) ?? [])].sort();
    notes.push(`${module} hooks: ${events.join(', ')}`);
    notes.push(`${module} calls: ${calls.length === 0 ? 'nothing on $' : calls.join(', ')}`);
  }
  return {
    success: manifest !== null,
    strict: false,
    target: file('.claude-plugin/plugin.json'),
    manifest: entry('.claude-plugin/plugin.json', 'plugin', {
      ...(manifest === null && { errors: [{ path: 'json', message: problem, code: null }] }),
      ...(manifest !== null &&
        manifest.author === undefined && {
          warnings: [
            {
              path: 'author',
              message:
                'No author information provided. Consider adding author details for plugin attribution',
              code: null,
            },
          ],
        }),
    }),
    contents: hooks === null ? [] : [entry('hooks/hooks.json', 'hooks', { notes })],
    advice: [],
  };
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
  const report = await validate(fourth);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.success) process.exitCode = 1;
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
