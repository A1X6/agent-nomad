import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { projectHookScripts } from '../src/index.ts';

// The rules read no file, so this folder need not exist.
const project = resolve('/work/my-app');

describe('project hook scripts: one rule for push and pull (DUP-03)', () => {
  it.each([
    ['$CLAUDE_PROJECT_DIR/scripts/a.sh', ['scripts/a.sh']],
    [`bash -c "bash -lc '$CLAUDE_PROJECT_DIR/scripts/a.sh arg; true'"`, ['scripts/a.sh']],
    ['scripts\\a.sh', ['scripts/a.sh']],
    ['~/a.sh', []],
    ['$HOME/a.sh', []],
    ['../outside/a.sh', []],
  ])('reads %s', (word, expected) => {
    const settings = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: word }] }] },
    });
    expect(
      projectHookScripts(settings, { projectDir: project, platform: process.platform }).map(
        (script) => script.bundlePath,
      ),
    ).toEqual(expected);
  });
});
