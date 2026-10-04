import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach } from 'vitest';

import { writeTestFile } from './fakes.ts';
import type { ManagedSettings } from '../src/index.ts';

/** Plugin files shared by the plugin and plugin sync tests (review 7 READ-01). */

// A temporary root with `.claude` in it, made by `usePluginFolders` before each test (review 8
// DUP-01). Live bindings: a test file that imports them sees each test's folders.
export let root: string;
export let base: string;

/** Makes a fresh root before each test of the calling file and removes it after it. */
export function usePluginFolders(prefix: string): void {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), prefix));
    base = join(root, '.claude');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
}

export const putJson = (path: string, value: unknown) => writeTestFile(path, JSON.stringify(value));

/** The project the plugin manifests below install into. */
const pluginProjectIn = (root: string) => join(root, 'work', 'app');

/** The project the plugin manifests install into, in this test's root. */
export const pluginProject = () => pluginProjectIn(root);

/** Manifests shaped like a real ~/.claude/plugins folder, in `<root>/.claude`. */
export async function realisticPlugins(root: string): Promise<void> {
  const base = join(root, '.claude');
  const project = () => pluginProjectIn(root);
  const install = (scope: string, extra: object = {}) => [
    { scope, installPath: 'x', version: '1.0.0', installedAt: '2026-09-21T00:00:00Z', ...extra },
  ];
  await putJson(join(base, 'plugins', 'installed_plugins.json'), {
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
  await putJson(join(base, 'plugins', 'known_marketplaces.json'), marketplaces);
  await putJson(
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

/** Managed settings from a file that limit plugins and MCP servers, as the warnings show them. */
export const fileManagedSettings: ManagedSettings = {
  sources: [{ kind: 'file', where: '/etc/claude-code/managed-settings.json' }],
  keys: ['allowedMcpServers', 'strictKnownMarketplaces'],
  restrictsPlugins: true,
  restrictsMcpServers: true,
};
