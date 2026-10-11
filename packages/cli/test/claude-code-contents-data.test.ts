import { describe, expect, it } from 'vitest';

import { readmeSection, tableRows } from './readme.ts';
import { CLAUDE_CODE_CONTENTS } from '../src/index.ts';

/** The README "What is synced" table, by its first cell (`**Global** (~/.claude)` → `Global`). */
const SYNCED_TABLE = new Map(
  tableRows(readmeSection('## What is synced')).map(([row = '', ...cells]) => [
    /\*\*(.+?)\*\*/.exec(row)?.[1] ?? row,
    cells,
  ]),
);

/** A README cell as the list the help prints: split at commas, a capital that only starts the
 * sentence (`Credentials`, not `CLAUDE.md`) in lower case as help has it. */
const items = (cell: string | undefined) =>
  (cell ?? '')
    .split(', ')
    .map((item) =>
      /^[A-Z][a-z]/.test(item) ? item.charAt(0).toLowerCase() + item.slice(1) : item,
    );

describe('contents data file (T115): push --help and the README name the same items', () => {
  it('the global setup: what is synced and never synced, item for item', () => {
    const [synced, never] = SYNCED_TABLE.get('Global') ?? [];
    expect(CLAUDE_CODE_CONTENTS.global).toEqual(items(synced));
    expect(CLAUDE_CODE_CONTENTS.globalNever).toEqual(items(never));
  });

  it('a project: what is synced and never synced, item for item', () => {
    const [synced, never] = SYNCED_TABLE.get('Project') ?? [];
    expect(CLAUDE_CODE_CONTENTS.project).toEqual(items(synced));
    expect(CLAUDE_CODE_CONTENTS.projectNever).toEqual(items(never));
  });

  it('what a setup takes from outside its folder is in the README table too', () => {
    const table = readmeSection('## What is synced').replaceAll('`', '').toLowerCase();
    for (const item of [
      ...CLAUDE_CODE_CONTENTS.globalAlso,
      ...CLAUDE_CODE_CONTENTS.projectAlso,
      ...CLAUDE_CODE_CONTENTS.globalNeverAlso,
    ]) {
      expect(table).toContain(item.toLowerCase());
    }
  });
});
