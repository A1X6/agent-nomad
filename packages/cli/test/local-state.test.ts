import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { GLOBAL_SCOPE_KEY, ProjectNameSchema } from '@agentnomad/contracts';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { CWD, localStateIn, readText, useTempDir } from './fakes.ts';
import type { LocalState } from '../src/index.ts';

let dir: string;
let state: LocalState;
useTempDir('agentnomad-state-', (temp) => {
  dir = temp;
  state = localStateIn(dir);
});

describe('the revisions this PC knows belong to one account (T56)', () => {
  it('another account, or none stored, starts with no revisions but keeps project names', async () => {
    await state.setRevision('claude-code', GLOBAL_SCOPE_KEY, 7, { partial: true });
    await state.rememberProject(CWD, 'my-app');
    // A state.json from before T56 knows no account: its revisions are not trusted.
    await state.useAccount('alice');
    expect(await state.knownRevisions()).toEqual({});
    await state.setRevision('claude-code', GLOBAL_SCOPE_KEY, 7, { partial: true });

    await state.useAccount('alice');
    expect(await state.revisionOf('claude-code', 'global')).toBe(7);
    expect(await state.isPartial('claude-code', 'global')).toBe(true);

    await state.useAccount('bob');
    expect(await state.revisionOf('claude-code', 'global')).toBeNull();
    expect(await state.isPartial('claude-code', 'global')).toBe(false);
    expect(await state.projectNameFor(CWD)).toBe('my-app');
  });

  it('an older agentnomad still reads the file, and the account never shows as a project', async () => {
    await state.useAccount('alice');
    await state.rememberProject(CWD, 'my-app');
    await state.setRevision('claude-code', GLOBAL_SCOPE_KEY, 2);
    // The state.json schema of agentnomad 1.0.3, which refuses unknown keys.
    const server = z.strictObject({
      projects: z.record(z.string(), ProjectNameSchema),
      revisions: z.record(z.string(), z.int().min(1)),
    });
    const old = z.strictObject({ version: z.literal(1), servers: z.record(z.string(), server) });
    const text = await readText(join(dir, 'state.json'));
    expect(old.safeParse(JSON.parse(text)).success).toBe(true);
    expect(await state.projectNameFor('#account')).toBeNull();
  });
});

describe('a local state file that cannot be read (BUG-06)', () => {
  it('stops with the reason instead of starting again from nothing', async () => {
    // A folder where the file should be: reading it fails with something other than ENOENT.
    const path = join(dir, 'unreadable.json');
    await mkdir(path);
    const unreadable = localStateIn(dir, 'unreadable.json');
    await expect(unreadable.projectNameFor(CWD)).rejects.toThrow(
      `Could not read agentnomad's local state file ${path}`,
    );
    await expect(unreadable.rememberProject(CWD, 'my-app')).rejects.toThrow(
      `Could not read agentnomad's local state file ${path}`,
    );
  });

  it('a missing file is still an empty state', async () => {
    expect(await state.projectNameFor(CWD)).toBeNull();
    await state.rememberProject(CWD, 'my-app');
    expect(await state.projectNameFor(CWD)).toBe('my-app');
  });
});
