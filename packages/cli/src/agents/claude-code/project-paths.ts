/**
 * What the Claude Code project collector takes from a project folder (T26). An allowlist,
 * like the global one (T32 moves these lists into the paths data file).
 */
import { RESERVED_DIR } from './global-paths.ts';

/** Files in the project root. `CLAUDE.local.md` is personal and usually gitignored. */
export const PROJECT_ROOT_FILES = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  '.mcp.json',
  '.worktreeinclude',
] as const;

/** Single files in `<project>/.claude/`. */
export const PROJECT_CLAUDE_FILES = ['settings.json', 'settings.local.json', 'CLAUDE.md'] as const;

/** Folders in `<project>/.claude/`, taken whole. */
export const PROJECT_CLAUDE_FOLDERS = [
  'rules',
  'skills',
  'commands',
  'agents',
  'workflows',
  'output-styles',
] as const;

/** Opt-in: subagent memory with `memory: project`. `agent-memory-local/` is never taken. */
export const PROJECT_MEMORY_FOLDERS = ['agent-memory'] as const;

/** Never taken from a project, even when a hook names it. */
export const PROJECT_NEVER_SYNCED = [
  '.git',
  '.claude/agent-memory-local',
  '.claude/worktrees',
  RESERVED_DIR,
] as const;

/** Opt-in auto memory of the project, stored under this bundle folder. */
export const AUTO_MEMORY_BUNDLE_PREFIX = `${RESERVED_DIR}/auto-memory`;

/** Claude Code shortens longer project folder names and adds a hash. */
export const MAX_PROJECT_DIR_NAME = 200;
