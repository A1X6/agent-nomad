import { chmod, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  base,
  collectSkipped,
  globalCollector,
  home,
  syncedSetup,
  useProjectFolders,
} from './claude-code-project-fixtures.ts';
import { paths, text, withTempDir, writeTestFile } from './fakes.ts';
import {
  ACCOUNT_SKILLS_PREFIX,
  ClaudeJsonError,
  type ProgramInfo,
  type CollectedFile,
} from '../src/index.ts';

const posix = process.platform !== 'win32';
useProjectFolders('agentnomad-home-');

const collector = (customConfigDir = false, baseDir = base) =>
  globalCollector({ customConfigDir, baseDir });

async function collect(includeMemory = false): Promise<readonly CollectedFile[]> {
  return collector().collect({ kind: 'global' }, { includeMemory });
}

/** A ~/.claude with every kind of file a real one has. */
async function realisticSetup(): Promise<void> {
  for (const file of ['settings.json', 'CLAUDE.md', 'keybindings.json'])
    await writeTestFile(join(base, file));
  await writeTestFile(join(base, 'rules', 'style.md'));
  await writeTestFile(join(base, 'skills', 'deploy', 'SKILL.md'));
  await writeTestFile(join(base, 'skills', 'deploy', 'scripts', 'run.sh'));
  await writeTestFile(join(base, 'commands', 'review.md'));
  await writeTestFile(join(base, 'agents', 'reviewer.md'));
  await writeTestFile(join(base, 'workflows', 'ship.md'));
  await writeTestFile(join(base, 'output-styles', 'terse.md'));
  await writeTestFile(join(base, 'themes', 'dark.json'));
  // Never synced:
  await writeTestFile(join(base, '.credentials.json'), '{"token":"SECRET"}');
  await writeTestFile(join(base, 'history.jsonl'), 'SECRET prompt');
  await writeTestFile(join(base, 'projects', 'C--work-app', 'abc.jsonl'), 'SECRET transcript');
  await writeTestFile(join(base, 'projects', 'C--work-app', 'memory', 'MEMORY.md'));
  for (const dir of [
    'file-history',
    'plans',
    'debug',
    'cache',
    'backups',
    'sessions',
    'jobs',
    'daemon',
    'todos',
    'shell-snapshots',
    'plugins',
    '.trash',
  ]) {
    await writeTestFile(join(base, dir, 'state.json'));
  }
  await writeTestFile(join(base, 'settings.local.json'));
  await writeTestFile(join(base, 'skills', 'synced', 'from-claude-ai', 'SKILL.md'));
  await writeTestFile(join(base, 'unknown-new-thing.json'));
  // Clutter inside a synced folder:
  await writeTestFile(join(base, 'skills', 'deploy', '.git', 'HEAD'));
  await writeTestFile(join(base, 'skills', 'deploy', 'node_modules', 'x', 'index.js'));
  await writeTestFile(join(base, 'skills', 'deploy', '.DS_Store'));
  await writeTestFile(join(base, 'rules', 'style.md.agentnomad-backup-20260925T120000Z'));
  await writeTestFile(join(base, 'rules', 'style.md.agentnomad-incoming-20260925T120000Z'));
  // Opt-in memory:
  await writeTestFile(join(base, 'agent-memory', 'reviewer', 'MEMORY.md'));
}

