/**
 * What the Claude Code project collector takes from a project folder (T26). The lists come
 * from the paths data file (T32).
 */
import { CLAUDE_CODE_PATHS as DATA } from './claude-code-paths.data.ts';
import { RESERVED_DIR } from './global-paths.ts';

/** Files in the project root. `CLAUDE.local.md` is personal and usually gitignored. */
export const PROJECT_ROOT_FILES: readonly string[] = DATA.project.rootFiles;

/** Single files in `<project>/.claude/`. */
export const PROJECT_CLAUDE_FILES: readonly string[] = DATA.project.claudeFiles;

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

/** Claude Code shortens longer project folder names and adds a hash. */
export const MAX_PROJECT_DIR_NAME = 200;
