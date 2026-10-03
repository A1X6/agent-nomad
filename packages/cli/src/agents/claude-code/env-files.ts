import type { EnvReferenceFiles } from '../adapter.ts';
import { CLAUDE_JSON_BUNDLE_PATH } from './global-paths.ts';

/** Files that can hold `${VAR}` references: MCP servers and settings. */
export const MCP_FILES: ReadonlySet<string> = new Set(['.mcp.json', CLAUDE_JSON_BUNDLE_PATH]);
export const SETTINGS_FILES: ReadonlySet<string> = new Set([
  'settings.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
]);

/** Where a Claude Code setup uses environment variables (T30, ARCH-01). */
export const CLAUDE_ENV_REFERENCES: EnvReferenceFiles = {
  mcp: MCP_FILES,
  settings: SETTINGS_FILES,
  /** Variables Claude Code sets itself for hooks and servers; never the user's secrets. */
  ownVariables: new Set([
    'CLAUDE_PROJECT_DIR',
    'CLAUDE_PLUGIN_ROOT',
    'CLAUDE_PLUGIN_DATA',
    'CLAUDE_CONFIG_DIR',
  ]),
  /** `~/.claude.json` for the reserved entry. */
  label: (path) => (path === CLAUDE_JSON_BUNDLE_PATH ? '~/.claude.json' : path),
};
