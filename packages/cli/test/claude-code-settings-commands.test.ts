import { describe, expect, it } from 'vitest';

import { commandsInSettings, commandWords, pathWords, programOf } from '../src/index.ts';

describe('commandsInSettings', () => {
  const hook = (command: string) => ({ hooks: [{ type: 'command', command }] });

  it('reads commands from every hook event and the status line', () => {
    expect(
      commandsInSettings(
        JSON.stringify({
          hooks: {
            PreToolUse: [{ hooks: [{ type: 'command', command: 'a' }] }],
            Stop: [
              {
                hooks: [
                  { type: 'command', command: 'b' },
                  { type: 'prompt', prompt: 'x' },
                ],
              },
            ],
          },
          statusLine: { type: 'command', command: 'c' },
        }),
      ),
    ).toEqual([['a'], ['b'], ['c']]);
    expect(commandsInSettings('not json')).toEqual([]);
  });

  it('commandsInSettings skips only the malformed hook', () => {
    const settings = JSON.stringify({
      hooks: {
        _note: 'mine',
        Stop: [hook('notify.sh'), { hooks: [{ command: 'bad.sh', args: [1] }] }],
      },
      statusLine: { type: 'command', command: 'line.sh' },
    });
    expect(commandsInSettings(settings)).toEqual([['notify.sh'], ['line.sh']]);
  });
});

describe('command words', () => {
  it.each([
    [
      '"$CLAUDE_PROJECT_DIR"/.claude/hooks/a.sh --x',
      ['$CLAUDE_PROJECT_DIR/.claude/hooks/a.sh', '--x'],
    ],
    ["bash 'my scripts/a.sh'", ['bash', 'my scripts/a.sh']],
    ['node "C:\\Program Files\\x.js"', ['node', 'C:\\Program Files\\x.js']],
    ['a  b', ['a', 'b']],
  ])('splits %j like a shell', (command, words) => {
    expect(commandWords(command)).toEqual(words);
  });
});

describe('programOf', () => {
  it.each([
    ['ccstatusline', { name: 'ccstatusline', runner: false }],
    ['npx -y ccstatusline@latest', { name: 'ccstatusline', runner: true }],
    ['bunx @scope/tool@1.2.3 --flag', { name: '@scope/tool', runner: true }],
    ['FOO=1 my-tool --x', { name: 'my-tool', runner: false }],
    ['ccstatusline.cmd', { name: 'ccstatusline', runner: false }],
    ['bash ~/x.sh', null],
    ['~/bin/x.sh', null],
    ['node script.js', null],
    ['echo done', null],
    ['printf hi', null],
  ])('reads the program of %j', (command, expected) => {
    expect(programOf(commandWords(command))).toEqual(expected);
  });
});

describe('pathWords', () => {
  it('finds every word that can name a script, once each (SEC-01)', () => {
    // Split at shell operators, the whole word kept too.
    expect(pathWords(['a.sh&&b.sh'])).toEqual(['a.sh&&b.sh', 'a.sh', 'b.sh']);
    // A quoted path with spaces stays whole, beside its parts.
    expect(pathWords(commandWords('node "C:\\Program Files\\x.js"'))).toEqual([
      'node',
      'C:\\Program Files\\x.js',
      'C:\\Program',
      'Files\\x.js',
    ]);
    // Command lines inside command lines, at any depth.
    expect(
      pathWords(commandWords(`bash -c "bash -lc '$CLAUDE_PROJECT_DIR/scripts/a.sh arg; true'"`)),
    ).toContain('$CLAUDE_PROJECT_DIR/scripts/a.sh');
    expect(pathWords(commandWords(`pwsh -Command "& 'C:\\tools\\a.ps1' -Flag"`))).toContain(
      'C:\\tools\\a.ps1',
    );
    expect(pathWords(['', 'x', 'x'])).toEqual(['x']);
  });
});