describe('global collector: what is taken', () => {
  it('takes the synced files and folders, nothing else', async () => {
    await realisticSetup();
    expect(paths(await collect())).toEqual([
      'CLAUDE.md',
      'agents/reviewer.md',
      'commands/review.md',
      'keybindings.json',
      'output-styles/terse.md',
      'rules/style.md',
      'settings.json',
      'skills/deploy/SKILL.md',
      'skills/deploy/scripts/run.sh',
      'themes/dark.json',
      'workflows/ship.md',
    ]);
  });

  it('never takes credentials, history, transcripts or other state', async () => {
    await realisticSetup();
    const files = await collect(true);
    const all = files.map((file) => new TextDecoder().decode(file.content)).join('\n');
    expect(all).not.toContain('SECRET');
    for (const path of paths(files)) {
      expect(path).not.toMatch(
        /^(\.credentials\.json|history\.jsonl|projects|file-history|plans|debug|cache|backups|sessions|jobs|daemon|todos|shell-snapshots|plugins|\.trash|settings\.local\.json)(\/|$)/,
      );
    }
  });

  it('never takes skills/synced/, even through a link or a hook', async () => {
    await writeTestFile(join(base, 'skills', 'synced', 'a', 'SKILL.md'));
    await writeTestFile(join(base, 'skills', 'synced', 'a', 'helper.sh'));
    await writeTestFile(
      join(base, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `bash ${join(base, 'skills', 'synced', 'a', 'helper.sh')}`,
                },
              ],
            },
          ],
        },
      }),
    );
    const files = paths(await collect(true));
    expect(files.some((path) => path.startsWith('skills/synced'))).toBe(false);
  });

  it('skips .git, node_modules, OS clutter and agentnomad backup copies', async () => {
    await realisticSetup();
    const files = paths(await collect());
    expect(
      files.filter((path) => /\.git\/|node_modules|\.DS_Store|agentnomad-/.test(path)),
    ).toEqual([]);
  });

  it('skips a temporary file an interrupted write left (BUG-03)', async () => {
    await writeTestFile(join(base, 'skills', 'x', 'SKILL.md'));
    await writeTestFile(join(base, 'skills', 'x', '.SKILL.md.agentnomad-tmp-0a1b2c3d'));
    expect(paths(await collect())).toEqual(['skills/x/SKILL.md']);
  });

  it('takes subagent memory only when asked', async () => {
    await realisticSetup();
    expect(paths(await collect(false))).not.toContain('agent-memory/reviewer/MEMORY.md');
    expect(paths(await collect(true))).toContain('agent-memory/reviewer/MEMORY.md');
  });

  it('keeps the bytes and marks executable scripts on macOS and Linux', async () => {
    await writeTestFile(join(base, 'skills', 's', 'run.sh'), '#!/bin/sh\necho hi\n');
    if (posix) await chmod(join(base, 'skills', 's', 'run.sh'), 0o755);
    const files = await collect();
    expect(text(files, 'skills/s/run.sh')).toBe('#!/bin/sh\necho hi\n');
    expect(files[0]?.executable).toBe(posix);
  });

  it('returns nothing for an empty folder', async () => {
    expect(await collect()).toEqual([]);
  });

  it('refuses the project scope (T26)', async () => {
    await expect(
      collector().collect({ kind: 'project', projectDir: home }, { includeMemory: false }),
    ).rejects.toThrow('global');
  });
});

describe('global collector: ~/.claude.json', () => {
  const claudeJson = {
    mcpServers: { github: { command: 'npx', args: ['gh-mcp'], env: { TOKEN: '${GITHUB_TOKEN}' } } },
    diffTool: 'terminal',
    autoConnectIde: true,
    oauthAccount: { emailAddress: 'SECRET@example.com' },
    userID: 'SECRET-user',
    machineID: 'SECRET-machine',
    projects: { '/home/a/app': { allowedTools: [], hasTrustDialogAccepted: true } },
    numStartups: 108,
    cachedGrowthBookFeatures: { x: 1 },
  };

  it('keeps only MCP servers and preference keys', async () => {
    await writeTestFile(join(home, '.claude.json'), JSON.stringify(claudeJson));
    const files = await collect();
    expect(JSON.parse(text(files, '.agentnomad/claude.json'))).toEqual({
      mcpServers: claudeJson.mcpServers,
      diffTool: 'terminal',
      autoConnectIde: true,
    });
    expect(text(files, '.agentnomad/claude.json')).not.toContain('SECRET');
  });

  it('adds nothing when there are no servers or preferences', async () => {
    await writeTestFile(
      join(home, '.claude.json'),
      JSON.stringify({ numStartups: 3, mcpServers: {} }),
    );
    expect(await collect()).toEqual([]);
  });

  it('reads it from CLAUDE_CONFIG_DIR when that is set', async () => {
    const custom = join(home, 'work-claude');
    await writeTestFile(join(custom, '.claude.json'), JSON.stringify({ diffTool: 'auto' }));
    await writeTestFile(join(home, '.claude.json'), JSON.stringify({ diffTool: 'terminal' }));
    const files = await collector(true, custom).collect(
      { kind: 'global' },
      { includeMemory: false },
    );
    expect(JSON.parse(text(files, '.agentnomad/claude.json'))).toEqual({ diffTool: 'auto' });
  });

  it('stops with a clear message when the file is half-written', async () => {
    await writeTestFile(join(home, '.claude.json'), '{"mcpServers": {');
    await expect(collect()).rejects.toBeInstanceOf(ClaudeJsonError);
  });
});

