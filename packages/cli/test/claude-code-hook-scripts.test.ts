import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { stopHook } from './claude-code-project-fixtures.ts';
import { hookScripts, onceEachScript, projectHookScripts } from '../src/index.ts';

// The rules read no file, so these folders need not exist.
const project = resolve('/work/my-app');
const home = resolve('/home/a');
const base = join(home, '.claude');

describe('project hook scripts: one rule for push and pull (DUP-03)', () => {
  it.each([
    ['$CLAUDE_PROJECT_DIR/scripts/a.sh', ['scripts/a.sh']],
    [`bash -c "bash -lc '$CLAUDE_PROJECT_DIR/scripts/a.sh arg; true'"`, ['scripts/a.sh']],
    ['scripts\\a.sh', ['scripts/a.sh']],
    ['~/a.sh', []],
    ['$HOME/a.sh', []],
    ['../outside/a.sh', []],
  ])('reads %s', (word, expected) => {
    const settings = JSON.stringify(stopHook(word));
    expect(
      projectHookScripts(settings, { projectDir: project, platform: process.platform }).map(
        (script) => script.bundlePath,
      ),
    ).toEqual(expected);
  });
});

/** What `hookScripts` tells about the scripts a global Stop hook running `command` runs. */
function skippedGlobal(command: string): string[] {
  const skipped: string[] = [];
  hookScripts(
    JSON.stringify(stopHook(command)),
    { homedir: home, baseDir: base, platform: process.platform },
    (what, reason) => skipped.push(`${what}: ${reason}`),
  );
  return skipped;
}

/** What `projectHookScripts` tells about the scripts a project Stop hook running `command` runs. */
function skippedInProject(command: string): string[] {
  const skipped: string[] = [];
  projectHookScripts(
    JSON.stringify(stopHook(command)),
    { projectDir: project, platform: process.platform },
    (what, reason) => skipped.push(`${what}: ${reason}`),
  );
  return skipped;
}

describe('global hook scripts push cannot take are told, never skipped in silence (T112)', () => {
  it('tells a script outside the home folder', () => {
    const script = join(resolve('/opt/tools'), 'hook.ps1');
    expect(skippedGlobal(`pwsh -File ${script}`)).toEqual([
      `script ${script}: it is outside the home folder`,
    ]);
  });

  it('tells a script in a never-synced folder', () => {
    expect(skippedGlobal('bash ~/.claude/plugins/cache/m/p/run.sh')).toEqual([
      'script ~/.claude/plugins/cache/m/p/run.sh: it is in plugins, which is never synced',
    ]);
  });

  it("tells a script in Claude Code's own state", () => {
    expect(skippedGlobal('~/.claude/chrome/chrome-native-host.bat')).toEqual([
      'script ~/.claude/chrome/chrome-native-host.bat: it is in chrome, which is never synced',
    ]);
  });

  it('tells a script in a folder whose files run by themselves', () => {
    expect(skippedGlobal('~/.config/autostart/start.sh')).toEqual([
      'script ~/.config/autostart/start.sh: it is in a folder whose files run by themselves',
    ]);
  });

  it('tells a script in a folder for keys and logins', () => {
    expect(skippedGlobal('~/.ssh/deploy.sh')).toEqual([
      'script ~/.ssh/deploy.sh: it is in a folder for keys and logins',
    ]);
  });

  it('tells nothing about a script it takes', () => {
    expect(skippedGlobal('bash ~/.claude/hooks/check.sh && ~/bin/notify.py')).toEqual([]);
  });

  it('tells nothing about a word without a script extension', () => {
    expect(skippedGlobal('ssh -i ~/.ssh/id_ed25519 host && ~/.config/autostart/tool')).toEqual([]);
  });
});

describe('project hook scripts push cannot take are told, never skipped in silence (T112)', () => {
  it.each(['~/a.sh', '$HOME/a.sh', '../outside/a.sh'])(
    'tells a script outside the project: %s',
    (word) => {
      expect(skippedInProject(word)).toEqual([`script ${word}: it is outside the project`]);
    },
  );

  it('tells a script in a never-synced folder', () => {
    expect(skippedInProject('.claude/worktrees/wt/a.sh')).toEqual([
      'script .claude/worktrees/wt/a.sh: it is in .claude/worktrees, which is never synced',
    ]);
  });

  it('tells nothing about a script it takes', () => {
    expect(skippedInProject('"$CLAUDE_PROJECT_DIR"/.claude/hooks/lint.sh')).toEqual([]);
  });

  it('tells nothing about a word without a script extension', () => {
    expect(skippedInProject('$HOME/bin/tool --fast')).toEqual([]);
  });
});

describe('onceEachScript (T112)', () => {
  it('tells each script once, however often it is skipped', () => {
    const told: string[] = [];
    const onSkipped = onceEachScript((what, reason) => told.push(`${what}: ${reason}`));
    onSkipped?.('script ~/a.sh', 'it is outside the project');
    onSkipped?.('script ~/a.sh', 'it is outside the project');
    onSkipped?.('script ~/b.sh', 'it is outside the project');
    expect(told).toEqual([
      'script ~/a.sh: it is outside the project',
      'script ~/b.sh: it is outside the project',
    ]);
  });

  it('is nothing without a callback', () => {
    expect(onceEachScript(undefined)).toBeUndefined();
  });
});
