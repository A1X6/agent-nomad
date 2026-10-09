import { join } from 'node:path';

import { collected, collectedJson, writeTestFile } from './fakes.ts';
import type {
  CollectedFile,
  ManagedSettings,
  ManagedSettingsSystem,
  PluginFolder,
  PluginValidation,
  PluginValidator,
} from '../src/index.ts';

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

/** What a plugin in the skills folder may hold (T96), besides its manifest. */
export interface PluginFilesOptions {
  /** Hooks modules named in `hooks/hooks.json`; each gets a one-line source file. */
  readonly modules?: readonly string[];
  /** A classic `hooks` block for `hooks/hooks.json`. */
  readonly hooks?: unknown;
  /** An `mcpServers` block for `.mcp.json`. */
  readonly mcpServers?: unknown;
  /** Other files, by path inside the plugin folder. */
  readonly extra?: Readonly<Record<string, string>>;
}

/**
 * A plugin in the skills folder as bundle files (T96): `folder` is its bundle path with the
 * trailing slash (`skills/my-mod/`), the manifest is always there.
 */
export function pluginFiles(folder: string, options: PluginFilesOptions = {}): CollectedFile[] {
  const name = folder.split('/').at(-2) ?? '';
  const files = [
    collectedJson(`${folder}.claude-plugin/plugin.json`, {
      name,
      version: '0.1.0',
      description: 'test',
    }),
  ];
  if (options.modules !== undefined || options.hooks !== undefined) {
    files.push(
      collectedJson(`${folder}hooks/hooks.json`, {
        ...(options.modules !== undefined && { modules: options.modules }),
        ...(options.hooks !== undefined && { hooks: options.hooks }),
      }),
    );
    for (const module of options.modules ?? []) {
      files.push(
        collected(
          `${folder}hooks/${module.replace(/^\.\//, '')}`,
          'export const register = () => {}\n',
        ),
      );
    }
  }
  if (options.mcpServers !== undefined) {
    files.push(collectedJson(`${folder}.mcp.json`, { mcpServers: options.mcpServers }));
  }
  for (const [path, text] of Object.entries(options.extra ?? {})) {
    files.push(collected(folder + path, text));
  }
  return files;
}

/** Writes `files` (bundle paths from `base`) to disk, as a PC that has the plugin. */
export async function writePluginFiles(
  base: string,
  files: readonly CollectedFile[],
): Promise<void> {
  for (const file of files) await writeTestFile(join(base, ...file.path.split('/')), file.content);
}

/**
 * What `claude plugin validate --json` printed for the T95 probe mod on Claude Code 2.1.295
 * (paths shortened): a manifest warning, and the hooks file's notes with the module's hooks and
 * `$` calls.
 */
export const REAL_VALIDATE_REPORT = JSON.stringify({
  success: true,
  strict: false,
  target: '<skills>/probe-mod/.claude-plugin/plugin.json',
  manifest: {
    file: '<skills>/probe-mod/.claude-plugin/plugin.json',
    type: 'plugin',
    errors: [],
    warnings: [
      {
        path: 'author',
        message:
          'No author information provided. Consider adding author details for plugin attribution',
        code: null,
      },
    ],
    notes: [],
    gatingHooks: [],
  },
  contents: [
    {
      file: '<skills>/probe-mod/hooks/hooks.json',
      type: 'hooks',
      errors: [],
      warnings: [],
      notes: [
        './register.ts hooks: session.start, tool.call{tool=Bash}',
        './register.ts gating hook without .catch: tool.call{tool=Bash}',
        './register.ts calls: $.store.get, $.store.set, $.ui.status',
      ],
      gatingHooks: [
        {
          module: './register.ts',
          pattern: 'tool.call',
          hook: 'tool.call{tool=Bash}',
          hasCatch: false,
        },
      ],
    },
  ],
  advice: [],
});

/** A plugin validator that always answers `validation` and records which plugins it was given. */
export function scriptedValidator(validation: PluginValidation) {
  const asked: PluginFolder[] = [];
  const validate: PluginValidator = (plugin) => {
    asked.push(plugin);
    return Promise.resolve(validation);
  };
  return { asked, validate };
}

/** The T95 probe mod's report, as the review reads it. */
export const PROBE_MOD_VALIDATION: PluginValidation = {
  kind: 'report',
  errors: [],
  modules: [
    {
      module: './register.ts',
      hooks: 'session.start, tool.call{tool=Bash}',
      calls: '$.store.get, $.store.set, $.ui.status',
    },
  ],
};
