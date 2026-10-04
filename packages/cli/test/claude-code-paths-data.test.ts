import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_PATHS,
  GLOBAL_FOLDERS,
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
