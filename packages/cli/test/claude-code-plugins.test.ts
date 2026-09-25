import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createClaudeCodeGlobalCollector,
  globalDestination,
  marketplaceAddArgument,
  planPluginSync,
  PluginManifestSchema,
  projectDestination,
  readCurrentPlugins,
  readPluginManifest,
  syncPlugins,
  type ClaudeCli,
  type PluginManifest,
} from '../src/index.ts';

let root: string;
let base: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentnomad-plugins-'));
  base = join(root, '.claude');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

const project = () => join(root, 'work', 'app');

/** Manifests shaped like a real ~/.claude/plugins folder. */
async function realisticPlugins(): Promise<void> {
  const install = (scope: string, extra: object = {}) => [
    { scope, installPath: 'x', version: '1.0.0', installedAt: '2026-09-21T00:00:00Z', ...extra },
  ];
  await put(join(base, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'brag@brag': install('user'),
      'warp@claude-code-warp': install('user'),
      'mine@local-tools': install('user'),
      'team-lint@company': install('project', { projectPath: project() }),
      'other@company': install('project', { projectPath: join(root, 'elsewhere') }),
      'builder@company': install('user'),
      'notes@claudeai-organization-library': install('user'),
      'gone@deleted-market': install('user'),
    },
  });
  const marketplaces = {
    brag: { source: { source: 'github', repo: 'latent-spaces/brag' } },
    'claude-code-warp': {
      source: { source: 'github', repo: 'warpdotdev/claude-code-warp', ref: 'v2' },
    },
    'local-tools': { source: { source: 'directory', path: 'C:/tools/market' } },
    company: {
      source: { source: 'git', url: 'https://gitlab.example.com/team/plugins.git' },
      installLocation: join(base, 'plugins', 'marketplaces', 'company'),
    },
  };
  await put(join(base, 'plugins', 'known_marketplaces.json'), marketplaces);
  await put(
    join(base, 'plugins', 'marketplaces', 'company', '.claude-plugin', 'marketplace.json'),
    {
      name: 'company',
      plugins: [
        { name: 'team-lint', source: './lint' },
        { name: 'builder', source: { source: 'command', command: 'make plugin' } },
      ],
    },
  );
}

