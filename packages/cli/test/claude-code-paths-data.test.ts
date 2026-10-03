import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_PATHS,
  GLOBAL_FOLDERS,
  NEVER_SYNCED,
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
});
