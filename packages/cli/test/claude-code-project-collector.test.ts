import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { BACKUP_MARKER } from '@agentnomad/core';
import { describe, expect, it } from 'vitest';

import {
  base,
  claudeJsonKey,
  collect,
  collectSkipped,
  home,
  LOCAL_MCP_SERVER,
  memoryDir,
  options,
  project,
  root,
  stopHook,
  useProjectFolders,
  writeClaudeJsonProject,
} from './claude-code-project-fixtures.ts';
import { linkFolder, paths, text, writeTestFile } from './fakes.ts';
import { CLAUDE_JSON_PROJECT_BUNDLE_PATH, createClaudeCodeProjectCollector } from '../src/index.ts';

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

  it('takes .claude/loop.md, the prompt a bare /loop runs there (T113)', async () => {
    await writeTestFile(join(project, '.claude', 'loop.md'), 'Keep the release branch green.');
    const files = await collect();
    expect(paths(files)).toEqual(['.claude/loop.md']);
    expect(text(files, '.claude/loop.md')).toBe('Keep the release branch green.');
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

  it('takes .claude/hooks/ whole, also the scripts no setting runs (T112)', async () => {
    await writeTestFile(join(project, '.claude', 'hooks', 'lint.sh'), 'npm run lint');
    await writeTestFile(join(project, '.claude', 'hooks', 'lib', 'common.sh'), 'shared');
    expect(paths(await collect())).toEqual([
      '.claude/hooks/lib/common.sh',
      '.claude/hooks/lint.sh',
    ]);
  });

  it('tells push about each script its hooks run that it cannot take, once (T112)', async () => {
    const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'bash ~/bin/stop.sh' }] }] };
    await writeTestFile(join(project, '.claude', 'settings.json'), JSON.stringify({ hooks }));
    await writeTestFile(join(project, '.claude', 'settings.local.json'), JSON.stringify({ hooks }));
    const { skipped } = await collectSkipped(createClaudeCodeProjectCollector(options()));
    expect(skipped).toEqual(['script ~/bin/stop.sh: it is outside the project']);
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

describe("project collector: the folder's entry in ~/.claude.json (T109)", () => {
  const CHOICES = { enabledMcpjsonServers: ['shared'], disabledMcpjsonServers: ['other'] };

  it('takes its local MCP servers and .mcp.json choices, nothing else of the entry', async () => {
    await writeClaudeJsonProject(
      {
        allowedTools: ['Bash(rm:*)'],
        hasTrustDialogAccepted: true,
        history: [{ display: 'SECRET prompt' }],
        mcpServers: { local: LOCAL_MCP_SERVER },
        ...CHOICES,
      },
      { oauthAccount: { emailAddress: 'SECRET@example.com' }, diffTool: 'terminal' },
    );
    const files = await collect();
    expect(paths(files)).toEqual([CLAUDE_JSON_PROJECT_BUNDLE_PATH]);
    expect(JSON.parse(text(files, CLAUDE_JSON_PROJECT_BUNDLE_PATH))).toEqual({
      mcpServers: { local: LOCAL_MCP_SERVER },
      ...CHOICES,
    });
  });

  it('takes nothing when no entry is this folder’s', async () => {
    await writeTestFile(
      join(home, '.claude.json'),
      JSON.stringify({
        projects: { [claudeJsonKey(root)]: { mcpServers: { x: LOCAL_MCP_SERVER } } },
      }),
    );
    expect(await collect()).toEqual([]);
  });

  it('takes the .mcp.json choices alone when the entry has no servers', async () => {
    await writeClaudeJsonProject({ mcpServers: {}, ...CHOICES });
    expect(JSON.parse(text(await collect(), CLAUDE_JSON_PROJECT_BUNDLE_PATH))).toEqual(CHOICES);
  });

  it('takes nothing from an entry whose servers and choices are empty', async () => {
    // What `claude mcp add` leaves once its server is removed again.
    await writeClaudeJsonProject({
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      hasTrustDialogAccepted: true,
    });
    expect(await collect()).toEqual([]);
  });

  it('reads it from CLAUDE_CONFIG_DIR when that is set', async () => {
    await writeTestFile(
      join(base, '.claude.json'),
      JSON.stringify({ projects: { [claudeJsonKey()]: CHOICES } }),
    );
    const files = await createClaudeCodeProjectCollector({
      ...options(),
      customConfigDir: true,
    }).collect({ kind: 'project', projectDir: project }, { includeMemory: false });
    expect(JSON.parse(text(files, CLAUDE_JSON_PROJECT_BUNDLE_PATH))).toEqual(CHOICES);
  });
});

describe('project collector: files the memory files import (T111)', () => {
  it('takes a file inside the project at its project path', async () => {
    await writeTestFile(join(project, 'CLAUDE.md'), 'See @docs/guide.md\n');
    await writeTestFile(join(project, 'docs', 'guide.md'), 'Guide\n');
    expect(text(await collect(), 'docs/guide.md')).toBe('Guide\n');
  });

  it('follows the imports of CLAUDE.local.md, AGENTS.md and the rules', async () => {
    await writeTestFile(join(project, 'CLAUDE.local.md'), '@docs/a.md\n');
    await writeTestFile(join(project, 'AGENTS.md'), '@docs/b.md\n');
    await writeTestFile(join(project, '.claude', 'rules', 'x.md'), '@../../docs/c.md\n');
    for (const name of ['a', 'b', 'c']) {
      await writeTestFile(join(project, 'docs', `${name}.md`), name);
    }
    expect(paths(await collect())).toEqual(
      expect.arrayContaining(['docs/a.md', 'docs/b.md', 'docs/c.md']),
    );
  });

  it('names a file outside the project, who imports it and how', async () => {
    await writeTestFile(join(project, 'CLAUDE.md'), '@~/my-project-instructions.md\n');
    await writeTestFile(join(home, 'my-project-instructions.md'), 'Mine\n');
    const { found, skipped } = await collectSkipped(createClaudeCodeProjectCollector(options()));
    expect(paths(found)).toEqual(['CLAUDE.md']);
    expect(skipped).toEqual([
      `~/my-project-instructions.md: ${join(project, 'CLAUDE.md')} imports it on line 1 (@~/my-project-instructions.md), but it is outside the project`,
    ]);
  });
});
