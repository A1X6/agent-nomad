/**
 * The Claude Code paths data file (T32): every list the Claude Code adapter uses to decide
 * what to sync, skip or refuse, in one place and as plain data. When Claude Code adds or
 * moves a file, this is the only file to change (the weekly drift check, T41, compares it
 * with the newest Claude Code). Checked against its schema when loaded.
 */
import * as z from 'zod';

const RAW = {
  /** Bumped when the meaning of an entry changes. */
  version: 1,

  /**
   * The newest Claude Code these lists were checked against (T41). The weekly drift check
   * reports changelog entries of newer versions; bump this after reviewing them.
   */
  reviewedVersion: '2.1.292',

  global: {
    /** Single files in the base folder (`~/.claude` or `CLAUDE_CONFIG_DIR`). */
    files: ['settings.json', 'CLAUDE.md', 'keybindings.json'],
    /** Folders taken whole. */
    folders: ['rules', 'skills', 'commands', 'agents', 'workflows', 'output-styles', 'themes'],
    /** Opt-in: subagent memory with `memory: user` (auto memory is per project). */
    memoryFolders: ['agent-memory'],
    /**
     * Never taken, even when a hook names them: credentials, history, transcripts and
     * machine state. `skills/synced/` holds claude.ai account skills, which the account
     * already syncs; it is always skipped and never reported as unknown.
     */
    neverSynced: [
      '.credentials.json',
      'history.jsonl',
      'projects',
      'file-history',
      'plans',
      'debug',
      'cache',
      'backups',
      'sessions',
      'session-env',
      'shell-snapshots',
      'jobs',
      'daemon',
      'downloads',
      'paste-cache',
      'ide',
      'security',
      'statsig',
      'todos',
      '.trash',
      'plugins',
      'settings.local.json',
      'remote-settings.json',
      'skills/synced',
      // Named by the .claude directory docs (T41): session files, pasted images,
      // /feedback drafts, and the organization's limits cached from claude.ai.
      'tasks',
      'uploads',
      'image-cache',
      'feedback',
      'feedback-bundles',
      'policy-limits.json',
      // Written next to it since 2.1.295 (T95): when the cached limits were last confirmed.
      'policy-limits.json.stamp.json',
    ],
    /**
     * Other things Claude Code keeps in the base folder that are known and deliberately
     * left out (state, logs, caches). Known, so the unknown-file check stays quiet.
     */
    knownState: [
      '.last-cleanup',
      '.last-update-result.json',
      'chrome',
      'daemon.lock',
      'daemon.log',
      'daemon.status.json',
      'gh-pr-status-cache.json',
      'mcp-needs-auth-cache.json',
      'state',
      'logs',
      'telemetry',
      'local',
      'usage-data',
      'stats-cache.json',
    ],
  },

  project: {
    /** Files in the project root; `CLAUDE.local.md` is personal and usually gitignored. */
    rootFiles: ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.mcp.json', '.worktreeinclude'],
    /** Single files in `<project>/.claude/`. */
    claudeFiles: ['settings.json', 'settings.local.json', 'CLAUDE.md'],
    /** Folders in `<project>/.claude/`, taken whole. */
    claudeFolders: ['rules', 'skills', 'commands', 'agents', 'workflows', 'output-styles'],
    /** Opt-in: subagent memory with `memory: project`. */
    memoryFolders: ['agent-memory'],
    /** Never taken from a project (paths from the project root). */
    neverSynced: ['.git', '.claude/agent-memory-local', '.claude/worktrees'],
    /** Known entries in `<project>/.claude/` that are left out on purpose. */
    knownState: ['hooks'],
  },

  /**
   * Where Claude Code keeps plugins and mods (T95, checked on Claude Code 2.1.295; the real
   * files are in `test/fixtures/claude-code-2.1.295/`). A plugin id is `<name>@<source>`.
   * Read by the plugin and mod sync (T96 to T102); `plugins/` itself stays never synced.
   */
  plugins: {
    /** The source of a plugin in `skills/<name>/` with a `.claude-plugin/plugin.json`. */
    skillsDirSource: 'skills-dir',
    /** The source of a plugin loaded with `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`. */
    inlineSource: 'inline',
    /**
     * Written by Claude Code inside a mod's folder when it hot-reloads the mod (dev-mods,
     * `--plugin-dir`); not written in a normal session, but never worth syncing.
     */
    generatedInPlugin: ['.claude-plugin/types'],
    /**
     * A plugin's own folder (`CLAUDE_PLUGIN_DATA`), from the base folder: the id with every
     * character outside `A-Za-z0-9_-` turned into `-` (`a.b@my.mkt` is `a-b-my-mkt`).
     */
    dataDir: 'plugins/data',
    /**
     * A mod's `$.store` (its saved choices), one file per plugin, from the base folder: the
     * id with every character outside `A-Za-z0-9_-` turned into `_`, then `-`, the first 12
     * hex digits of the SHA-256 of the id and `.json`. Folder 700, file 600.
     */
    storeDir: 'plugins/store',
    /** claude.ai account plugins, one folder per account; Claude Code manages it. */
    syncedDir: 'plugins/synced',
    /**
     * The claude.ai marketplaces in an account folder, from Claude Code's own code (no real
     * file seen yet): `rows` of `{ name, scope, source: { source: 'claudeai' }, id }`.
     */
    syncedMarketplacesFile: '.marketplaces.json',
    /** The marketplace `scope` of the user's own uploads ("My Uploads"); others: org, default. */
    accountScope: 'account',
    /** Every `installationPreference`; `required` means the organization requires the plugin. */
    installationPreferences: ['available', 'required', 'auto_install', 'not_available'],
  },

  /** Names skipped anywhere inside a synced folder: tool state and OS clutter. */
  skippedNames: [
    '.git',
    'node_modules',
    '__pycache__',
    '.venv',
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',
  ],

  /**
   * Top-level names that are the user's own copies and never worth reporting, e.g. a
   * hand-made `settings.json.bak` (agentnomad's own backups are recognised separately).
   */
  ignoredCopyPatterns: ['\\.bak$', '\\.orig$', '\\.old$', '~$', '\\.swp$'],

  /**
   * `~/.claude.json` keys that are preferences: the "Global config" keys in Claude Code's
   * settings reference. Everything else there is account, machine or project state.
   */
  claudeJsonPreferenceKeys: [
    'autoConnectIde',
    'autoInstallIdeExtension',
    'copyOnSelect',
    'diffTool',
    'externalEditorContext',
  ],

  /** A hook argument is only taken as a script with one of these extensions. */
  scriptExtensions: [
    '.sh',
    '.bash',
    '.zsh',
    '.fish',
    '.ps1',
    '.psm1',
    '.cmd',
    '.bat',
    '.py',
    '.js',
    '.mjs',
    '.cjs',
    '.ts',
    '.rb',
    '.pl',
    '.lua',
  ],

  /**
   * Home folders the OS or a shell runs files from by itself (T43): never written, even when
   * a hook names a file there, since the file would keep running after the hook is removed.
   * Matched anywhere in a path too (a Documents folder moved into OneDrive).
   */
  autostartHomeDirs: [
    'AppData/Roaming/Microsoft/Windows/Start Menu',
    'Documents/PowerShell',
    'Documents/WindowsPowerShell',
    '.config/powershell',
    '.config/autostart',
    '.config/fish',
    'Library/LaunchAgents',
  ],

  /** Settings files of known status line and hook tools, from the home folder. */
  toolConfigFiles: { ccstatusline: ['.config/ccstatusline/settings.json'] },

  /** Shells and runtimes: present wherever agentnomad runs, so not recorded as programs. */
  runtimeCommands: [
    'bash',
    'sh',
    'zsh',
    'fish',
    'pwsh',
    'powershell',
    'cmd',
    'node',
    'python',
    'python3',
    'py',
    'env',
    'exec',
    // Shell built-ins: part of every shell, never installed separately.
    'echo',
    'printf',
    'cd',
    'exit',
    'true',
    'false',
    'test',
    'set',
    'export',
    'source',
    'command',
  ],

  /** Run a package without installing it; the package name follows the options. */
  packageRunners: ['npx', 'bunx', 'pnpx', 'uvx'],
};

