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
    ],
    /**
     * Other things Claude Code keeps in the base folder that are known and deliberately
     * left out (state, logs, caches). Known, so the unknown-file check stays quiet.
     */
    knownState: [
      '.last-cleanup',
      '.last-update-result.json',
      'chrome',
      'daemon.log',
      'state',
      'logs',
      'telemetry',
      'local',
      'usage-data',
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

  /** Home folders never read for hook scripts, whatever a command names: keys and cloud logins. */
  sensitiveHomeDirs: [
    '.ssh',
    '.gnupg',
    '.aws',
    '.azure',
    '.kube',
    '.docker',
    '.config/gcloud',
    '.config/gh',
    '.password-store',
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
  sensitiveHomeDirs: names,
  toolConfigFiles: z.record(z.string(), names),
  runtimeCommands: names,
  packageRunners: names,
});

export type ClaudeCodePathsData = z.infer<typeof PathsDataSchema>;

/** The checked data; a mistake in the lists fails loudly at startup and in tests. */
export const CLAUDE_CODE_PATHS: ClaudeCodePathsData = PathsDataSchema.parse(RAW);
