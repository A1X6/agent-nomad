import { describe, expect, it } from 'vitest';

import { STATE_NAMES, STATE_NAMES_VERSION } from './claude-code-state-names.ts';
import {
  CLAUDE_CODE_PATHS,
  GLOBAL_FOLDERS,
  GLOBAL_KNOWN_STATE,
  GLOBAL_SETTINGS_FILES,
  NEVER_SYNCED,
  PROJECT_SETTINGS_FILES,
  SCRIPT_EXTENSIONS,
} from '../src/index.ts';

describe('paths data file', () => {
  it('is the source of every list the adapter uses', () => {
    expect(GLOBAL_FOLDERS).toEqual(CLAUDE_CODE_PATHS.global.folders);
    expect(NEVER_SYNCED).toContain('skills/synced');
    expect([...SCRIPT_EXTENSIONS]).toEqual(CLAUDE_CODE_PATHS.scriptExtensions);
  });

  it('never lists one name as both synced and never synced', () => {
    const synced = new Set([
      ...CLAUDE_CODE_PATHS.global.files,
      ...CLAUDE_CODE_PATHS.global.folders,
    ]);
    expect(CLAUDE_CODE_PATHS.global.neverSynced.filter((entry) => synced.has(entry))).toEqual([]);
    const known = new Set(CLAUDE_CODE_PATHS.global.knownState);
    expect(CLAUDE_CODE_PATHS.global.neverSynced.filter((entry) => known.has(entry))).toEqual([]);
  });

  it('knows every state name of the Claude Code program it was read from (T108)', () => {
    expect(STATE_NAMES_VERSION).toBe(CLAUDE_CODE_PATHS.reviewedVersion);
    const known = new Set([
      ...CLAUDE_CODE_PATHS.global.files,
      ...CLAUDE_CODE_PATHS.global.folders,
      ...CLAUDE_CODE_PATHS.global.memoryFolders,
      ...NEVER_SYNCED,
      ...GLOBAL_KNOWN_STATE,
      // In the base folder when CLAUDE_CONFIG_DIR is set; the unknown-file check handles it apart.
      '.claude.json',
    ]);
    expect(STATE_NAMES.filter((name) => !known.has(name))).toEqual([]);
  });

  // T108: logins, account state and session content are never synced. T113 checked the six
  // that might be the user's own (shares to project-settings): state, or kept in bytecode.
  it.each([
    '.session_ingress_token',
    'hfi-auth.json',
    '.claude.json.backup',
    'policy-limits.json.signature.json',
    'policy-limits.json.signature-iat.json',
    'remote-settings.json.signature.json',
    'remote-settings.json.signature-iat.json',
    'remote-settings-consent.json',
    'remote-settings-helper-consent',
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
    'cowork_plugins',
    'shares',
    'scratch',
    'agent-memory-local',
    'agent-memory-project',
    'local-settings',
    'project-settings',
  ])('never syncs %s (Claude Code 2.1.296, T108)', (name) => {
    expect(NEVER_SYNCED).toContain(name);
  });

  it('syncs loop.md, the prompt a bare /loop runs, globally and in a project (T113)', () => {
    expect(CLAUDE_CODE_PATHS.global.files).toContain('loop.md');
    expect(CLAUDE_CODE_PATHS.project.claudeFiles).toContain('loop.md');
    expect(NEVER_SYNCED).not.toContain('loop.md');
  });

  // T108: Claude Code's own caches, profiles, traces, locks and markers are known state.
  it.each([
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
  ])('keeps %s as known state (Claude Code 2.1.296, T108)', (name) => {
    expect(GLOBAL_KNOWN_STATE).toContain(name);
  });

  it('names every settings file of the data file in the settings lists (DUP-01)', () => {
    // Deliberately wider than the code's rule (`settings*.json`): a new name such as
    // `settings.yaml` in the data file fails here and forces a decision.
    const named = (names: readonly string[]) => names.filter((name) => /settings/i.test(name));
    expect(GLOBAL_SETTINGS_FILES).toEqual(named(CLAUDE_CODE_PATHS.global.files));
    expect(PROJECT_SETTINGS_FILES).toEqual(
      named(CLAUDE_CODE_PATHS.project.claudeFiles).map((name) => `.claude/${name}`),
    );
    expect(named(CLAUDE_CODE_PATHS.project.rootFiles)).toEqual([]);
    // The same files as before the lists came from the data file.
    expect(GLOBAL_SETTINGS_FILES).toEqual(['settings.json']);
    expect(PROJECT_SETTINGS_FILES).toEqual([
      '.claude/settings.json',
      '.claude/settings.local.json',
    ]);
  });
});
