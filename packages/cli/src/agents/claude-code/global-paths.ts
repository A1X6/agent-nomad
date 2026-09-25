/**
 * What the Claude Code global collector takes from `~/.claude` (T25). Everything is an
 * allowlist: a file Claude Code adds in a new version is left out until it is listed here
 * (T32 moves these lists into the paths data file and reports unknown files).
 */

/** Single files in the base folder. */
export const GLOBAL_FILES = ['settings.json', 'CLAUDE.md', 'keybindings.json'] as const;

/** Folders in the base folder, taken whole (minus the skips below). */
export const GLOBAL_FOLDERS = [
  'rules',
  'skills',
  'commands',
  'agents',
  'workflows',
  'output-styles',
  'themes',
] as const;

/** Opt-in: subagent memory with `memory: user` (auto memory is per project, T26). */
export const GLOBAL_MEMORY_FOLDERS = ['agent-memory'] as const;

/**
 * Never taken, even when a hook names them. `skills/synced/` is downloaded by Claude Code
 * from the claude.ai account, which already syncs it.
 */
export const NEVER_SYNCED = [
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
  'skills/synced',
] as const;

/** Names skipped anywhere inside a synced folder: tool state and OS clutter. */
export const SKIPPED_NAMES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

/**
 * `~/.claude.json` keys that are preferences: the "Global config" keys in Claude Code's
 * settings reference. Everything else there is account, machine or project state.
 */
export const CLAUDE_JSON_PREFERENCE_KEYS = [
  'autoConnectIde',
  'autoInstallIdeExtension',
  'copyOnSelect',
  'diffTool',
  'externalEditorContext',
] as const;

/** User-scope MCP servers, also kept in `~/.claude.json`. */
export const CLAUDE_JSON_MCP_KEY = 'mcpServers';

/** Reserved bundle folder for files that do not live in the base folder. */
export const RESERVED_DIR = '.agentnomad';
/** The selected `~/.claude.json` keys. */
export const CLAUDE_JSON_BUNDLE_PATH = `${RESERVED_DIR}/claude.json`;
/** Hook and status line scripts elsewhere in the home folder, by path from home. */
export const HOME_SCRIPTS_PREFIX = `${RESERVED_DIR}/home/`;

/** A hook argument is only taken as a script with one of these extensions. */
export const SCRIPT_EXTENSIONS = new Set([
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
]);

/** Home folders never read for hook scripts, whatever a command names: keys and cloud logins. */
export const SENSITIVE_HOME_DIRS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.config/gcloud',
  '.config/gh',
  '.password-store',
] as const;
