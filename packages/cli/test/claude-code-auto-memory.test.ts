import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  base,
  collect,
  home,
  memoryDir,
  options,
  project,
  root,
  setMemoryDirectory,
  useProjectFolders,
} from './claude-code-project-fixtures.ts';
import { paths, text, writeTestFile } from './fakes.ts';
import { findAutoMemory, projectDirName, repositoryRoot } from '../src/index.ts';

useProjectFolders('agentnomad-auto-memory-');

/** Moves the project's auto memory to ~/notes/my-app-memory (local settings); returns it. */
async function notesMemory(): Promise<string> {
  await setMemoryDirectory(
    join(project, '.claude', 'settings.local.json'),
    '~/notes/my-app-memory',
  );
  return join(home, 'notes', 'my-app-memory');
}

describe('auto memory location', () => {
  it('names the folder like Claude Code: every non-letter or digit becomes -', () => {
    expect(projectDirName('E:\\Projects\\agent-nomad')).toBe('E--Projects-agent-nomad');
    expect(projectDirName('/home/ahmed/my_app.v2')).toBe('-home-ahmed-my-app-v2');
  });

  it('uses the repository root, so subfolders share one memory', async () => {
    await mkdir(join(project, '.git'));
    const sub = join(project, 'packages', 'api');
    await mkdir(sub, { recursive: true });
    expect(await repositoryRoot(sub, process.platform)).toBe(resolve(project));
    expect(await findAutoMemory({ ...options(), projectDir: sub })).toEqual({
      kind: 'folder',
      dir: memoryDir(),
    });
  });

  it('uses the main repository for a git worktree', async () => {
    await mkdir(join(project, '.git', 'worktrees', 'feature'), { recursive: true });
    await writeFile(join(project, '.git', 'worktrees', 'feature', 'commondir'), '../..\n');
    const worktree = join(root, 'work', 'my-app-feature');
    await writeTestFile(
      join(worktree, '.git'),
      `gitdir: ${join(project, '.git', 'worktrees', 'feature')}\n`,
    );
    expect(await repositoryRoot(worktree, process.platform)).toBe(resolve(project));
  });

  it('uses the project folder outside git', async () => {
    expect(await repositoryRoot(project, process.platform)).toBe(resolve(project));
  });

  it('honours autoMemoryDirectory from the project settings', async () => {
    const notes = await notesMemory();
    await writeTestFile(join(notes, 'MEMORY.md'), 'custom');
    expect(await findAutoMemory({ ...options(), projectDir: project })).toEqual({
      kind: 'folder',
      dir: join(home, 'notes', 'my-app-memory'),
    });
    expect(text(await collect(true), '.agentnomad/auto-memory/MEMORY.md')).toBe('custom');
  });

  it('takes only Markdown files from auto memory (T43)', async () => {
    const notes = await notesMemory();
    await writeTestFile(join(notes, 'MEMORY.md'), 'notes');
    await writeTestFile(join(notes, 'run.sh'), 'echo hi');
    expect(paths(await collect(true)).filter((path) => path.includes('auto-memory'))).toEqual([
      '.agentnomad/auto-memory/MEMORY.md',
    ]);
  });

  it('never reads a memory folder that is a folder for keys (T43)', async () => {
    await setMemoryDirectory(join(project, '.claude', 'settings.json'), '~/.ssh');
    await writeTestFile(join(home, '.ssh', 'notes.md'), 'secret');
    expect(await findAutoMemory({ ...options(), projectDir: project })).toEqual({
      kind: 'refused',
      dir: join(home, '.ssh'),
      reason: 'it is a folder for keys and logins',
    });
    expect(paths(await collect(true))).toEqual(['.claude/settings.json']);
  });

  it('skips a memory folder set in user settings, since every project shares it', async () => {
    await setMemoryDirectory(join(base, 'settings.json'), '~/all-memory');
    await writeTestFile(join(home, 'all-memory', 'MEMORY.md'), 'shared');
    expect((await findAutoMemory({ ...options(), projectDir: project })).kind).toBe('shared');
    expect(paths(await collect(true))).toEqual([]);
  });

  it('honours CLAUDE_CODE_PROJECT_DIR_NAME beside CLAUDE_CONFIG_DIR', async () => {
    const env = { CLAUDE_CONFIG_DIR: base, CLAUDE_CODE_PROJECT_DIR_NAME: 'work' };
    expect(await findAutoMemory({ ...options(env), projectDir: project })).toEqual({
      kind: 'folder',
      dir: join(base, 'projects', 'work', 'memory'),
    });
  });

  it('finds the hashed folder of a very long path, or reports it unknown', async () => {
    const long = join(root, 'x'.repeat(220));
    await mkdir(long, { recursive: true });
    const cut = projectDirName(resolve(long)).slice(0, 200);
    expect((await findAutoMemory({ ...options(), projectDir: long })).kind).toBe('unknown');
    await mkdir(join(base, 'projects', `${cut}-a1b2c3`), { recursive: true });
    expect(await findAutoMemory({ ...options(), projectDir: long })).toEqual({
      kind: 'folder',
      dir: join(base, 'projects', `${cut}-a1b2c3`, 'memory'),
    });
  });
});
