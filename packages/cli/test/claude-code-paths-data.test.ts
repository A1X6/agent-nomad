import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_PATHS,
  GLOBAL_FOLDERS,
  GLOBAL_SETTINGS_FILES,
  isPluginGenerated,
  NEVER_SYNCED,
  PLUGIN_GENERATED_PATHS,
  pluginFolderOf,
  pluginMcpFileKind,
  PROJECT_SETTINGS_FILES,
  SCRIPT_EXTENSIONS,
} from '../src/index.ts';

describe('paths data file', () => {
  it('is the source of every list the adapter uses', () => {
    expect(GLOBAL_FOLDERS).toEqual(CLAUDE_CODE_PATHS.global.folders);
    expect(NEVER_SYNCED).toContain('skills/synced');
    expect([...SCRIPT_EXTENSIONS]).toEqual(CLAUDE_CODE_PATHS.scriptExtensions);
    expect(PLUGIN_GENERATED_PATHS).toEqual(CLAUDE_CODE_PATHS.plugins.generatedInPlugin);
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

// The path rules of `global-paths.ts`, the data file's view, are tested here too (review 17
// READ-11): they are names and lookups over its lists, with no file access.
describe('global-paths: what Claude Code generates in a plugin folder (T96)', () => {
  it.each([
    ['skills/my-mod/.claude-plugin/types', true],
    ['skills/my-mod/.claude-plugin/types/claude-code/index.d.ts', true],
    ['skills/my-mod/.claude-plugin/Types/notes.md', false],
    ['.claude/skills/my-mod/.claude-plugin/types/tsconfig.json', true],
    ['skills/my-mod/.claude-plugin/plugin.json', false],
    ['skills/types/SKILL.md', false],
    ['skills/my-mod/.claude-plugin/types.md', false],
    ['skills/my-mod/types/index.d.ts', false],
  ])('what Claude Code generates in a plugin folder (T96): %s → %s', (path, generated) => {
    expect(isPluginGenerated(path)).toBe(generated);
  });

  it('ignores case only when asked, as restore does (review 15 SEC-03)', () => {
    expect(isPluginGenerated('skills/x/.claude-plugin/Types/a.d.ts')).toBe(false);
    expect(isPluginGenerated('skills/x/.claude-plugin/Types/a.d.ts', { ignoreCase: true })).toBe(
      true,
    );
    expect(isPluginGenerated('skills/x/.Claude-Plugin/TYPES', { ignoreCase: true })).toBe(true);
    expect(isPluginGenerated('skills/x/.claude-plugin/plugin.json', { ignoreCase: true })).toBe(
      false,
    );
  });
});

describe('global-paths: plugins in the skills folder (T96, review 17 QA-04)', () => {
  it.each([
    ['skills/my-mod/.claude-plugin/plugin.json', { folder: 'skills/my-mod/', name: 'my-mod' }],
    ['.claude/skills/a/hooks/hooks.json', { folder: '.claude/skills/a/', name: 'a' }],
    // Managed by claude.ai: never a plugin of the setup.
    ['skills/synced/.claude-plugin/plugin.json', null],
    ['skills/synced/acct/x/.claude-plugin/plugin.json', null],
    ['skills/plain', null],
    ['rules/style.md', null],
  ])('the plugin folder of %s', (path, found) => {
    expect(pluginFolderOf(path)).toEqual(found);
  });

  it.each([
    ['skills/gh/.mcp.json', 'map'],
    ['.claude/skills/gh/.mcp.json', 'map'],
    ['skills/gh/.claude-plugin/plugin.json', 'declares'],
    // A file the manifest names is only known once the manifest is read; hooks are not servers.
    ['skills/gh/servers.json', undefined],
    ['skills/gh/hooks/hooks.json', undefined],
    ['skills/synced/.mcp.json', undefined],
    ['.mcp.json', undefined],
  ])('what %s holds for the env scan: %s', (path, kind) => {
    expect(pluginMcpFileKind(path)).toBe(kind);
  });
});
