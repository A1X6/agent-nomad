import { join } from 'node:path';

import { writeTestFile } from './fakes.ts';
import type { ManagedSettings, ManagedSettingsSystem } from '../src/index.ts';

/** Plugin files shared by the plugin and plugin sync tests (review 7 READ-01). */

/** Claude Code's list of installed plugins in the base folder `base`. */
export const installedPluginsFile = (base: string) =>
  join(base, 'plugins', 'installed_plugins.json');

export const putJson = (path: string, value: unknown) => writeTestFile(path, JSON.stringify(value));

/**
 * Manifests shaped like a real ~/.claude/plugins folder, in `<home>/.claude`, with the project
 * plugins installed in `project`.
 */
export async function realisticPlugins(home: string, project: string): Promise<void> {
  const base = join(home, '.claude');
  const install = (scope: string, extra: object = {}) => [
    { scope, installPath: 'x', version: '1.0.0', installedAt: '2026-09-21T00:00:00Z', ...extra },
  ];
  await putJson(installedPluginsFile(base), {
    version: 2,
    plugins: {
      'brag@brag': install('user'),
      'warp@claude-code-warp': install('user'),
      'mine@local-tools': install('user'),
      'team-lint@company': install('project', { projectPath: project }),
      'other@company': install('project', { projectPath: join(home, 'elsewhere') }),
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

/** What a PC without organization-managed settings has. */
export const noManagedSettings: ManagedSettings = {
  sources: [],
  keys: [],
  restrictsPlugins: false,
  restrictsMcpServers: false,
};

/** A PC for the managed-settings readers: these files, folders and registry values only. */
export interface FakeManagedPc {
  platform: NodeJS.Platform;
  env?: Record<string, string>;
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
  registry?: Partial<Record<'HKLM' | 'HKCU', string>>;
}

/** Managed settings read from `pc` instead of this PC (SOLID-01). */
export function fakeManagedSystem(pc: FakeManagedPc): ManagedSettingsSystem {
  return {
    platform: pc.platform,
    env: pc.env ?? {},
    baseDir: pc.platform === 'win32' ? 'C:\\Users\\a\\.claude' : '/home/a/.claude',
    readText: (path) => Promise.resolve(pc.files?.[path] ?? null),
    exists: (path) => Promise.resolve(path in (pc.files ?? {})),
    listDir: (path) => Promise.resolve(pc.dirs?.[path] ?? []),
    readRegistry: (hive) => Promise.resolve(pc.registry?.[hive] ?? null),
  };
}

/** Managed settings from a file that limit plugins and MCP servers, as the warnings show them. */
export const fileManagedSettings: ManagedSettings = {
  sources: [{ kind: 'file', where: '/etc/claude-code/managed-settings.json' }],
  keys: ['allowedMcpServers', 'strictKnownMarketplaces'],
  restrictsPlugins: true,
  restrictsMcpServers: true,
};
