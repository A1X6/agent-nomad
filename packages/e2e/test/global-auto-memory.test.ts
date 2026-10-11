import { join } from 'node:path';

import { projectDirName } from '@agentnomad/cli';
import { expect, it } from 'vitest';

import { startLocalServer } from '../src/local-server.ts';
import { newPc, read, write, type RunResult } from '../src/pc.ts';

/**
 * T110: a global push with `--memory` takes the auto memory of every project on the first PC,
 * also of one never pushed as a project, and the pull of the global setup on the second PC
 * writes it back to `~/.claude/projects/<same name>/memory/`. Transcripts beside it never go.
 * Runs on this OS only, never in the CI step jobs.
 */
const LOGIN = ['--username', 'e2e-global-memory', '--password-stdin'];
const stdin = 'amber-harbor-violet-cedar-71\n';

/** A project folder name as Claude Code makes it, for a project never pushed as a project. */
const OTHER_PROJECT = '-home-me-site';
const NOTES = '# Memory\n- The user prefers small commits.\n';
const OTHER_NOTES = 'Deploys go through staging first.\n';

const ok = (result: RunResult) => {
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result;
};

it.skipIf(process.env['E2E_STEP'] !== undefined)(
  "a global push with memory restores every project's auto memory on the second PC",
  async () => {
    const server = await startLocalServer(undefined);
    const first = await newPc('memory-first', { apiUrl: server.url, keychain: false });
    const second = await newPc('memory-second', { apiUrl: server.url, keychain: false });
    try {
      const projects = join(first.home, '.claude', 'projects');
      const name = projectDirName(first.project);
      await write(join(projects, name, 'memory', 'MEMORY.md'), NOTES);
      await write(join(projects, OTHER_PROJECT, 'memory', 'topics', 'deploy.md'), OTHER_NOTES);
      await write(join(projects, OTHER_PROJECT, 'session.jsonl'), 'SECRET transcript');

      ok(await first.run(['register', ...LOGIN, '--yes'], stdin));
      ok(await first.run(['push', '--global', '--yes', '--memory']));

      ok(await second.run(['login', ...LOGIN], stdin));
      ok(await second.run(['pull', '--global', '--yes']));
      const here = join(second.home, '.claude', 'projects');
      expect(await read(join(here, name, 'memory', 'MEMORY.md'))).toBe(NOTES);
      expect(await read(join(here, OTHER_PROJECT, 'memory', 'topics', 'deploy.md'))).toBe(
        OTHER_NOTES,
      );
      await expect(read(join(here, OTHER_PROJECT, 'session.jsonl'))).rejects.toThrow();
    } finally {
      await Promise.all([first.remove(), second.remove()]);
      await server.close();
    }
  },
);
