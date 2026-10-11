import { describe, expect, it } from 'vitest';

import { pullSummary, restoreQuestion, type ConflictChoice } from '../src/index.ts';

/** One planned restore as the summary sees it. */
const restore = (
  options: {
    conflicts?: [string, ConflictChoice][];
    toAdd?: string[];
    declined?: boolean;
  } = {},
) => ({
  name: 'Claude Code global setup',
  files: ['CLAUDE.md', 'settings.json'],
  conflicts: new Map(options.conflicts ?? []),
  env: options.toAdd === undefined ? null : { toAdd: options.toAdd },
  declined: options.declined ?? false,
});

describe('pullSummary (T115)', () => {
  it('names each setup with its files and the environment values it adds', () => {
    expect(pullSummary([restore({ toAdd: ['GITHUB_TOKEN'] })])).toBe(
      [
        'Ready to restore:',
        '  The Claude Code global setup: 2 files',
        '    Always restored (a file here that differs is asked about first)',
        '    Restored only when you choose (a question, or the flag): --env-values GITHUB_TOKEN',
      ].join('\n'),
    );
  });

  it('counts the files here that differ by the answer each got', () => {
    const summary = pullSummary([
      restore({
        conflicts: [
          ['CLAUDE.md', 'merge'],
          ['settings.json', 'skip'],
          ['keybindings.json', 'merge'],
        ],
      }),
    ]);
    expect(summary).toContain(
      '    Always restored (a file here that differs is asked about first); 3 differ here (merge 2, skip 1)',
    );
  });

  it('says no environment values when there are none to add', () => {
    expect(pullSummary([restore()])).toContain(': --env-values none');
  });

  it('says what runs programs is left out when the user declined it', () => {
    expect(pullSummary([restore({ declined: true })])).toContain(
      '--env-values none; --allow-commands no (what runs programs is left out)',
    );
  });
});

describe('restoreQuestion (T115)', () => {
  it('asks about one setup as "it"', () => {
    expect(restoreQuestion(1)).toBe('Restore it now? Nothing is written until you say yes.');
  });

  it('asks about several by number', () => {
    expect(restoreQuestion(3)).toBe(
      'Restore these 3 setups now? Nothing is written until you say yes.',
    );
  });
});
