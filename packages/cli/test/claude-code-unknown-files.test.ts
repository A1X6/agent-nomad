import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { BACKUP_MARKER } from '@agentnomad/core';
import { describe, expect, it } from 'vitest';

import { stopHook } from './claude-code-project-fixtures.ts';
import { STATE_FOLDER_NAMES, STATE_NAMES } from './claude-code-state-names.ts';
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
    await writeTestFile(join(base, 'tools', 'a.sh'));
    await writeTestFile(join(base, 'new-feature.json'));
    expect(await findUnknownEntries({ kind: 'global' }, input())).toEqual([
      'new-feature.json',
      'tools/',
    ]);
  });

  it('does not report hooks/, synced whole even when no setting runs its scripts (T112)', async () => {
    await writeTestFile(join(base, 'hooks', 'unused.sh'));
    expect(await findUnknownEntries({ kind: 'global' }, input())).toEqual([]);
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
    // T94: state files Claude Code 2.1.289 added (all still in the 2.1.296 program).
    await writeTestFile(join(base, 'daemon.lock'));
    await writeTestFile(join(base, 'daemon.status.json'));
    await writeTestFile(join(base, 'gh-pr-status-cache.json'));
    await writeTestFile(join(base, 'mcp-needs-auth-cache.json'));
    // T96: the state file Claude Code 2.1.295 added (2.1.296 too).
    await writeTestFile(join(base, 'policy-limits.json.stamp.json'));
    // T107: the /ultrareview scratch folder Claude Code 2.1.295 named in its changelog.
    await writeTestFile(join(base, 'seed-admin', 'index'));
    await writeTestFile(join(base, 'settings.json.bak'));
    await writeTestFile(join(base, `CLAUDE.md${BACKUP_MARKER}20260925T120000Z`));
    await writeTestFile(join(base, '.claude.json'));
    expect(await findUnknownEntries({ kind: 'global' }, input())).toEqual([]);
  });

  it('does not report any state name of the Claude Code program (2.1.296, T108)', async () => {
    // The folder list as folders; the names only the copy list has, as files.
    const folders = new Set<string>(STATE_FOLDER_NAMES);
    for (const name of STATE_NAMES) {
      await writeTestFile(folders.has(name) ? join(base, name, 'x') : join(base, name));
    }
    expect(await findUnknownEntries({ kind: 'global' }, input())).toEqual([]);
  });

  it('does not report dev-mods/, the mods Claude Code keeps per session (T103)', async () => {
    await writeTestFile(join(base, 'dev-mods', 'session-a', 'probe-mod', 'hooks', 'hooks.json'));
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
