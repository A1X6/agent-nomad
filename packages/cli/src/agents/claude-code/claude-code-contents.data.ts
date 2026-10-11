import type { AgentContents } from '../adapter.ts';

/**
 * What a Claude Code setup holds, as `push --help`, `pull --help` and the README "What is
 * synced" table say it (T115). Each list is one cell of that table, item for item (first letter
 * aside): program.test.ts fails when they differ. The collectors and the restorer decide what is
 * synced; this only names it.
 */
export const CLAUDE_CODE_CONTENTS: AgentContents = {
  globalLabel: 'global setup (~/.claude)',
  global: [
    'settings.json',
    'CLAUDE.md',
    'keybindings.json',
    'loop.md (your /loop prompt)',
    'rules/',
    'skills/',
    'commands/',
    'agents/',
    'workflows/',
    'output-styles/',
    'themes/',
    'hooks/',
    'scripts your hooks and status line run',
  ],
  globalAlso: [
    'your MCP servers and documented preferences in ~/.claude.json',
    'which plugins and marketplaces you use',
  ],
  project: [
    'CLAUDE.md',
    'CLAUDE.local.md',
    'AGENTS.md',
    '.mcp.json',
    '.worktreeinclude',
    '.claude/ settings',
    'loop.md and folders',
    "scripts the project's hooks run",
  ],
  projectAlso: ['its local MCP servers', '.mcp.json approvals'],
  globalNever: [
    'credentials',
    'history',
    'transcripts',
    'sessions',
    'caches',
    'backups',
    'settings.local.json',
    'skills/synced/ (claude.ai syncs those itself)',
  ],
  globalNeverAlso: [
    'your login, project trust, history and allowed tools, usage and onboarding state',
    'plugin caches',
  ],
  projectNever: ['your code', '.env', '.git', '.claude/agent-memory-local/', '.claude/worktrees/'],
};
