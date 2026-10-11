/**
 * The Claude Code paths data file (T32): every list the Claude Code adapter uses to decide
 * what to sync, skip or refuse, in one place and as plain data. When Claude Code adds or
 * moves a file, this is the only file to change (the weekly drift check, T41, compares it
 * with the newest Claude Code). Checked against its schema when loaded.
 */
import * as z from 'zod';

/** Where Claude Code keeps mods one session is developing: `dev-mods/<session>/<mod>/` (T103). */
const DEV_MODS = 'dev-mods';

const RAW = {
  /** Bumped when the meaning of an entry changes. */
  version: 1,

  /**
   * The newest Claude Code these lists were checked against (T41). The weekly drift check
   * reports changelog entries of newer versions; bump this after reviewing them.
   */
  reviewedVersion: '2.1.296',

  global: {
    /**
     * Single files in the base folder (`~/.claude` or `CLAUDE_CONFIG_DIR`). `loop.md` is the
     * user's own prompt for a bare `/loop` (T113): the 2.1.296 program reads it as text into the
     * prompt, cut at 25,000 bytes, and runs nothing from it.
     */
    files: ['settings.json', 'CLAUDE.md', 'keybindings.json', 'loop.md'],
    /**
     * Folders taken whole. `hooks/` (T112) is where users keep the scripts their hooks run:
     * Claude Code never loads it by itself, a script there runs only when a settings file
     * names it, and pull shows every such setting for review first.
     */
    folders: [
      'rules',
      'skills',
      'commands',
      'agents',
      'workflows',
      'output-styles',
      'themes',
      'hooks',
    ],
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
      // When the limits above were last fetched (Claude Code 2.1.295, T96; checked on 2.1.296).
      'policy-limits.json.stamp.json',
      // Scratch copies of a repository an /ultrareview upload makes (its changelog for
      // 2.1.295; the 2.1.296 program makes the folder with mode 700, T107).
      'seed-admin',
      // T108: the 2.1.296 program's own lists of state in its folder (the names it skips when
      // it walks a .claude folder, and the ones a self-hosted runner leaves out when it copies
      // this folder; the test fixture `claude-code-state-names.ts` keeps both). Logins: the
      // session ingress token (kept with .oauth_token and .api_key) and the HFI login.
      '.session_ingress_token',
      'hfi-auth.json',
      // `~/.claude.json` (account and project state) as it was before a write.
      '.claude.json.backup',
      // The signatures of the two files above that come from claude.ai, and the account's
      // answer when the organization's settings asked for consent.
      'policy-limits.json.signature.json',
      'policy-limits.json.signature-iat.json',
      'remote-settings.json.signature.json',
      'remote-settings.json.signature-iat.json',
      'remote-settings-consent.json',
      'remote-settings-helper-consent',
      // Sessions and what they send: prompt dumps (`dump-prompts/<session>.jsonl`), API dumps,
      // files sent between PCs, Remote Control drafts and fork seeds, cloud (`ccr`) sessions
      // and the home a cloud session starts from, the sessions a server runs, agent team
      // mailboxes and tasks, and the session storage (`storage-v2`).
      'dump-prompts',
      'api-dumps',
      'file-transfers',
      'remote',
      'remote-control',
      'ccr',
      'ccr-home-seed.json',
      'server-sessions.json',
      'teams',
      'storage-v2',
      // Plugins installed for Cowork, used instead of `plugins/` there.
      'cowork_plugins',
      // Checked on the 2.1.296 program (T113): zips it deletes when they get old (`shares/`),
      // the session storage's per-session scratch (`scratch/`), and its per-project folders,
      // laid out in bytecode the program never shows: local and project subagent memory and a
      // project's local and shared settings. The user's own copies live in the project, which
      // project push takes; local agent memory is personal by design.
      'shares',
      'scratch',
      'agent-memory-local',
      'agent-memory-project',
      'local-settings',
      'project-settings',
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
      // T108, from the same 2.1.296 lists: caches (MCP tools found, MCP skill archives),
      // startup profiles, traces, a systemd folder, activity times, locks and a write marker.
      'mcp-discovery-cache',
      'mcp-skill-archives',
      'startup-perf',
      'traces',
      'systemd',
      'active-time.json',
      'antproto.json',
      'bridge-spawn',
      'computer-use.lock',
      'server.lock',
      '.cc-writes',
      // Mods Claude Code writes while one session develops them, deleted after
      // `cleanupPeriodDays`: never pushed; push names them (T103).
      DEV_MODS,
    ],
  },

  project: {
    /** Files in the project root; `CLAUDE.local.md` is personal and usually gitignored. */
    rootFiles: ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.mcp.json', '.worktreeinclude'],
    /** Single files in `<project>/.claude/`; `loop.md` wins over the global one (T113). */
    claudeFiles: ['settings.json', 'settings.local.json', 'CLAUDE.md', 'loop.md'],
    /** Folders in `<project>/.claude/`, taken whole; `hooks/` as in the base folder (T112). */
    claudeFolders: ['rules', 'skills', 'commands', 'agents', 'workflows', 'output-styles', 'hooks'],
    /** Opt-in: subagent memory with `memory: project`. */
    memoryFolders: ['agent-memory'],
    /** Never taken from a project (paths from the project root). */
    neverSynced: ['.git', '.claude/agent-memory-local', '.claude/worktrees'],
    /** Known entries in `<project>/.claude/` that are left out on purpose. */
    knownState: [],
  },

  plugins: {
    /**
     * Folders inside a plugin or mod in `skills/<name>/` (T97) that Claude Code writes itself:
     * `.claude-plugin/types/` when it hot-reloads a mod (Claude Code 2.1.295, T96; checked on
     * 2.1.296). Never pushed, never written by pull.
     */
    generatedInPlugin: ['.claude-plugin/types'],
    /**
     * The first Claude Code that loads mods: its changelog for 2.1.287 says "Added Claude Mods:
     * plugins may now modify deeper behavior" (T103). Pull warns when this PC's is older.
     */
    modsSince: '2.1.287',
    /** The folder of mods in development, in the base folder (also known state above). */
    devMods: DEV_MODS,
    /**
     * A plugin's own folder, `plugins/data/<folder>` (`CLAUDE_PLUGIN_DATA`), named from its id
     * `<name>@<source>` with every character `unsafe` matches turned into `replaceWith`
     * (Claude Code 2.1.295, T96; read from the 2.1.296 program, T107, which turns `*` too):
     * `lm-plugin@my-local.mkt` → `lm-plugin-my-local-mkt`. Pushed on request, only for a
     * plugin the setup restores (T102).
     */
    data: { folder: 'plugins/data', unsafe: '[^A-Za-z0-9_-]', replaceWith: '-' },
    /**
     * A mod's `$.store`, one file per plugin in `plugins/store/` (folder 700, file 600): the id
     * with every character `unsafe` matches turned into `replaceWith`, cut to `maxNameLength`,
     * then `-`, the first `hashDigits` hex digits of the id's SHA-256 and `.json` (2.1.295, T96;
     * read from the 2.1.296 program, T107, which turns `*` too and cuts the name):
     * `probe-mod@skills-dir` → `probe-mod_skills-dir-e89169932969.json`. Pushed as `data` (T102).
     */
    store: {
      folder: 'plugins/store',
      unsafe: '[^A-Za-z0-9_-]',
      replaceWith: '_',
      maxNameLength: 64,
      hashDigits: 12,
      extension: '.json',
    },
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
   * `~/.claude.json` keys that are preferences: every key with the scope "Global config" in
   * Claude Code's settings reference (https://code.claude.com/docs/en/settings-reference,
   * 2.1.296; the drift check compares them, T109). Everything else there is account, machine
   * or project state. `permissionExplainerEnabled` and `teammateDefaultModel` are listed
   * there as removed (2.1.257, 2.1.234) and still taken, so an older Claude Code keeps them.
   */
  claudeJsonPreferenceKeys: [
    'autoConnectIde',
    'autoInstallIdeExtension',
    'claudeInChromeDefaultEnabled',
    'copyFullResponse',
    'copyOnSelect',
    'defaultToAgentsView',
    'diffTool',
    'externalEditorContext',
    'leftArrowOpensAgents',
    'permissionExplainerEnabled',
    'prStatusFooterEnabled',
    'teammateDefaultModel',
  ],

  /**
   * Keys of a project's entry in `~/.claude.json` (`projects[<path>]`) that are its setup
   * (T109): local-scope MCP servers (the default of `claude mcp add`) and the choices made for
   * the project's `.mcp.json` servers. Trust, history and allowed tools are never taken.
   */
  claudeJsonProjectKeys: ['mcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers'],

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

/** A regular expression as text. */
const Pattern = z.string().refine((pattern) => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}, 'Not a valid pattern');

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
    generatedInPlugin: names,
    modsSince: z.string().regex(/^\d+\.\d+\.\d+$/),
    devMods: z.string().min(1),
    data: z.strictObject({ folder: z.string().min(1), unsafe: Pattern, replaceWith: z.string() }),
    store: z.strictObject({
      folder: z.string().min(1),
      unsafe: Pattern,
      replaceWith: z.string(),
      maxNameLength: z.number().int().min(1),
      hashDigits: z.number().int().min(1).max(64),
      extension: z.string().regex(/^\.[a-z]+$/),
    }),
  }),
  skippedNames: names,
  ignoredCopyPatterns: z.array(Pattern),
  claudeJsonPreferenceKeys: names,
  claudeJsonProjectKeys: names,
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