describe('global collector: hook and status line scripts', () => {
  async function withSettings(settings: object): Promise<readonly CollectedFile[]> {
    await writeTestFile(join(base, 'settings.json'), JSON.stringify(settings));
    return collect();
  }
  const hook = (command: string) => ({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] },
  });

  it('takes a script inside ~/.claude by its path there', async () => {
    await writeTestFile(join(base, 'hooks', 'check.sh'), 'echo check');
    const files = await withSettings(hook(`bash "${join(base, 'hooks', 'check.sh')}"`));
    expect(text(files, 'hooks/check.sh')).toBe('echo check');
  });

  it('takes a script elsewhere in home under .agentnomad/home/', async () => {
    await writeTestFile(join(home, 'scripts', 'status.py'), 'print(1)');
    const files = await withSettings({
      statusLine: { type: 'command', command: `python3 ${join(home, 'scripts', 'status.py')}` },
    });
    expect(text(files, '.agentnomad/home/scripts/status.py')).toBe('print(1)');
  });

  it('takes the script of a hook in exec form, even with spaces in an argument (BUG-01)', async () => {
    const script = join(base, 'hooks', 'my checks', 'check.js');
    await writeTestFile(script, 'check');
    const files = await withSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node', args: [script, '--fast'] }] }],
      },
    });
    expect(text(files, 'hooks/my checks/check.js')).toBe('check');
  });

  it('takes a script named inside a quoted command line or next to a ; (SEC-01)', async () => {
    await writeTestFile(join(base, 'hooks', 'a.sh'));
    await writeTestFile(join(base, 'hooks', 'b.sh'));
    await writeTestFile(join(base, 'hooks', 'c.sh'));
    const files = await withSettings({
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: `bash -c "${join(base, 'hooks', 'a.sh')}; true"` },
              { type: 'command', command: `${join(base, 'hooks', 'b.sh')};` },
              // A command line inside a command line.
              {
                type: 'command',
                command: `bash -c "bash -lc '${join(base, 'hooks', 'c.sh')} arg; true'"`,
              },
            ],
          },
        ],
      },
    });
    expect(paths(files)).toEqual(
      expect.arrayContaining(['hooks/a.sh', 'hooks/b.sh', 'hooks/c.sh']),
    );
  });

  it('understands ~ and $HOME in commands', async () => {
    await writeTestFile(join(home, 'bin', 'a.sh'));
    await writeTestFile(join(home, 'bin', 'b.sh'));
    const files = paths(
      await withSettings({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: '~/bin/a.sh' },
                { type: 'command', command: '$HOME/bin/b.sh --fast' },
              ],
            },
          ],
        },
      }),
    );
    expect(files).toEqual(
      expect.arrayContaining(['.agentnomad/home/bin/a.sh', '.agentnomad/home/bin/b.sh']),
    );
  });

  it('never takes keys or logins a command mentions', async () => {
    await writeTestFile(join(home, '.ssh', 'deploy.sh'), 'SECRET');
    await writeTestFile(join(home, '.ssh', 'id_ed25519'), 'SECRET');
    await writeTestFile(join(home, '.aws', 'login.py'), 'SECRET');
    const files = await withSettings(
      hook(`ssh -i ~/.ssh/id_ed25519 host && ~/.ssh/deploy.sh && python ~/.aws/login.py`),
    );
    expect(paths(files)).toEqual(['settings.json']);
  });

  it('ignores programs on PATH, missing files and files outside home', async () => {
    await withTempDir('agentnomad-outside-', async (outside) => {
      await writeTestFile(join(outside, 'tool.sh'));
      const files = await withSettings({
        statusLine: { type: 'command', command: 'ccstatusline' },
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: `~/missing.sh; ${join(outside, 'tool.sh')}` }] },
          ],
        },
      });
      expect(paths(files)).toEqual(['settings.json']);
    });
  });
});

describe.runIf(posix)('global collector: links', () => {
  it('follows a linked skills folder once and survives a link loop', async () => {
    const dotfiles = join(home, 'dotfiles', 'my-skill');
    await writeTestFile(join(dotfiles, 'SKILL.md'), 'linked');
    await mkdir(join(base, 'skills'));
    await symlink(dotfiles, join(base, 'skills', 'my-skill'));
    await symlink(join(base, 'skills'), join(base, 'skills', 'loop'));
    const files = await collect();
    expect(text(files, 'skills/my-skill/SKILL.md')).toBe('linked');
    expect(paths(files).some((path) => path.includes('loop/loop'))).toBe(false);
  });
});

