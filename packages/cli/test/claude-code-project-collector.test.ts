import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeTestFile } from './fakes.ts';
import {
  createClaudeCodeProjectCollector,
  projectDirName,
  type CollectedFile,
} from '../src/index.ts';

let root: string;
let home: string;
let base: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentnomad-project-'));
  home = join(root, 'home');
  base = join(home, '.claude');
  project = join(root, 'work', 'my-app');
  await mkdir(base, { recursive: true });
  await mkdir(project, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const options = (env: Record<string, string> = {}) => ({
  baseDir: base,
  homedir: home,
  platform: process.platform,
  env,
});

function collect(includeMemory = false, env: Record<string, string> = {}, dir = project) {
  return createClaudeCodeProjectCollector(options(env)).collect(
    { kind: 'project', projectDir: dir },
    { includeMemory },
  );
}
const paths = (files: readonly CollectedFile[]) => files.map((file) => file.path);
const text = (files: readonly CollectedFile[], path: string) =>
  new TextDecoder().decode(files.find((file) => file.path === path)?.content);

/** The folder Claude Code keeps this project's auto memory in. */
const memoryDir = (repo = project) => join(base, 'projects', projectDirName(repo), 'memory');

async function realisticProject(): Promise<void> {
  for (const file of [
    'CLAUDE.md',
    'CLAUDE.local.md',
    'AGENTS.md',
    '.mcp.json',
    '.worktreeinclude',
  ]) {
    await writeTestFile(join(project, file));
  }
  for (const file of ['settings.json', 'settings.local.json', 'CLAUDE.md']) {
    await writeTestFile(join(project, '.claude', file));
  }
  for (const dir of ['rules', 'skills/test', 'commands', 'agents', 'workflows', 'output-styles']) {
    await writeTestFile(join(project, '.claude', dir, 'a.md'));
  }
  // Never taken:
  await writeTestFile(join(project, 'src', 'index.ts'), 'SECRET app code');
  await writeTestFile(join(project, '.env'), 'SECRET=1');
  await writeTestFile(join(project, '.git', 'config'));
  await writeTestFile(
    join(project, '.claude', 'agent-memory-local', 'r', 'MEMORY.md'),
    'SECRET local',
  );
  await writeTestFile(join(project, '.claude', 'worktrees', 'wt', 'CLAUDE.md'), 'SECRET worktree');
  await writeTestFile(join(project, '.claude', 'skills', 'test', 'node_modules', 'x.js'));
  await writeTestFile(join(project, '.claude', 'rules', 'a.md.agentnomad-backup-20260925T120000Z'));
  await writeTestFile(join(project, '.claude', 'unknown.json'));
  // Opt-in:
  await writeTestFile(join(project, '.claude', 'agent-memory', 'reviewer', 'MEMORY.md'));
  await writeTestFile(join(memoryDir(), 'MEMORY.md'), '- [Role](user_role.md)');
  await writeTestFile(join(memoryDir(), 'user_role.md'), 'backend dev');
}

describe('project collector: what is taken', () => {
  it('takes the root files and the .claude allowlist, nothing else', async () => {
    await realisticProject();
    expect(paths(await collect())).toEqual([
      '.claude/CLAUDE.md',
      '.claude/agents/a.md',
      '.claude/commands/a.md',
      '.claude/output-styles/a.md',
      '.claude/rules/a.md',
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/skills/test/a.md',
      '.claude/workflows/a.md',
      '.mcp.json',
      '.worktreeinclude',
      'AGENTS.md',
      'CLAUDE.local.md',
      'CLAUDE.md',
    ]);
  });

  it('never takes app code, .env, .git, local agent memory or worktrees', async () => {
    await realisticProject();
    const files = await collect(true);
    const all = files.map((file) => new TextDecoder().decode(file.content)).join('\n');
    expect(all).not.toContain('SECRET');
  });

  it('takes subagent memory and auto memory only when asked', async () => {
    await realisticProject();
    expect(paths(await collect(false)).filter((path) => path.includes('memory'))).toEqual([]);
    const files = await collect(true);
    expect(paths(files).filter((path) => path.includes('memory'))).toEqual([
      '.agentnomad/auto-memory/MEMORY.md',
      '.agentnomad/auto-memory/user_role.md',
      '.claude/agent-memory/reviewer/MEMORY.md',
    ]);
    expect(text(files, '.agentnomad/auto-memory/user_role.md')).toBe('backend dev');
  });

  it('takes scripts the project hooks run, when they are inside the project', async () => {
    await writeTestFile(join(project, '.claude', 'hooks', 'lint.sh'), 'npm run lint');
    await writeTestFile(join(project, 'scripts', 'check.py'), 'print(1)');
    await writeTestFile(join(project, '.env.sh'), 'SECRET');
    await writeTestFile(join(root, 'outside.sh'));
    await writeTestFile(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              hooks: [
                { type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/lint.sh' },
                { type: 'command', command: 'python scripts/check.py' },
                { type: 'command', command: `bash ${join(root, 'outside.sh')}` },
                { type: 'command', command: 'bash ../outside.sh' },
              ],
            },
          ],
        },
      }),
    );
    const files = await collect();
    expect(paths(files)).toEqual([
      '.claude/hooks/lint.sh',
      '.claude/settings.json',
      'scripts/check.py',
    ]);
    expect(text(files, '.claude/hooks/lint.sh')).toBe('npm run lint');
  });

  it('returns nothing for a folder without a Claude Code setup', async () => {
    await writeTestFile(join(project, 'README.md'));
    expect(await collect(true)).toEqual([]);
  });

  it('refuses the global scope', async () => {
    await expect(
      createClaudeCodeProjectCollector(options()).collect(
        { kind: 'global' },
        { includeMemory: false },
      ),
    ).rejects.toThrow('project');
  });
});

