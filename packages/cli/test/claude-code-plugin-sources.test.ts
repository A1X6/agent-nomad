import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { REAL_DATA_DIRS, REAL_STORE_FILES } from './claude-code-plugin-fixtures.ts';

import { CLAUDE_CODE_PATHS } from '../src/index.ts';

const PLUGINS = CLAUDE_CODE_PATHS.plugins;

/** The rule `plugins.dataDir` describes: every character outside `A-Za-z0-9_-` becomes `-`. */
const dataDirName = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '-');

/** The rule `plugins.storeDir` describes: `_` for those characters, then a short id hash. */
const storeFileName = (id: string) =>
  `${id.replace(/[^A-Za-z0-9_-]/g, '_')}-${createHash('sha256').update(id).digest('hex').slice(0, 12)}.json`;

describe('Claude Code plugin sources (T95)', () => {
  it('names plugins from skills/<name>/ and --plugin-dir by their source', () => {
    const sources = [...Object.keys(REAL_DATA_DIRS), ...Object.keys(REAL_STORE_FILES)].map((id) =>
      id.slice(id.indexOf('@') + 1),
    );
    expect(sources).toContain(PLUGINS.skillsDirSource);
    expect(sources).toContain(PLUGINS.inlineSource);
  });

  it('names a plugin data folder the way Claude Code 2.1.295 did', () => {
    for (const [id, folder] of Object.entries(REAL_DATA_DIRS)) expect(dataDirName(id)).toBe(folder);
  });

  it("names a mod's $.store file the way Claude Code 2.1.295 did", () => {
    for (const [id, file] of Object.entries(REAL_STORE_FILES)) expect(storeFileName(id)).toBe(file);
  });
});
