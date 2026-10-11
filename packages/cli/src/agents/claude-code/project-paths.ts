/**
 * What the Claude Code project collector takes from a project folder (T26). The lists come
 * from the paths data file (T32).
 */
import { RESERVED_DIR } from '../adapter.ts';
import { CLAUDE_CODE_PATHS as DATA, settingsFilesIn } from './claude-code-paths.data.ts';

/** Files in the project root. `CLAUDE.local.md` is personal and usually gitignored. */
export const PROJECT_ROOT_FILES: readonly string[] = DATA.project.rootFiles;

/** Single files in `<project>/.claude/`. */
export const PROJECT_CLAUDE_FILES: readonly string[] = DATA.project.claudeFiles;

/** The project's settings files (DUP-01): the shared one and the personal one. */
export const PROJECT_SETTINGS_FILES: readonly string[] = settingsFilesIn(PROJECT_CLAUDE_FILES).map(
  (name) => `.claude/${name}`,
);

/** Folders in `<project>/.claude/`, taken whole. */
export const PROJECT_CLAUDE_FOLDERS: readonly string[] = DATA.project.claudeFolders;

/** Opt-in: subagent memory with `memory: project`. `agent-memory-local/` is never taken. */
export const PROJECT_MEMORY_FOLDERS: readonly string[] = DATA.project.memoryFolders;

/** Never taken from a project, even when a hook names it; plus agentnomad's reserved folder. */
export const PROJECT_NEVER_SYNCED: readonly string[] = [...DATA.project.neverSynced, RESERVED_DIR];

/** Known `<project>/.claude/` entries left out on purpose (hook scripts come via the hooks). */
export const PROJECT_KNOWN_STATE: readonly string[] = DATA.project.knownState;

/** Opt-in auto memory of the project, stored under this bundle folder. */
export const AUTO_MEMORY_BUNDLE_PREFIX = `${RESERVED_DIR}/auto-memory`;

/** The keys of the project's entry in `~/.claude.json` that are its setup (T109). */
export const CLAUDE_JSON_PROJECT_KEYS: readonly string[] = DATA.claudeJsonProjectKeys;

/**
 * Those keys as saved (T109): the project's local-scope MCP servers and its `.mcp.json`
 * choices, merged into this PC's entry for the folder on pull.
 */
export const CLAUDE_JSON_PROJECT_BUNDLE_PATH = `${RESERVED_DIR}/claude-json-project.json`;

/** Claude Code shortens longer project folder names and adds a hash. */
export const MAX_PROJECT_DIR_NAME = 200;