describe('project collector: links and size (T45)', () => {
  /** A folder link; a junction on Windows, which needs no admin rights. */
  const linkFolder = (target: string, path: string) =>
    symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');

  it('never follows a link to a folder for keys outside the project, and says why', async () => {
    await writeTestFile(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
    await mkdir(join(project, '.claude', 'skills'), { recursive: true });
    await linkFolder(join(home, '.ssh'), join(project, '.claude', 'skills', 'x'));
    const skipped: string[] = [];
    const found = await createClaudeCodeProjectCollector(options()).collect(
      { kind: 'project', projectDir: project },
      { includeMemory: false, onSkipped: (path, reason) => skipped.push(`${path}: ${reason}`) },
    );
    expect(paths(found).filter((path) => path.includes('skills'))).toEqual([]);
    expect(skipped).toEqual(['.claude/skills/x: it links to a place outside the project']);
  });

  it('never follows a link into a folder for keys inside the project (a project at home)', async () => {
    // The project is the home folder, so its .ssh is inside the project: the keys rule decides.
    await writeTestFile(join(project, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
    await mkdir(join(project, '.claude', 'skills'), { recursive: true });
    await linkFolder(join(project, '.ssh'), join(project, '.claude', 'skills', 'x'));
    const skipped: string[] = [];
    const found = await createClaudeCodeProjectCollector({
      ...options(),
      homedir: project,
    }).collect(
      { kind: 'project', projectDir: project },
      { includeMemory: false, onSkipped: (path, reason) => skipped.push(`${path}: ${reason}`) },
    );
    expect(paths(found).filter((path) => path.includes('skills'))).toEqual([]);
    expect(skipped).toEqual(['.claude/skills/x: it links into a folder for keys and logins']);
  });

  it('never follows a link out of the project', async () => {
    await writeTestFile(join(root, 'elsewhere', 'SKILL.md'), 'not this project');
    await mkdir(join(project, '.claude', 'skills'), { recursive: true });
    await linkFolder(join(root, 'elsewhere'), join(project, '.claude', 'skills', 'x'));
    expect(paths(await collect()).filter((path) => path.includes('skills'))).toEqual([]);
  });

  it('follows a link that stays inside the project', async () => {
    await writeTestFile(join(project, 'shared', 'review', 'SKILL.md'), 'review');
    await mkdir(join(project, '.claude', 'skills'), { recursive: true });
    await linkFolder(
      join(project, 'shared', 'review'),
      join(project, '.claude', 'skills', 'review'),
    );
    expect(text(await collect(), '.claude/skills/review/SKILL.md')).toBe('review');
  });

  it('leaves out a file larger than 10 MB', async () => {
    await writeTestFile(
      join(project, '.claude', 'skills', 'big', 'data.bin'),
      'x'.repeat(10 * 1024 * 1024 + 1),
    );
    await writeTestFile(join(project, '.claude', 'skills', 'big', 'SKILL.md'), 'small');
    const skipped: string[] = [];
    const found = await createClaudeCodeProjectCollector(options()).collect(
      { kind: 'project', projectDir: project },
      { includeMemory: false, onSkipped: (path, reason) => skipped.push(`${path}: ${reason}`) },
    );
    expect(paths(found)).toContain('.claude/skills/big/SKILL.md');
    expect(skipped).toEqual(['.claude/skills/big/data.bin: it is larger than 10 MB']);
  });
});
