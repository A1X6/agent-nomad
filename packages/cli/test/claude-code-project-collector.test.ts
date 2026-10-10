import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { BACKUP_MARKER } from '@agentnomad/core';
import { describe, expect, it } from 'vitest';

import {
  collect,
  collectSkipped,
  home,
  memoryDir,
  options,
  project,
  root,
  stopHook,
  useProjectFolders,
} from './claude-code-project-fixtures.ts';
import { linkFolder, paths, text, writeTestFile } from './fakes.ts';
import { createClaudeCodeProjectCollector } from '../src/index.ts';

useProjectFolders('agentnomad-project-');

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
  await writeTestFile(join(project, '.claude', 'rules', `a.md${BACKUP_MARKER}20260925T120000Z`));
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

  it('takes scripts the hooks in settings.local.json run too', async () => {
    await writeTestFile(join(project, 'scripts', 'mine.py'), 'print(2)');
    await writeTestFile(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify(stopHook('python scripts/mine.py')),
    );
    expect(paths(await collect())).toEqual(['.claude/settings.local.json', 'scripts/mine.py']);
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
  /** Links the folder `target` into the project's skills as `name`. */
  async function linkSkill(target: string, name = 'x'): Promise<void> {
    await mkdir(join(project, '.claude', 'skills'), { recursive: true });
    await linkFolder(target, join(project, '.claude', 'skills', name));
  }

  it('never follows a link to a folder for keys outside the project, and says why', async () => {
    await writeTestFile(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
    await linkSkill(join(home, '.ssh'));
    const { found, skipped } = await collectSkipped(createClaudeCodeProjectCollector(options()));
    expect(paths(found).filter((path) => path.includes('skills'))).toEqual([]);
    expect(skipped).toEqual(['.claude/skills/x: it links to a place outside the project']);
  });

  it('never follows a link into a folder for keys inside the project (a project at home)', async () => {
    // The project is the home folder, so its .ssh is inside the project: the keys rule decides.
    await writeTestFile(join(project, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
    await linkSkill(join(project, '.ssh'));
    const { found, skipped } = await collectSkipped(
      createClaudeCodeProjectCollector({ ...options(), homedir: project }),
    );
    expect(paths(found).filter((path) => path.includes('skills'))).toEqual([]);
    expect(skipped).toEqual(['.claude/skills/x: it links into a folder for keys and logins']);
  });

  it('never follows a link out of the project', async () => {
    await writeTestFile(join(root, 'elsewhere', 'SKILL.md'), 'not this project');
    await linkSkill(join(root, 'elsewhere'));
    expect(paths(await collect()).filter((path) => path.includes('skills'))).toEqual([]);
  });

  it('follows a link that stays inside the project', async () => {
    await writeTestFile(join(project, 'shared', 'review', 'SKILL.md'), 'review');
    await linkSkill(join(project, 'shared', 'review'), 'review');
    expect(text(await collect(), '.claude/skills/review/SKILL.md')).toBe('review');
  });

  it('leaves out a file larger than 10 MB', async () => {
    await writeTestFile(
      join(project, '.claude', 'skills', 'big', 'data.bin'),
      'x'.repeat(10 * 1024 * 1024 + 1),
    );
    await writeTestFile(join(project, '.claude', 'skills', 'big', 'SKILL.md'), 'small');
    const { found, skipped } = await collectSkipped(createClaudeCodeProjectCollector(options()));
    expect(paths(found)).toContain('.claude/skills/big/SKILL.md');
    expect(skipped).toEqual(['.claude/skills/big/data.bin: it is larger than 10 MB']);
  });
});