describe('global collector: a link into a folder for keys (T45)', () => {
  it('is never followed, and push is told why', async () => {
    await writeTestFile(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
    await mkdir(join(base, 'skills'), { recursive: true });
    await symlink(
      join(home, '.ssh'),
      join(base, 'skills', 'keys'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const { found: files, skipped } = await collectSkipped(collector(), { kind: 'global' });
    expect(paths(files).some((path) => path.startsWith('skills/keys'))).toBe(false);
    expect(skipped).toEqual(['skills/keys: it links into a folder for keys and logins']);
  });
});

describe('global collector: programs the status line and hooks need', () => {
  const statusLine = (command: string) =>
    writeTestFile(
      join(base, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command } }),
    );
  const npmInfo = (command: string) =>
    Promise.resolve({ command, npm: { package: command, version: '2.2.22' } });

  function collectWith(
    findProgram?: (command: string) => Promise<ProgramInfo | null>,
    globalFiles?: readonly string[],
  ) {
    return globalCollector({
      ...(findProgram && { findProgram }),
      ...(globalFiles && { globalFiles }),
    }).collect({ kind: 'global' }, { includeMemory: false });
  }

  it('takes ccstatusline settings and records the npm package and version', async () => {
    await statusLine('ccstatusline');
    await writeTestFile(join(home, '.config', 'ccstatusline', 'settings.json'), '{"lines":[]}');
    const files = await collectWith(npmInfo);
    expect(text(files, '.agentnomad/home/.config/ccstatusline/settings.json')).toBe('{"lines":[]}');
    expect(JSON.parse(text(files, '.agentnomad/programs.json'))).toEqual({
      programs: [{ command: 'ccstatusline', npm: { package: 'ccstatusline', version: '2.2.22' } }],
    });
  });

  it('npx needs no install record, but the tool settings still come along', async () => {
    await statusLine('npx -y ccstatusline@latest');
    await writeTestFile(join(home, '.config', 'ccstatusline', 'settings.json'), '{}');
    const files = paths(await collectWith(npmInfo));
    expect(files).toContain('.agentnomad/home/.config/ccstatusline/settings.json');
    expect(files).not.toContain('.agentnomad/programs.json');
  });

  it('records a program that is not from npm without install details', async () => {
    await writeTestFile(
      join(base, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'terminal-notifier -message done' }] }],
        },
      }),
    );
    const files = await collectWith((command) => Promise.resolve({ command, npm: null }));
    expect(JSON.parse(text(files, '.agentnomad/programs.json'))).toEqual({
      programs: [{ command: 'terminal-notifier', npm: null }],
    });
  });

  it('leaves out, and says so, a program pull would refuse (BUG-01)', async () => {
    await writeTestFile(
      join(base, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: '_tool --x' }] },
            { hooks: [{ type: 'command', command: 'terminal-notifier -message done' }] },
          ],
        },
      }),
    );
    const { found: files, skipped } = await collectSkipped(
      globalCollector({ findProgram: (command) => Promise.resolve({ command, npm: null }) }),
      { kind: 'global' },
    );
    expect(JSON.parse(text(files, '.agentnomad/programs.json'))).toEqual({
      programs: [{ command: 'terminal-notifier', npm: null }],
    });
    expect(skipped).toEqual(['program _tool: pull refuses its name or package']);
  });

  it('records the programs of every settings file in the one programs.json (T86)', async () => {
    const hook = (command: string) =>
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } });
    await writeTestFile(join(base, 'settings.json'), hook('terminal-notifier -message done'));
    await writeTestFile(join(base, 'settings.local.json'), hook('ccstatusline --hook'));
    // A second settings file the data file does not list (yet).
    const files = await collectWith(npmInfo, ['settings.json', 'settings.local.json']);
    expect(JSON.parse(text(files, '.agentnomad/programs.json'))).toEqual({
      programs: [
        { command: 'ccstatusline', npm: { package: 'ccstatusline', version: '2.2.22' } },
        { command: 'terminal-notifier', npm: { package: 'terminal-notifier', version: '2.2.22' } },
      ],
    });
  });
});

describe('global collector: claude.ai skills (T42)', () => {
  it('the global collector adds them only when asked', async () => {
    await syncedSetup();
    await writeTestFile(join(base, 'CLAUDE.md'), 'Notes');
    const global = collector();
    const plain = await global.collect({ kind: 'global' }, { includeMemory: false });
    expect(
      plain.some(
        (file) => file.path.includes('synced') || file.path.startsWith(ACCOUNT_SKILLS_PREFIX),
      ),
    ).toBe(false);
    const withSkills = await global.collect(
      { kind: 'global' },
      { includeMemory: false, include: new Set(['account-skills']) },
    );
    expect(withSkills.filter((file) => file.path.startsWith(ACCOUNT_SKILLS_PREFIX))).toHaveLength(
      2,
    );
    expect(withSkills.some((file) => file.path.startsWith('skills/synced'))).toBe(false);
  });
});