describe('plugin list on push', () => {
  it('saves user plugins with addable marketplaces, and says what was left out', async () => {
    await realisticPlugins();
    const manifest = await readPluginManifest({
      baseDir: base,
      platform: process.platform,
      scope: { kind: 'global' },
    });
    expect(manifest).toEqual({
      marketplaces: [
        { name: 'brag', add: 'latent-spaces/brag' },
        { name: 'claude-code-warp', add: 'warpdotdev/claude-code-warp#v2' },
        { name: 'company', add: 'https://gitlab.example.com/team/plugins.git' },
      ],
      plugins: [
        { id: 'brag@brag', scope: 'user', commandSource: false },
        { id: 'builder@company', scope: 'user', commandSource: true },
        { id: 'warp@claude-code-warp', scope: 'user', commandSource: false },
      ],
      skipped: [
        { what: 'mine@local-tools', reason: 'its marketplace is a local folder or unknown source' },
        {
          what: 'notes@claudeai-organization-library',
          reason: 'comes with your claude.ai account',
        },
        { what: 'gone@deleted-market', reason: 'its marketplace is missing' },
      ],
    });
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('a project push saves only that project’s plugins', async () => {
    await realisticPlugins();
    const manifest = await readPluginManifest({
      baseDir: base,
      platform: process.platform,
      scope: { kind: 'project', projectDir: project() },
    });
    expect(manifest?.plugins).toEqual([
      { id: 'team-lint@company', scope: 'project', commandSource: false },
    ]);
    expect(manifest?.marketplaces.map((entry) => entry.name)).toEqual(['company']);
  });

  it('nothing to save without installed plugins', async () => {
    expect(
      await readPluginManifest({
        baseDir: base,
        platform: process.platform,
        scope: { kind: 'global' },
      }),
    ).toBeNull();
  });

  it('the global collector adds .agentnomad/plugins.json, which restore never writes', async () => {
    await realisticPlugins();
    const files = await createClaudeCodeGlobalCollector({
      baseDir: base,
      homedir: root,
      platform: process.platform,
      customConfigDir: false,
    }).collect({ kind: 'global' }, { includeMemory: false });
    expect(files.map((file) => file.path)).toEqual(['.agentnomad/plugins.json']);
    expect(globalDestination('.agentnomad/plugins.json')).toEqual({ kind: 'metadata' });
    expect(projectDestination('.agentnomad/plugins.json')).toEqual({ kind: 'metadata' });
  });

  it.each([
    [{ source: 'github', repo: 'a/b' }, 'a/b'],
    [{ source: 'github', repo: 'a/b', ref: 'v1.2.0' }, 'a/b#v1.2.0'],
    [{ source: 'git', url: 'https://host/x.git', ref: 'main' }, 'https://host/x.git#main'],
    [{ source: 'git', url: 'git@host:x.git' }, 'git@host:x.git'],
    [
      { source: 'url', url: 'https://example.com/marketplace.json' },
      'https://example.com/marketplace.json',
    ],
    [{ source: 'url', url: 'http://example.com/m.json' }, null],
    [{ source: 'directory', path: './m' }, null],
    [{ source: 'file', path: '/m.json' }, null],
    [{ source: 'github', repo: '--evil' }, null],
  ])('marketplace %j is added as %j', (source, expected) => {
    expect(marketplaceAddArgument(source)).toBe(expected);
  });

  it('refuses a manifest that could smuggle options or shell characters', () => {
    const bad = (add: string) =>
      PluginManifestSchema.safeParse({
        marketplaces: [{ name: 'm', add }],
        plugins: [],
        skipped: [],
      }).success;
    expect(bad('--scope')).toBe(false);
    expect(bad('a/b & calc')).toBe(false);
    expect(bad('a/b"')).toBe(false);
    expect(bad('a/b')).toBe(true);
  });
});

const manifest: PluginManifest = {
  marketplaces: [
    { name: 'brag', add: 'latent-spaces/brag' },
    { name: 'company', add: 'https://gitlab.example.com/team/plugins.git' },
  ],
  plugins: [
    { id: 'brag@brag', scope: 'user', commandSource: false },
    { id: 'builder@company', scope: 'user', commandSource: true },
    { id: 'lint@company', scope: 'project', commandSource: false },
  ],
  skipped: [],
};

function fakeClaude(failures: Record<string, string> = {}) {
  const runs: string[] = [];
  const claude: ClaudeCli = {
    run: (args, cwd) => {
      runs.push(`${args.join(' ')} @ ${cwd}`);
      const key = args.join(' ');
      const failure = Object.entries(failures).find(([part]) => key.includes(part))?.[1];
      if (args[1] === 'install') {
        const outcome = failure
          ? { outcome: 'failed', message: failure }
          : { outcome: 'ok', message: 'Installed' };
        return Promise.resolve({
          exitCode: failure ? 1 : 0,
          stdout: `note\n${JSON.stringify(outcome)}`,
          stderr: '',
        });
      }
      return Promise.resolve({ exitCode: failure ? 1 : 0, stdout: '', stderr: failure ?? '' });
    },
  };
  return { claude, runs };
}

function run(options: {
  answers?: boolean[];
  failures?: Record<string, string>;
  current?: Parameters<typeof planPluginSync>[1];
  assumeYes?: boolean;
}) {
  const answers = [...(options.answers ?? [true, true])];
  const asked: string[] = [];
  const lines: string[] = [];
  const { claude, runs } = fakeClaude(options.failures);
  const done = syncPlugins({
    manifest,
    current: options.current ?? { marketplaces: new Set(), installed: new Set() },
    claude,
    prompter: {
      confirm: (question) => {
        asked.push(question);
        return Promise.resolve(answers.shift() ?? false);
      },
    },
    reporter: {
      info: (m) => lines.push(m),
      success: (m) => lines.push(m),
      warn: (m) => lines.push(m),
    },
    cwd: '/work/app',
    ...(options.assumeYes !== undefined && { assumeYes: options.assumeYes }),
  });
  return { done, asked, lines, runs };
}

describe('plugin reinstall on pull', () => {
  it('adds the marketplaces, then installs each plugin in its scope', async () => {
    const t = run({});
    expect(await t.done).toEqual({
      installed: ['brag@brag', 'builder@company', 'lint@company'],
      failed: [],
      declined: [],
    });
    expect(t.runs).toEqual([
      'plugin marketplace add latent-spaces/brag @ /work/app',
      'plugin marketplace add https://gitlab.example.com/team/plugins.git @ /work/app',
      'plugin install brag@brag --scope user --json @ /work/app',
      'plugin install builder@company --scope user --json --yes @ /work/app',
      'plugin install lint@company --scope project --json @ /work/app',
    ]);
  });

  it('asks once for the list, and separately for a plugin that runs a command', async () => {
    const t = run({ answers: [true, false] });
    const result = await t.done;
    expect(t.asked).toEqual([
      'Reinstall 3 plugins?',
      'builder@company is built by running a command from its marketplace. Allow it?',
    ]);
    expect(result.declined).toEqual(['builder@company']);
    expect(t.runs.some((line) => line.includes('builder'))).toBe(false);
  });

  it('does nothing when the user says no', async () => {
    const t = run({ answers: [false] });
    expect((await t.done).declined).toHaveLength(3);
    expect(t.runs).toEqual([]);
  });

  it('with --yes never runs a command-source plugin: skipped with a note, not asked', async () => {
    const t = run({ answers: [], assumeYes: true });
    const result = await t.done;
    expect(t.asked).toEqual([]);
    expect(result.declined).toEqual(['builder@company']);
    expect(result.installed).toEqual(['brag@brag', 'lint@company']);
    expect(t.runs.some((line) => line.includes('builder'))).toBe(false);
    expect(t.lines).toContain(
      'Skipped builder@company: it is built by running a command, which --yes never allows. Run pull without --yes to choose.',
    );
  });

  it('skips what is already here', async () => {
    const t = run({
      current: {
        marketplaces: new Set(['brag', 'company']),
        installed: new Set(['brag@brag|user', 'builder@company|user']),
      },
    });
    await t.done;
    expect(t.runs).toEqual(['plugin install lint@company --scope project --json @ /work/app']);
  });

  it('reports failures with the reason, and skips plugins of a marketplace that failed', async () => {
    const t = run({
      failures: { 'gitlab.example.com': 'Repository not found', 'brag@brag': 'Network error' },
    });
    const result = await t.done;
    expect(result.installed).toEqual([]);
    expect(result.failed).toEqual([
      { what: 'marketplace company', reason: 'Repository not found' },
      { what: 'brag@brag', reason: 'Network error' },
      { what: 'builder@company', reason: 'marketplace company could not be added' },
      { what: 'lint@company', reason: 'marketplace company could not be added' },
    ]);
  });

  it('plans only what is missing', () => {
    expect(
      planPluginSync(manifest, {
        marketplaces: new Set(['brag']),
        installed: new Set(['brag@brag|user']),
      }),
    ).toEqual({
      marketplaces: [{ name: 'company', add: 'https://gitlab.example.com/team/plugins.git' }],
      plugins: manifest.plugins.slice(1),
      alreadyInstalled: [manifest.plugins[0]],
    });
  });

  it('reads what this PC already has', async () => {
    await realisticPlugins();
    const current = await readCurrentPlugins(base, project());
    expect(current.marketplaces.has('brag')).toBe(true);
    expect(current.installed.has('brag@brag|user')).toBe(true);
    expect(current.installed.has('team-lint@company|project')).toBe(true);
    expect(current.installed.has('other@company|project')).toBe(false);
  });
});
