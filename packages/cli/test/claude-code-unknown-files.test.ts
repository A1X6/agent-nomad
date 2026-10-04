import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { BACKUP_MARKER } from '@agentnomad/core';
import { describe, expect, it } from 'vitest';

import { stopHook } from './claude-code-project-fixtures.ts';
import { useTempDir, writeTestFile } from './fakes.ts';
import { findUnknownEntries } from '../src/index.ts';

let root: string;
let base: string;
let project: string;
useTempDir('agentnomad-unknown-', (dir) => {
  root = dir;
  base = join(root, '.claude');
  project = join(root, 'app');
});

const input = () => ({ baseDir: base, platform: process.platform });

describe('unknown-file check (T32 done-when)', () => {
  it('reports an unlisted file or folder, never skipping it silently', async () => {
    await writeTestFile(join(base, 'settings.json'));
    await writeTestFile(join(base, 'skills', 'mine', 'SKILL.md'));
    await writeTestFile(join(base, 'hooks', 'a.sh'));
    await writeTestFile(join(base, 'new-feature.json'));
    expect(await findUnknownEntries({ kind: 'global' }, input())).toEqual([
      'hooks/',
      'new-feature.json',
    ]);
  });

  it('does not report a folder whose script a hook or the status line runs (T49)', async () => {
    const home = dirname(base);
    await writeTestFile(join(base, 'hooks', 'check.sh'));
    await writeTestFile(join(base, 'bin', 'status.sh'));
    await writeTestFile(join(base, 'tools', 'unused.sh'));
    await writeFile(
      join(base, 'settings.json'),
      JSON.stringify({
        ...stopHook('~/.claude/hooks/check.sh'),
        statusLine: { type: 'command', command: 'bash ~/.claude/bin/status.sh' },
      }),
    );
    // push saves hooks/check.sh and bin/status.sh; nothing in tools/ is saved.
    expect(await findUnknownEntries({ kind: 'global' }, { ...input(), homedir: home })).toEqual([
      'tools/',
    ]);
  });

  it('does not report a folder whose script a hook in exec form runs (BUG-01)', async () => {
    await writeTestFile(join(base, 'hooks', 'check.js'));
    await writeFile(
      join(base, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'node', args: ['~/.claude/hooks/check.js'] }] },
          ],
        },
      }),
    );
    expect(
      await findUnknownEntries({ kind: 'global' }, { ...input(), homedir: dirname(base) }),
    ).toEqual([]);
  });

  it('does not report skills/synced/, secrets, state or known copies', async () => {
    await writeTestFile(join(base, 'skills', 'synced', 'x', 'SKILL.md'));
    await writeTestFile(join(base, '.credentials.json'));
    await writeTestFile(join(base, 'projects', 'C--x', 'a.jsonl'));
    await writeTestFile(join(base, 'state', 'x'));
    await writeTestFile(join(base, 'chrome', 'x'));
    await writeTestFile(join(base, 'settings.json.bak'));
    await writeTestFile(join(base, `CLAUDE.md${BACKUP_MARKER}20260925T120000Z`));
    await writeTestFile(join(base, '.claude.json'));
    expect(await findUnknownEntries({ kind: 'global' }, input())).toEqual([]);
  });

  it('checks a project’s .claude folder', async () => {
    await writeTestFile(join(project, '.claude', 'settings.json'));
    await writeTestFile(join(project, '.claude', 'worktrees', 'wt', 'x'));
    await writeTestFile(join(project, '.claude', 'agent-memory-local', 'x'));
    await writeTestFile(join(project, '.claude', 'hooks', 'lint.sh'));
    await writeTestFile(join(project, '.claude', 'brand-new.json'));
    await writeTestFile(join(project, 'src', 'index.ts'));
    expect(await findUnknownEntries({ kind: 'project', projectDir: project }, input())).toEqual([
      '.claude/brand-new.json',
    ]);
  });

  it('a missing folder reports nothing', async () => {
    expect(await findUnknownEntries({ kind: 'global' }, input())).toEqual([]);
  });
});
