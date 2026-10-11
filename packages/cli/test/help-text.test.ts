import { describe, expect, it } from 'vitest';

import { readmeSection, tableRows } from './readme.ts';
import { COMMAND_HELP, contentsHelp, type AgentContents } from '../src/index.ts';

/** A small setup's contents, so the layout is easy to read. */
const CONTENTS: AgentContents = {
  globalLabel: 'global setup (~/.demo)',
  global: ['settings.json', 'skills/'],
  globalAlso: ['your servers in ~/.demo.json'],
  project: ['DEMO.md'],
  globalNever: ['credentials'],
  globalNeverAlso: ['your login'],
  projectNever: ['your code'],
};

describe('COMMAND_HELP (T115)', () => {
  it('is what the README Commands table says each command does', () => {
    const readme = new Map(
      tableRows(readmeSection('## Commands')).map(([command = '', does = '']) => [
        command.replace('agentnomad ', ''),
        does,
      ]),
    );
    for (const [command, help] of Object.entries(COMMAND_HELP)) {
      if (command === 'account') continue; // a group, not a command of its own
      expect(readme.get(command)).toBe(`${help.charAt(0).toUpperCase()}${help.slice(1)}.`);
    }
  });
});

describe('contentsHelp (T115)', () => {
  it('lists per agent what is always saved, what only when chosen, and what never', () => {
    expect(
      contentsHelp(
        'push',
        [{ displayName: 'Demo', contents: CONTENTS }],
        [{ flag: '--memory', help: 'save the memory' }],
      ),
    ).toBe(
      [
        '',
        'What is saved (Demo):',
        '  Always saved:',
        '    global setup (~/.demo): settings.json, skills/, your servers in ~/.demo.json',
        '    a project: DEMO.md',
        '  Saved only when you choose (a question, or the flag):',
        '    --memory: save the memory',
        '  Never saved:',
        '    global setup (~/.demo): credentials, your login',
        '    a project: your code',
      ].join('\n'),
    );
  });

  it('uses the restore headings for pull', () => {
    const help = contentsHelp('pull', [{ displayName: 'Demo', contents: CONTENTS }], []);
    expect(help).toContain('What is restored (Demo):');
    expect(help).toContain('  Always restored (a file here that differs is asked about first):');
    expect(help).toContain('  Restored only when you choose (a question, or the flag):');
    expect(help).toContain('  Never in a saved setup:');
  });

  it('wraps a long line at 80 columns, the next lines two spaces deeper', () => {
    const help = contentsHelp(
      'push',
      [{ displayName: 'Demo', contents: CONTENTS }],
      [{ flag: '--long', help: 'word '.repeat(30).trim() }],
    );
    const lines = help.split('\n').filter((line) => line.includes('word'));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 80)).toBe(true);
    expect(lines.slice(1).every((line) => line.startsWith('      word'))).toBe(true);
  });

  it('is empty when no agent says what its setups hold', () => {
    expect(contentsHelp('push', [], [{ flag: '--memory', help: 'save the memory' }])).toBe('');
  });
});
