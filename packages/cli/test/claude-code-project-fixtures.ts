import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach } from 'vitest';

import { writeTestFile } from './fakes.ts';
import { createClaudeCodeProjectCollector, projectDirName } from '../src/index.ts';

/**
 * The temporary home and project shared by the Claude Code tests that write real files (review
 * 7 DUP-02, review 8 DUP-01). Kept out of fakes.ts, which must not load any agent's adapter.
 */

// A temporary home (with `.claude`) and project, made by `useProjectFolders` before each
// test. Live bindings: a test file that imports them sees each test's folders.
export let root: string;
export let home: string;
export let base: string;
export let project: string;

/** Makes fresh folders before each test of the calling file and removes them after it. */
export function useProjectFolders(prefix: string): void {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), prefix));
    home = join(root, 'home');
    base = join(home, '.claude');
    project = join(root, 'work', 'my-app');
    await mkdir(base, { recursive: true });
    await mkdir(project, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
}

export const options = (env: Record<string, string> = {}) => ({
  baseDir: base,
  homedir: home,
  platform: process.platform,
  env,
});

/** The project collector, which takes auto memory as `.agentnomad/auto-memory/`. */
export function collect(includeMemory = false, env: Record<string, string> = {}, dir = project) {
  return createClaudeCodeProjectCollector(options(env)).collect(
    { kind: 'project', projectDir: dir },
    { includeMemory },
  );
}

/** The folder Claude Code keeps this project's auto memory in. */
export const memoryDir = (repo = project) => join(base, 'projects', projectDirName(repo), 'memory');

const ACCOUNT = '00000000-0000-4000-8000-000000000000_11111111-1111-4111-8111-111111111111';

export const synced = (...parts: string[]) => join(base, 'skills', 'synced', ACCOUNT, ...parts);

/** A synced folder as Claude Code 2.1.283 writes it: the user's skill, Anthropic's, an organization's. */
export async function syncedSetup(): Promise<void> {
  await writeTestFile(join(base, 'skills', 'synced', `.bucket-${ACCOUNT}`), '');
  await writeTestFile(synced('.last-complete-round'), '1');
  await writeTestFile(synced('.staging', 'tmp'), 'partial');
  await writeTestFile(
    synced('manifest.json'),
    JSON.stringify({
      lastUpdated: 1,
      skills: [
        {
          skillId: 'skill_01',
          name: 'my-skill',
          description: 'd',
          source: 'plugin',
          updatedAt: 't',
          creatorType: 'user',
        },
        {
          skillId: 'pdf',
          name: 'pdf',
          description: 'd',
          source: 'anthropic',
          updatedAt: 't',
          creatorType: 'anthropic',
        },
        {
          skillId: 'skill_02',
          name: 'team-skill',
          description: 'd',
          source: 'org',
          updatedAt: 't',
          creatorType: 'organization',
        },
        {
          skillId: 'skill_03',
          name: 'synced',
          description: 'd',
          source: 'plugin',
          updatedAt: 't',
          creatorType: 'user',
        },
      ],
    }),
  );
  await writeTestFile(synced('my-skill', 'SKILL.md'), '---\nname: my-skill\n---\nDo my thing.\n');
  await writeTestFile(synced('my-skill', 'reference', 'notes.md'), 'Notes.\n');
  await writeTestFile(synced('pdf', 'SKILL.md'), '---\nname: pdf\n---\nAnthropic PDF skill.\n');
  await writeTestFile(synced('team-skill', 'SKILL.md'), '---\nname: team-skill\n---\nOrg only.\n');
  await writeTestFile(synced('synced', 'SKILL.md'), 'reserved name');
}