const names = z.array(
  z
    .string()
    .min(1)
    .regex(/^[^\\]+$/, 'Use forward slashes'),
);

const PathsDataSchema = z.strictObject({
  version: z.literal(1),
  reviewedVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  global: z.strictObject({
    files: names,
    folders: names,
    memoryFolders: names,
    neverSynced: names,
    knownState: names,
  }),
  project: z.strictObject({
    rootFiles: names,
    claudeFiles: names,
    claudeFolders: names,
    memoryFolders: names,
    neverSynced: names,
    knownState: names,
  }),
  plugins: z.strictObject({
    skillsDirSource: z.string().min(1),
    inlineSource: z.string().min(1),
    generatedInPlugin: names,
    dataDir: z.string().min(1),
    storeDir: z.string().min(1),
    syncedDir: z.string().min(1),
    syncedMarketplacesFile: z.string().min(1),
    accountScope: z.string().min(1),
    installationPreferences: names,
  }),
  skippedNames: names,
  ignoredCopyPatterns: z.array(
    z.string().refine((pattern) => {
      try {
        new RegExp(pattern);
        return true;
      } catch {
        return false;
      }
    }, 'Not a valid pattern'),
  ),
  claudeJsonPreferenceKeys: names,
  scriptExtensions: z.array(z.string().regex(/^\.[a-z0-9]+$/)),
  autostartHomeDirs: names,
  toolConfigFiles: z.record(z.string(), names),
  runtimeCommands: names,
  packageRunners: names,
});

export type ClaudeCodePathsData = z.infer<typeof PathsDataSchema>;

/** The checked data; a mistake in the lists fails loudly at startup and in tests. */
export const CLAUDE_CODE_PATHS: ClaudeCodePathsData = PathsDataSchema.parse(RAW);

/**
 * Claude Code's settings files among `names` (DUP-01), e.g. `settings.json` and
 * `settings.local.json`: the global and project views take their settings lists from it.
 */
export const settingsFilesIn = (names: readonly string[]): readonly string[] =>
  names.filter((name) => name.startsWith('settings') && name.endsWith('.json'));
