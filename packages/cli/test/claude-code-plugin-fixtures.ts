import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { collected, collectedJson, writeTestFile } from './fakes.ts';
import type {
  CollectedFile,
  ManagedSettings,
  ManagedSettingsSystem,
  ProgramCli,
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

/*
 * Plugin sources as Claude Code 2.1.295 and 2.1.296 keep them (T96), for T97 to T103 and T105.
 * Every account, skill and plugin id below is made up.
 */

/** The marketplace of a plugin or mod found in `~/.claude/skills/<name>/` (T97 moved it to src). */
export { SKILLS_DIR_MARKETPLACE } from '../src/index.ts';

/** The `plugins/data/<folder>` name of each plugin id, as Claude Code 2.1.295 made them. */
export const PLUGIN_DATA_FOLDERS = [
  ['lm-plugin@my-local.mkt', 'lm-plugin-my-local-mkt'],
  ['Odd.Name_v2@my-local.mkt', 'Odd-Name_v2-my-local-mkt'],
  ['probe-init@skills-dir', 'probe-init-skills-dir'],
  ['inline-plug@inline', 'inline-plug-inline'],
] as const;

/**
 * The `plugins/store/<file>` a mod's `$.store` is kept in, for each plugin id: the id made safe,
 * `-`, then the first 12 hex digits of the id's SHA-256 (Claude Code 2.1.295).
 */
export const PLUGIN_STORE_FILES = [
  ['probe-mod@skills-dir', 'probe-mod_skills-dir-e89169932969.json'],
  ['Odd.Mod_v2@skills-dir', 'Odd_Mod_v2_skills-dir-bc7e6d4978f9.json'],
] as const;

/** The modes Claude Code 2.1.295 gives `plugins/store/` and the files in it. */
export const PLUGIN_STORE_MODES = { folder: 0o700, file: 0o600 } as const;

/** The mod folder in the validate reports below, in place of the absolute path of the run. */
export const VALIDATED_MOD = '<mod>';

/** A `claude plugin validate` run: its exit code, its text and its `--json` report. */
export interface ValidateRun {
  exitCode: number;
  text: string;
  json: Record<string, unknown>;
}

const validatedManifest = `${VALIDATED_MOD}/.claude-plugin/plugin.json`;
const validatedHooks = `${VALIDATED_MOD}/hooks/hooks.json`;
const authorWarning =
  'No author information provided. Consider adding author details for plugin attribution';
const moduleNotes = [
  './register.ts hooks: session.start',
  './register.ts calls: $.store.get, $.store.set, $.ui.status',
];

/** The report's entry for `hooks/hooks.json`: the module's one `hooks:` and one `calls:` line. */
const hooksContents = [
  {
    file: validatedHooks,
    type: 'hooks',
    errors: [],
    warnings: [],
    notes: moduleNotes,
    gatingHooks: [],
  },
];

/**
 * `claude plugin validate` of a mod with one module (`hooks/hooks.json` naming
 * `./register.ts`), captured from Claude Code 2.1.296 on Windows with no author in the
 * manifest: it passes with a warning and exits 0. Paths use `/` here.
 */
export const validatePassWithWarning: ValidateRun = {
  exitCode: 0,
  text: [
    `Validating plugin manifest: ${validatedManifest}`,
    '',
    '⚠ Found 1 warning:',
    '',
    `  ❯ author: ${authorWarning}`,
    '',
    `Validating hooks: ${validatedHooks}`,
    '',
    ...moduleNotes.map((note) => `  ❯ ${note}`),
    '',
    '✔ Validation passed with warnings',
    '',
  ].join('\n'),
  json: {
    success: true,
    strict: false,
    target: validatedManifest,
    manifest: {
      file: validatedManifest,
      type: 'plugin',
      errors: [],
      warnings: [{ path: 'author', message: authorWarning, code: null }],
      notes: [],
      gatingHooks: [],
    },
    contents: hooksContents,
    advice: [],
  },
};

/**
 * `validatePassWithWarning` for a plugin without `hooks/hooks.json` (T101): only the manifest
 * is validated, so nothing in the report runs code.
 */
export const validatePassNoHooks: ValidateRun = {
  exitCode: 0,
  text: validatePassWithWarning.text.split(`Validating hooks: ${validatedHooks}`)[0] ?? '',
  json: { ...validatePassWithWarning.json, contents: [] },
};

/** The same mod with a cut-off `plugin.json`: it fails and exits 1, and still lists the module. */
export const validateBrokenManifest: ValidateRun = {
  exitCode: 1,
  text: [
    `Validating plugin manifest: ${validatedManifest}`,
    '',
    '✘ Found 1 error:',
    '',
    '  ❯ json: Invalid JSON syntax: JSON Parse error: Unexpected EOF',
    '',
    `Validating hooks: ${validatedHooks}`,
    '',
    ...moduleNotes.map((note) => `  ❯ ${note}`),
    '',
    '✘ Validation failed',
    '',
  ].join('\n'),
  json: {
    success: false,
    strict: false,
    target: validatedManifest,
    manifest: {
      file: validatedManifest,
      type: 'plugin',
      errors: [
        {
          path: 'json',
          message: 'Invalid JSON syntax: JSON Parse error: Unexpected EOF',
          code: null,
        },
      ],
      warnings: [],
      notes: [],
      gatingHooks: [],
    },
    contents: hooksContents,
    advice: [],
  },
};

/** The mod of the T97 tests, in `skills/<MOD_NAME>/`. */
export const MOD_NAME = 'probe-mod';

/**
 * A mod's module as Claude Code 2.1.296 takes it (T97 probe): a `register` export, and `$` as
 * the first parameter of each hook (else validate lists `calls: nothing on $`).
 */
export const MOD_MODULE = [
  'export function register(on, options) {',
  '  on("session.start", async ($, e) => {',
  '    await $.store.get("seen");',
  '  });',
  '}',
  '',
].join('\n');

/**
 * A mod's files under `prefix` (`skills/probe-mod/` by default; `''` for paths from the mod's
 * folder): its manifest, `hooks/hooks.json` with `{"modules": ["./register.ts"]}` and the
 * module, which validate finds from the `hooks/` folder (2.1.296, T97 probe).
 */
export const modFiles = (prefix = `skills/${MOD_NAME}/`): CollectedFile[] => [
  collectedJson(`${prefix}.claude-plugin/plugin.json`, { name: MOD_NAME }),
  collectedJson(`${prefix}hooks/hooks.json`, { modules: ['./register.ts'] }),
  collected(`${prefix}hooks/register.ts`, MOD_MODULE),
];

/** `validatePassWithWarning` with these `$` calls on the module's `calls:` line (T97). */
export function validatePassCalling(calls: readonly string[]): ValidateRun {
  const notes = ['./register.ts hooks: session.start', `./register.ts calls: ${calls.join(', ')}`];
  const json = structuredClone(validatePassWithWarning.json);
  json['contents'] = [{ ...hooksContents[0], notes }];
  return { ...validatePassWithWarning, json };
}

/**
 * A `claude` that answers `plugin validate --json <folder>` with `run`, the folder written in
 * place of `VALIDATED_MOD`, and records each call's arguments, the files the folder held and
 * the `CLAUDE_CONFIG_DIR` it ran with.
 */
export function validateCli(run: ValidateRun) {
  const calls: { args: readonly string[]; files: readonly string[]; configDir?: string }[] = [];
  const cli = (_path: string, env: Readonly<Record<string, string | undefined>>): ProgramCli => ({
    async run(args) {
      const folder = args.at(-1) ?? '';
      const entries = await readdir(folder, { recursive: true, withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(folder, join(entry.parentPath, entry.name)).replace(/\\/g, '/'));
      const configDir = env['CLAUDE_CONFIG_DIR'];
      calls.push({ args, files: files.sort(), ...(configDir !== undefined && { configDir }) });
      const shown = JSON.stringify(folder.replace(/\\/g, '/')).slice(1, -1);
      return {
        exitCode: run.exitCode,
        stdout: JSON.stringify(run.json).split(VALIDATED_MOD).join(shown),
        stderr: '',
      };
    },
  });
  return { cli, calls };
}

/** The claude.ai account of the synced files below. */
export const SYNCED_ACCOUNT =
  '22222222-2222-4222-8222-222222222222_33333333-3333-4333-8333-333333333333';

/**
 * `skills/synced/<account>/manifest.json` as Claude Code 2.1.295 writes it: no `creatorType`,
 * one entry for each `source` (`custom` when the server sends none); the user's uploads are
 * `plugin` entries with a `backingPluginId`.
 */
export const syncedSkillsManifest = {
  lastUpdated: 1760000000000,
  skills: [
    {
      skillId: 'skill_01upload',
      name: 'my-upload',
      description: 'A skill the user uploaded.',
      source: 'plugin',
      backingPluginId: 'plugin_01upload',
      updatedAt: '2026-10-09T00:00:00Z',
    },
    {
      skillId: 'pdf',
      name: 'pdf',
      description: 'Anthropic PDF skill.',
      source: 'anthropic',
      updatedAt: '2026-10-09T00:00:00Z',
    },
    {
      skillId: 'example-skill',
      name: 'example-skill',
      description: 'An Anthropic example skill.',
      source: 'anthropic-example',
      updatedAt: '2026-10-09T00:00:00Z',
    },
    {
      skillId: 'skill_02custom',
      name: 'my-custom',
      description: 'A skill with no source from the server.',
      source: 'custom',
      updatedAt: '2026-10-09T00:00:00Z',
    },
    {
      skillId: 'skill_03session',
      name: 'session-skill',
      description: 'A skill a session refers to.',
      source: 'session-refs',
      updatedAt: '2026-10-09T00:00:00Z',
    },
  ],
};

/** The same file from a Claude Code before 2.1.295: its entries still have `creatorType`. */
export const olderSyncedSkillsManifest = {
  lastUpdated: 1759000000000,
  skills: [
    {
      skillId: 'skill_04older',
      name: 'older-skill',
      description: 'A skill the user made.',
      source: 'plugin',
      updatedAt: '2026-09-21T00:00:00Z',
      creatorType: 'user',
    },
  ],
};

/**
 * `plugins/synced/<account>/manifest.json` (Claude Code 2.1.295, fields from the T101 notes;
 * the `plugins` list around the entries is assumed, like the skills manifest's), one entry for
 * each `installationPreference`.
 */
export const syncedPluginsManifest = {
  lastUpdated: 1760000000000,
  plugins: [
    {
      pluginId: 'plugin_01upload',
      name: 'my-upload',
      description: 'A plugin the user uploaded.',
      version: '1.0.0',
      updatedAt: '2026-10-09T00:00:00Z',
      marketplaceName: 'my-uploads',
      installationPreference: 'available',
    },
    {
      pluginId: 'plugin_02required',
      name: 'team-required',
      description: 'A plugin the organization requires.',
      version: '2.0.0',
      updatedAt: '2026-10-09T00:00:00Z',
      marketplaceName: 'team-org',
      installationPreference: 'required',
      requestedVersion: '2.0.0',
    },
    {
      pluginId: 'plugin_03auto',
      name: 'team-auto',
      description: 'A plugin installed for everyone.',
      version: '1.1.0',
      updatedAt: '2026-10-09T00:00:00Z',
      marketplaceName: 'team-org',
      installationPreference: 'auto_install',
    },
    {
      pluginId: 'plugin_04blocked',
      name: 'directory-off',
      description: 'A plugin not offered to this account.',
      version: '0.9.0',
      updatedAt: '2026-10-09T00:00:00Z',
      marketplaceName: 'anthropic-directory',
      installationPreference: 'not_available',
    },
  ],
};

/** The `<name>.meta.json` next to a synced plugin, repeating three manifest fields. */
export const syncedPluginMeta = {
  server_plugin_id: 'plugin_01upload',
  marketplace_name: 'my-uploads',
  installation_preference: 'available',
};

/**
 * `plugins/synced/<account>/.marketplaces.json`, from Claude Code's code (no account had one):
 * one row for each `scope`; `account` is My Uploads. A list is assumed around the rows.
 */
export const syncedMarketplaces = [
  {
    name: 'team-org',
    display_name: 'Team',
    scope: 'org',
    source: { source: 'claudeai' },
    id: 'mkt_01org',
  },
  {
    name: 'anthropic-directory',
    display_name: 'Anthropic Directory',
    scope: 'default',
    source: { source: 'claudeai' },
    id: 'mkt_02default',
  },
  {
    name: 'my-uploads',
    display_name: 'My Uploads',
    scope: 'account',
    source: { source: 'claudeai' },
    id: 'mkt_03account',
  },
];

/**
 * The claude.ai synced files of Claude Code 2.1.295 in the base folder `base`: the skills and
 * plugins manifests, the marketplaces and one plugin's `.meta.json`.
 */
export async function syncedSources(base: string): Promise<void> {
  const skills = join(base, 'skills', 'synced', SYNCED_ACCOUNT);
  const plugins = join(base, 'plugins', 'synced', SYNCED_ACCOUNT);
  await putJson(join(skills, 'manifest.json'), syncedSkillsManifest);
  await putJson(join(plugins, 'manifest.json'), syncedPluginsManifest);
  await putJson(join(plugins, '.marketplaces.json'), syncedMarketplaces);
  await putJson(join(plugins, 'my-upload.meta.json'), syncedPluginMeta);
}

/** An entry of `skills/synced/<account>/manifest.json`: a name, a description and any fields. */
export interface SyncedSkillEntry {
  readonly name: string;
  readonly description: string;
  readonly [field: string]: unknown;
}

/** A skill the organization shares: a `plugin` entry backed by a plugin of its `team-org`. */
export const syncedOrganizationSkill: SyncedSkillEntry = {
  skillId: 'skill_05org',
  name: 'team-skill',
  description: 'A skill the organization shares.',
  source: 'plugin',
  backingPluginId: 'plugin_02required',
  updatedAt: '2026-10-09T00:00:00Z',
};

/** A skill from claude.ai's directory: a `plugin` entry backed by `anthropic-directory`. */
export const syncedDirectorySkill: SyncedSkillEntry = {
  skillId: 'skill_06directory',
  name: 'directory-skill',
  description: 'A skill from the claude.ai directory.',
  source: 'plugin',
  backingPluginId: 'plugin_04blocked',
  updatedAt: '2026-10-09T00:00:00Z',
};

/**
 * {@link syncedSources} in the base folder `base` with `skills` (by default those of
 * {@link syncedSkillsManifest}) in the skills manifest, a `SKILL.md` folder for each, and,
 * with `marketplaces: false`, no `.marketplaces.json`.
 */
export async function syncedAccount(
  base: string,
  options: { skills?: readonly SyncedSkillEntry[]; marketplaces?: boolean } = {},
): Promise<void> {
  const skills = options.skills ?? syncedSkillsManifest.skills;
  const dir = join(base, 'skills', 'synced', SYNCED_ACCOUNT);
  await syncedSources(base);
  await putJson(join(dir, 'manifest.json'), { ...syncedSkillsManifest, skills });
  if (options.marketplaces === false) {
    await rm(join(base, 'plugins', 'synced', SYNCED_ACCOUNT, '.marketplaces.json'));
  }
  for (const skill of skills) {
    await writeTestFile(
      join(dir, skill.name, 'SKILL.md'),
      `---\nname: ${skill.name}\n---\n${skill.description}\n`,
    );
  }
}

/** The mod's plugin id in a local marketplace named `name` (T98). */
export const localModId = (name: string) => `${MOD_NAME}@${name}`;

/**
 * A marketplace named `name` in the folder `dir`, as a user makes one for a mod (T98): its
 * catalog naming the mod `MOD_NAME` in `./probe-mod`, and the mod's files there.
 */
export async function writeLocalMarketplace(dir: string, name: string): Promise<void> {
  await putJson(join(dir, '.claude-plugin', 'marketplace.json'), {
    name,
    owner: { name: 'me' },
    plugins: [{ name: MOD_NAME, source: `./${MOD_NAME}` }],
  });
  await writeModFolder(join(dir, MOD_NAME));
}

/**
 * Claude Code's lists in the base folder `base`: each marketplace of `folders` (name → folder)
 * added from its folder, and its mod installed for the user (T98).
 */
export async function addedFromFolders(
  base: string,
  folders: Readonly<Record<string, string>>,
): Promise<void> {
  const names = Object.keys(folders);
  await putJson(
    join(base, 'plugins', 'known_marketplaces.json'),
    Object.fromEntries(
      names.map((name) => [name, { source: { source: 'directory', path: folders[name] } }]),
    ),
  );
  await putJson(installedPluginsFile(base), {
    version: 2,
    plugins: Object.fromEntries(
      names.map((name) => [
        localModId(name),
        [{ scope: 'user', installPath: 'x', version: 'unknown' }],
      ]),
    ),
  });
}

/** What a scripted `git` answers to one command. */
export interface GitAnswer {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * A `git` that answers each command (its arguments joined by spaces) from `answers`, exit 1
 * for any other, and records each call with its folder (T98). A clone that succeeds makes
 * the folder with an empty `.git`, as `git clone --no-checkout` leaves it.
 */
export function scriptedGit(answers: Readonly<Record<string, GitAnswer>>) {
  const calls: { args: string; cwd: string }[] = [];
  const git: ProgramCli = {
    async run(args, cwd) {
      calls.push({ args: args.join(' '), cwd });
      const answer = answers[args.join(' ')];
      if (answer === undefined) return { exitCode: 1, stdout: '', stderr: 'not scripted' };
      const exitCode = answer.exitCode ?? 0;
      if (args[0] === 'clone' && exitCode === 0) {
        await mkdir(join(args.at(-1) ?? '', '.git'), { recursive: true });
      }
      return { exitCode, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
    },
  };
  return { git, calls };
}

/** An entry of `plugins/synced/<account>/manifest.json`: a plugin id, a name and any fields. */
export interface SyncedPluginEntry {
  readonly pluginId: string;
  readonly name: string;
  readonly [field: string]: unknown;
}

/**
 * The files of each synced plugin's folder, `plugins/synced/<account>/<name>/` (T101, assumed
 * like a plugin anywhere): its manifest and one skill, plus what push leaves out, a folder
 * Claude Code generates (`.claude-plugin/types/`) and OS clutter (`.DS_Store`).
 */
export const syncedPluginFiles = (name: string): Record<string, string> => ({
  '.claude-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0' }),
  [`skills/${name}/SKILL.md`]: `---\nname: ${name}\n---\nFrom the ${name} plugin.\n`,
  '.claude-plugin/types/index.d.ts': 'declare const generated: true;\n',
  '.DS_Store': 'clutter',
});

/**
 * {@link syncedSources} in the base folder `base` with `plugins` (by default those of
 * {@link syncedPluginsManifest}) in the plugins manifest, a folder for each
 * ({@link syncedPluginFiles}), and, with `marketplaces: false`, no `.marketplaces.json` (T101).
 */
export async function syncedAccountPlugins(
  base: string,
  options: { plugins?: readonly SyncedPluginEntry[]; marketplaces?: boolean } = {},
): Promise<void> {
  const plugins = options.plugins ?? syncedPluginsManifest.plugins;
  const dir = join(base, 'plugins', 'synced', SYNCED_ACCOUNT);
  await syncedSources(base);
  await putJson(join(dir, 'manifest.json'), { ...syncedPluginsManifest, plugins });
  if (options.marketplaces === false) await rm(join(dir, '.marketplaces.json'));
  for (const plugin of plugins) {
    for (const [file, content] of Object.entries(syncedPluginFiles(plugin.name))) {
      await writeTestFile(join(dir, plugin.name, ...file.split('/')), content);
    }
  }
}

/** The mod of {@link modFiles} as a plugin folder `dir` of its own (T98, T99). */
export async function writeModFolder(dir: string): Promise<void> {
  for (const file of modFiles('')) {
    await writeTestFile(join(dir, ...file.path.split('/')), file.content);
  }
}

/** Where the saving PC had the mod folder in {@link savedPluginDir}: another PC's path. */
export const SAVED_PLUGIN_DIR_ENTRY = `/other/pc/dev/${MOD_NAME}`;

/**
 * The saved entry `n` of the mod folder named in `CLAUDE_CODE_PLUGIN_DIRS` (T99), as push
 * writes it on a PC whose separator is `separator`, with `overrides`.
 */
export const savedPluginDir = (separator: string, overrides: object = {}, n = 0) =>
  collectedJson(`.agentnomad/plugin-dirs/${String(n)}.json`, {
    name: MOD_NAME,
    entry: SAVED_PLUGIN_DIR_ENTRY,
    separator,
    path: `dev/${MOD_NAME}`,
    git: null,
    files: modFiles('').map((file) => ({
      path: file.path,
      content: Buffer.from(file.content).toString('base64'),
      executable: false,
    })),
    ...overrides,
  });
