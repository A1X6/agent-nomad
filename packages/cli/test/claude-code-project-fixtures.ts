import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach } from 'vitest';

import { createClaudeCodeProjectCollector, projectDirName } from '../src/index.ts';

/**
 * Set-up shared by the Claude Code project collector and auto memory tests (review 7
 * DUP-02). Kept out of fakes.ts, which must not load any agent's adapter.
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
