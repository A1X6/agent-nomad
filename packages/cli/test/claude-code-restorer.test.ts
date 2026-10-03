import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collected, writeTestFile } from './fakes.ts';
import {
  createClaudeCodeGlobalCollector,
  createClaudeCodeProjectCollector,
  createClaudeCodeRestorer,
  globalDestination,
  hookScripts,
  windowsNameProblem,
  hooksForOtherOs,
  lineEndingsFor,
  projectDestination,
  projectDirName,
  projectHookScripts,
  sameForRestore,
  type ClaudeCodeRestorer,
  type ConflictChoice,
  type ConflictQuestion,
} from '../src/index.ts';

const posix = process.platform !== 'win32';
const NOW = new Date('2026-09-25T12:00:00.000Z');
const STAMP = '20260925T120000Z';

let root: string;
let home: string;
let base: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentnomad-restore-'));
  home = join(root, 'home');
  base = join(home, '.claude');
  project = join(root, 'work', 'my-app');
  await mkdir(base, { recursive: true });
  await mkdir(project, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = (path: string) => readFile(path, 'utf8');
const readJson = async (path: string) => JSON.parse(await read(path)) as Record<string, unknown>;

interface Setup {
  running?: boolean[];
  customConfigDir?: boolean;
  /** Replaces the scripted running check, e.g. with one that fails. */
  isClaudeRunning?: () => Promise<boolean>;
}

function restorer(setup: Setup = {}): ClaudeCodeRestorer {
  const running = [...(setup.running ?? [false])];
  return createClaudeCodeRestorer({
    baseDir: base,
    homedir: home,
    platform: process.platform,
    env: {},
    customConfigDir: setup.customConfigDir ?? false,
    now: () => NOW,
    isClaudeRunning: setup.isClaudeRunning ?? (() => Promise.resolve(running.shift() ?? false)),
  });
}

/** Answers every conflict question the same way and records what was asked. */
function answer(choice: ConflictChoice) {
  const questions: [string, ConflictQuestion][] = [];
  const resolve = (path: string, question: ConflictQuestion) => {
    questions.push([path, question]);
    return Promise.resolve(choice);
  };
  return { questions, resolve };
}

describe('restorer: round trip', () => {
  it('a collected global setup restores byte-for-byte on a fresh PC', async () => {
    const sourceHome = join(root, 'source');
    const sourceBase = join(sourceHome, '.claude');
    await writeTestFile(join(sourceBase, 'settings.json'), '{"theme":"dark"}\n');
    await writeTestFile(join(sourceBase, 'CLAUDE.md'), '# Rules\r\nWindows line endings stay.\r\n');
    await writeTestFile(
      join(sourceBase, 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\n---\n',
    );
    await writeTestFile(
      join(sourceBase, 'skills', 'deploy', 'logo.png'),
      new Uint8Array([0, 255, 1, 254]),
    );
    const collected = await createClaudeCodeGlobalCollector({
      baseDir: sourceBase,
      homedir: sourceHome,
      platform: process.platform,
      customConfigDir: false,
    }).collect({ kind: 'global' }, { includeMemory: false });

    const report = await restorer().restore({ kind: 'global' }, collected, answer('skip').resolve);
    expect(report.written).toEqual(collected.map((entry) => entry.path));
    for (const entry of collected) {
      expect(new Uint8Array(await readFile(join(base, ...entry.path.split('/'))))).toEqual(
        entry.content,
      );
    }
  });

  it('a collected project setup restores into another folder, memory included', async () => {
    const source = join(root, 'other-pc', 'my-app');
    await writeTestFile(join(source, 'CLAUDE.md'), 'project rules');
    await writeTestFile(join(source, '.claude', 'settings.local.json'), '{}');
    const sourceMemory = join(base, 'projects', projectDirName(source), 'memory');
    await writeTestFile(join(sourceMemory, 'MEMORY.md'), 'remember this');
    const collected = await createClaudeCodeProjectCollector({
      baseDir: base,
      homedir: home,
      platform: process.platform,
      env: {},
    }).collect({ kind: 'project', projectDir: source }, { includeMemory: true });

    await restorer().restore(
      { kind: 'project', projectDir: project },
      collected,
      answer('skip').resolve,
    );
    expect(await read(join(project, 'CLAUDE.md'))).toBe('project rules');
    // Memory lands in this folder's own memory directory.
    expect(await read(join(base, 'projects', projectDirName(project), 'memory', 'MEMORY.md'))).toBe(
      'remember this',
    );
  });
});

describe('restorer: refuses what a collector never produces', () => {
  it.each([
    ['skills/synced/x/SKILL.md', 'never synced'],
    ['.credentials.json', 'never synced'],
    ['history.jsonl', 'never synced'],
    ['projects/C--x/abc.jsonl', 'never synced'],
    ['unknown.json', 'not part of a Claude Code setup'],
    ['.agentnomad/home/.ssh/id_ed25519', 'a folder for keys and logins'],
    ['.agentnomad/home/.bashrc', 'no hook or status line in this setup runs it'],
    // Files that run by themselves, never shown in the pull review (T38, T43).
    [
      '.agentnomad/home/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/update.bat',
      'a folder whose files run by themselves',
    ],
    [
      '.agentnomad/home/Documents/PowerShell/Microsoft.PowerShell_profile.ps1',
      'a folder whose files run by themselves',
    ],
    [
      '.agentnomad/home/OneDrive/Documents/WindowsPowerShell/profile.ps1',
      'a folder whose files run by themselves',
    ],
    ['.agentnomad/home/.config/fish/config.fish', 'a folder whose files run by themselves'],
    ['.agentnomad/home/.config/fish/conf.d/a.fish', 'a folder whose files run by themselves'],
    ['.agentnomad/home/Library/LaunchAgents/x.sh', 'a folder whose files run by themselves'],
    ['.agentnomad/home/.SSH/id_ed25519', 'a folder for keys and logins'],
    ['.agentnomad/other.json', 'unknown agentnomad entry'],
    // Windows and macOS ignore case: another spelling of a refused folder is refused too (T43).
    ['Plugins/cache/m/p/1.0.0/hooks/run.sh', 'never synced'],
    ['Skills/Synced/x/run.sh', 'never synced'],
    ['.AgentNomad/home/x.sh', 'unknown agentnomad entry'],
    ['../outside.md', 'not a safe path'],
  ])('global: %s', (path, reason) => {
    expect(globalDestination(path, new Set())).toEqual({ kind: 'refused', reason });
  });

  it('global: a hook naming an autostart file does not make it restorable (T43)', () => {
    const startup = 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/a.cmd';
    const settings = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `~/${startup}` }] }] },
    });
    const context = { homedir: home, baseDir: base, platform: process.platform };
    expect(hookScripts(settings, context)).toEqual([]);
    expect(
      globalDestination(`.agentnomad/home/${startup}`, new Set([`.agentnomad/home/${startup}`])),
    ).toEqual({ kind: 'refused', reason: 'a folder whose files run by themselves' });
  });

  it('global: a home script is restored only when a hook or the status line runs it', () => {
    const settings = JSON.stringify({
      statusLine: { type: 'command', command: '~/scripts/statusline.sh' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash $HOME/tools/stop.sh' }] }] },
    });
    const scripts = new Set(
      hookScripts(settings, { homedir: home, baseDir: base, platform: process.platform }).map(
        (script) => script.bundlePath,
      ),
    );
    expect(scripts).toEqual(
      new Set(['.agentnomad/home/scripts/statusline.sh', '.agentnomad/home/tools/stop.sh']),
    );
    expect(globalDestination('.agentnomad/home/scripts/statusline.sh', scripts)).toEqual({
      kind: 'home',
      path: 'scripts/statusline.sh',
    });
    expect(globalDestination('.agentnomad/home/scripts/other.sh', scripts)).toEqual({
      kind: 'refused',
      reason: 'no hook or status line in this setup runs it',
    });
    // Known tool settings are not run, so they need no hook.
    expect(
      globalDestination('.agentnomad/home/.config/ccstatusline/settings.json', new Set()),
    ).toEqual({ kind: 'home', path: '.config/ccstatusline/settings.json' });
  });

  it.each([
    ['.git/config', 'never synced'],
    ['.claude/agent-memory-local/a/MEMORY.md', 'never synced'],
    ['.claude/worktrees/wt/CLAUDE.md', 'never synced'],
    ['src/index.ts', 'not part of a Claude Code setup'],
    ['.env', 'not part of a Claude Code setup'],
    ['.GIT/hooks/pre-commit.sh', 'never synced'],
    ['.agentnomad/x.sh', 'unknown agentnomad entry'],
    ['.agentnomad/auto-memory/run.sh', 'auto memory holds only Markdown files'],
    ['.agentnomad/auto-memory/.bashrc', 'auto memory holds only Markdown files'],
  ])('project: %s', (path, reason) => {
    expect(projectDestination(path)).toEqual({ kind: 'refused', reason });
  });

  // A forged bundle cannot replace a launcher or Claude Code itself in its folder (T55, SEC-03).
  it.each([
    ['chrome/chrome-native-host.bat', 'never synced'],
    ['local/node_modules/@anthropic-ai/claude-code/cli.js', 'never synced'],
    ['Chrome/chrome-native-host.bat', 'never synced'],
    ['anything/else/run.ps1', 'no hook or status line in this setup runs it'],
    ['run.sh', 'no hook or status line in this setup runs it'],
  ])('global: a script outside the synced folders that no hook runs: %s', (path, reason) => {
    expect(globalDestination(path, new Set())).toEqual({ kind: 'refused', reason });
  });

  it('global: a base-folder script is restored when a hook runs it, never in Claude Code state', () => {
    const settings = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: '~/.claude/hooks/check.sh' },
              { type: 'command', command: '~/.claude/chrome/chrome-native-host.bat' },
              { type: 'command', command: 'node ~/.claude/local/node_modules/x/cli.js' },
            ],
          },
        ],
      },
    });
    const scripts = new Set(
      hookScripts(settings, { homedir: home, baseDir: base, platform: process.platform }).map(
        (script) => script.bundlePath,
      ),
    );
    expect(scripts).toEqual(new Set(['hooks/check.sh']));
    expect(globalDestination('hooks/check.sh', scripts)).toEqual({
      kind: 'target',
      path: 'hooks/check.sh',
    });
    // Even a set that names it (as an older bundle might) does not open Claude Code's state.
    expect(
      globalDestination(
        'chrome/chrome-native-host.bat',
        new Set(['chrome/chrome-native-host.bat']),
      ),
    ).toEqual({ kind: 'refused', reason: 'never synced' });
  });

  it('restores no script outside the synced folders unless a hook in the bundle runs it', async () => {
    const settings = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/check.sh' }] }] },
    });
    const report = await restorer().restore(
      { kind: 'global' },
      [
        collected('settings.json', settings),
        collected('hooks/check.sh', 'echo ok'),
        collected('chrome/chrome-native-host.bat', 'evil'),
        collected('local/node_modules/@anthropic-ai/claude-code/cli.js', 'evil'),
        collected('anything/else/run.ps1', 'evil'),
      ],
      answer('overwrite').resolve,
    );
    expect([...report.written].sort()).toEqual(['hooks/check.sh', 'settings.json']);
    expect([...report.skipped].sort()).toEqual([
      'anything/else/run.ps1',
      'chrome/chrome-native-host.bat',
      'local/node_modules/@anthropic-ai/claude-code/cli.js',
    ]);
    expect(await read(join(base, 'hooks', 'check.sh'))).toBe('echo ok');
    await expect(stat(join(base, 'chrome'))).rejects.toThrow();
    await expect(stat(join(base, 'local'))).rejects.toThrow();
    await expect(stat(join(base, 'anything'))).rejects.toThrow();
  });

  it('never writes into skills/synced/, even when a bundle contains it', async () => {
    const report = await restorer().restore(
      { kind: 'global' },
      [collected('skills/synced/evil/SKILL.md', 'x'), collected('skills/mine/SKILL.md', 'ok')],
      answer('overwrite').resolve,
    );
    expect(report.skipped).toEqual(['skills/synced/evil/SKILL.md']);
    expect(report.warnings).toEqual(['Refused "skills/synced/evil/SKILL.md": never synced.']);
    await expect(stat(join(base, 'skills', 'synced'))).rejects.toThrow();
    expect(await read(join(base, 'skills', 'mine', 'SKILL.md'))).toBe('ok');
  });

  it('does not write programs.json (pull only reads it)', async () => {
    const report = await restorer().restore(
      { kind: 'global' },
      [collected('.agentnomad/programs.json', '{"programs":[]}')],
      answer('skip').resolve,
    );
    expect(report).toEqual({ written: [], skipped: [], backups: [], warnings: [] });
    expect(await readdir(base)).toEqual([]);
  });
});

describe('restorer: existing files', () => {
  it('leaves an identical file alone without asking', async () => {
    await writeTestFile(join(base, 'CLAUDE.md'), 'same');
    const { questions, resolve } = answer('overwrite');
    const report = await restorer().restore(
      { kind: 'global' },
      [collected('CLAUDE.md', 'same')],
      resolve,
    );
    expect(questions).toEqual([]);
    expect(report.written).toEqual([]);
  });

  it('asks about a different file, and skip leaves it untouched', async () => {
    await writeTestFile(join(base, 'CLAUDE.md'), 'mine');
    const { questions, resolve } = answer('skip');
    const report = await restorer().restore(
      { kind: 'global' },
      [collected('CLAUDE.md', 'theirs')],
      resolve,
    );
    expect(questions).toEqual([['CLAUDE.md', { overwriteAllowed: true }]]);
    expect(report.skipped).toEqual(['CLAUDE.md']);
    expect(await read(join(base, 'CLAUDE.md'))).toBe('mine');
  });

  it('overwrite backs the old file up first', async () => {
    await writeTestFile(join(base, 'CLAUDE.md'), 'mine');
    const report = await restorer().restore(
      { kind: 'global' },
      [collected('CLAUDE.md', 'theirs')],
      answer('overwrite').resolve,
    );
    expect(await read(join(base, 'CLAUDE.md'))).toBe('theirs');
    expect(await read(join(base, `CLAUDE.md.agentnomad-backup-${STAMP}`))).toBe('mine');
    expect(report.backups).toEqual([`CLAUDE.md.agentnomad-backup-${STAMP}`]);
  });

  it('never replaces an earlier backup made in the same second (T45)', async () => {
    await writeTestFile(join(base, 'CLAUDE.md'), 'first');
    await writeTestFile(join(base, `CLAUDE.md.agentnomad-backup-${STAMP}`), 'older backup');
    const report = await restorer().restore(
      { kind: 'global' },
      [collected('CLAUDE.md', 'second')],
      answer('overwrite').resolve,
    );
    expect(report.backups).toEqual([`CLAUDE.md.agentnomad-backup-${STAMP}-2`]);
    expect(await read(join(base, `CLAUDE.md.agentnomad-backup-${STAMP}`))).toBe('older backup');
    expect(await read(join(base, `CLAUDE.md.agentnomad-backup-${STAMP}-2`))).toBe('first');
  });

  it('merge combines JSON keys, the pulled values winning', async () => {
    await writeTestFile(
      join(base, 'settings.json'),
      JSON.stringify({ theme: 'light', model: 'opus' }),
    );
    await restorer().restore(
      { kind: 'global' },
      [collected('settings.json', JSON.stringify({ theme: 'dark', effortLevel: 'high' }))],
      answer('merge').resolve,
    );
    expect(JSON.parse(await read(join(base, 'settings.json')))).toEqual({
      theme: 'dark',
      model: 'opus',
      effortLevel: 'high',
    });
  });

  it('merge keeps a different text file and puts the pulled one next to it', async () => {
    await writeTestFile(join(base, 'CLAUDE.md'), 'mine');
    const report = await restorer().restore(
      { kind: 'global' },
      [collected('CLAUDE.md', 'theirs')],
      answer('merge').resolve,
    );
    expect(await read(join(base, 'CLAUDE.md'))).toBe('mine');
    expect(await read(join(base, `CLAUDE.md.agentnomad-incoming-${STAMP}`))).toBe('theirs');
    expect(report.written).toEqual([`CLAUDE.md.agentnomad-incoming-${STAMP}`]);
  });

  it.runIf(posix)('writes through a linked file, keeping the link (T53)', async () => {
    const real = join(root, 'dotfiles', 'CLAUDE.md');
    await writeTestFile(real, 'mine');
    await symlink(real, join(base, 'CLAUDE.md'));
    const report = await restorer().restore(
      { kind: 'global' },
      [collected('CLAUDE.md', 'theirs')],
      answer('overwrite').resolve,
    );
    expect((await lstat(join(base, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
    expect(await read(real)).toBe('theirs');
    expect(await read(join(base, `CLAUDE.md.agentnomad-backup-${STAMP}`))).toBe('mine');
    expect(report.written).toEqual(['CLAUDE.md']);
    expect(await readdir(join(root, 'dotfiles'))).toEqual(['CLAUDE.md']);
  });

  it.runIf(posix)('merges through a linked ~/.claude.json, keeping the link (T53)', async () => {
    const real = join(root, 'dotfiles', 'claude.json');
    await writeTestFile(real, '{"diffTool":"auto"}');
    await symlink(real, join(home, '.claude.json'));
    await restorer().restore(
      { kind: 'global' },
      [collected('.agentnomad/claude.json', '{"diffTool":"terminal"}')],
      answer('merge').resolve,
    );
    expect((await lstat(join(home, '.claude.json'))).isSymbolicLink()).toBe(true);
    expect(await readJson(real)).toEqual({ diffTool: 'terminal' });
  });

  it('leaves no temporary files behind', async () => {
    await restorer().restore(
      { kind: 'global' },
      [collected('rules/a.md', 'a')],
      answer('skip').resolve,
    );
    expect(await readdir(join(base, 'rules'))).toEqual(['a.md']);
  });
});

describe('restorer: ~/.claude.json', () => {
  const incoming = collected(
    '.agentnomad/claude.json',
    JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } }, diffTool: 'terminal' }),
  );
  const existingJson = {
    oauthAccount: { emailAddress: 'me@example.com' },
    projects: { '/x': { hasTrustDialogAccepted: true } },
    mcpServers: { local: { command: 'local-mcp' } },
    diffTool: 'auto',
  };

  it('merges only the servers and preferences, keeping the login and everything else', async () => {
    await writeTestFile(join(home, '.claude.json'), JSON.stringify(existingJson));
    const { questions, resolve } = answer('merge');
    const report = await restorer().restore({ kind: 'global' }, [incoming], resolve);
    expect(questions).toEqual([
      [
        '.agentnomad/claude.json',
        {
          overwriteAllowed: false,
          message:
            '~/.claude.json: add your MCP servers and preferences (your login and history stay)?',
        },
      ],
    ]);
    expect(JSON.parse(await read(join(home, '.claude.json')))).toEqual({
      ...existingJson,
      mcpServers: { local: { command: 'local-mcp' }, github: { command: 'gh-mcp' } },
      diffTool: 'terminal',
    });
    expect(report.backups).toEqual([join(home, `.claude.json.agentnomad-backup-${STAMP}`)]);
  });

  it('never replaces the file, even when the answer is overwrite', async () => {
    await writeTestFile(join(home, '.claude.json'), JSON.stringify(existingJson));
    await restorer().restore({ kind: 'global' }, [incoming], answer('overwrite').resolve);
    expect((await readJson(join(home, '.claude.json')))['oauthAccount']).toEqual(
      existingJson.oauthAccount,
    );
  });

  it('skip leaves it alone', async () => {
    await writeTestFile(join(home, '.claude.json'), JSON.stringify(existingJson));
    await restorer().restore({ kind: 'global' }, [incoming], answer('skip').resolve);
    expect(JSON.parse(await read(join(home, '.claude.json')))).toEqual(existingJson);
  });

  it('asks nothing when the keys are already there', async () => {
    await writeTestFile(
      join(home, '.claude.json'),
      JSON.stringify({
        ...existingJson,
        mcpServers: { github: { command: 'gh-mcp' } },
        diffTool: 'terminal',
      }),
    );
    const { questions, resolve } = answer('merge');
    const report = await restorer().restore({ kind: 'global' }, [incoming], resolve);
    expect(questions).toEqual([]);
    expect(report.written).toEqual([]);
  });

  it('never asks: Claude Code running while writing leaves it as it is, and says why (T61)', async () => {
    await writeTestFile(join(home, '.claude.json'), '{}');
    const r = restorer({ running: [true] });
    const report = await r.restore({ kind: 'global' }, [incoming], answer('merge').resolve);
    expect(await read(join(home, '.claude.json'))).toBe('{}');
    expect(report.skipped).toEqual(['.agentnomad/claude.json']);
    expect(report.warnings[0]).toContain('Claude Code or the Claude app was running');
  });

  it('leaves it as it is when the plan chose to skip it, with the same warning (T61)', async () => {
    await writeTestFile(join(home, '.claude.json'), '{}');
    const r = restorer({ running: [false] });
    const report = await r.restore({ kind: 'global' }, [incoming], answer('merge').resolve, {
      leaveClaudeJson: true,
    });
    expect(await read(join(home, '.claude.json'))).toBe('{}');
    expect(report.skipped).toEqual(['.agentnomad/claude.json']);
    expect(report.warnings[0]).toContain('Claude Code or the Claude app was running');
  });

  it('says what restoring would do to it: nothing, create it, or merge (T61)', async () => {
    const r = restorer();
    expect(await r.claudeJsonChange([collected('CLAUDE.md', 'x')])).toBe('none');
    expect(await r.claudeJsonChange([incoming])).toBe('new');
    await writeTestFile(join(home, '.claude.json'), '{}');
    expect(await r.claudeJsonChange([incoming])).toBe('merge');
    await writeTestFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } }, diffTool: 'terminal' }),
    );
    expect(await r.claudeJsonChange([incoming])).toBe('none');
  });

  it('restores only the servers and preferences, never projects or account state (T43)', async () => {
    await writeTestFile(join(home, '.claude.json'), JSON.stringify(existingJson));
    const forged = collected(
      '.agentnomad/claude.json',
      JSON.stringify({
        mcpServers: { github: { command: 'gh-mcp' } },
        projects: {
          '/x': { mcpServers: { evil: { command: 'sh' } }, hasTrustDialogAccepted: true },
        },
        oauthAccount: { emailAddress: 'attacker@example.com' },
      }),
    );
    const report = await restorer().restore({ kind: 'global' }, [forged], answer('merge').resolve);
    const after = await readJson(join(home, '.claude.json'));
    expect(after['projects']).toEqual(existingJson.projects);
    expect(after['oauthAccount']).toEqual(existingJson.oauthAccount);
    expect(after['mcpServers']).toEqual({
      local: { command: 'local-mcp' },
      github: { command: 'gh-mcp' },
    });
    expect(report.warnings).toEqual([
      `Left out of ${join(home, '.claude.json')}: "projects", "oauthAccount" (only MCP servers and preferences are restored there).`,
    ]);
  });

  it('writes nothing when the bundle holds none of the keys it restores', async () => {
    const forged = collected('.agentnomad/claude.json', JSON.stringify({ projects: {} }));
    const report = await restorer().restore({ kind: 'global' }, [forged], answer('merge').resolve);
    await expect(stat(join(home, '.claude.json'))).rejects.toThrow();
    expect(report.written).toEqual([]);
  });

  it('merges into the file as Claude Code left it after closing (T43)', async () => {
    await writeTestFile(join(home, '.claude.json'), JSON.stringify({ diffTool: 'auto' }));
    const r = restorer({
      // Claude Code saved the file as it closed, after the conflict question was answered.
      isClaudeRunning: async () => {
        await writeFile(
          join(home, '.claude.json'),
          JSON.stringify({ diffTool: 'auto', projects: { '/new': {} } }),
        );
        return false;
      },
    });
    const report = await r.restore({ kind: 'global' }, [incoming], answer('merge').resolve);
    expect(await readJson(join(home, '.claude.json'))).toEqual({
      diffTool: 'terminal',
      projects: { '/new': {} },
      mcpServers: { github: { command: 'gh-mcp' } },
    });
    expect(await readJson(report.backups[0] ?? '')).toEqual({
      diffTool: 'auto',
      projects: { '/new': {} },
    });
  });

  it('creates it when missing, readable only by this user', async () => {
    await restorer().restore({ kind: 'global' }, [incoming], answer('skip').resolve);
    expect((await readJson(join(home, '.claude.json')))['diffTool']).toBe('terminal');
    if (posix) expect((await stat(join(home, '.claude.json'))).mode & 0o777).toBe(0o600);
  });

  it('goes into CLAUDE_CONFIG_DIR when that is set', async () => {
    await restorer({ customConfigDir: true }).restore(
      { kind: 'global' },
      [incoming],
      answer('skip').resolve,
    );
    expect((await readJson(join(base, '.claude.json')))['diffTool']).toBe('terminal');
  });
});

describe('restorer: home files', () => {
  it('puts tool settings and hook scripts back in the home folder', async () => {
    const hook = { Stop: [{ hooks: [{ type: 'command', command: '~/scripts/notify.sh' }] }] };
    await restorer().restore(
      { kind: 'global' },
      [
        collected('settings.json', JSON.stringify({ hooks: hook })),
        collected('.agentnomad/home/.config/ccstatusline/settings.json', '{"lines":[]}'),
        collected('.agentnomad/home/scripts/notify.sh', 'echo hi\n', true),
      ],
      answer('skip').resolve,
    );
    expect(await read(join(home, '.config', 'ccstatusline', 'settings.json'))).toBe('{"lines":[]}');
    expect(await read(join(home, 'scripts', 'notify.sh'))).toBe('echo hi\n');
  });

  it('skips a home script no hook runs, e.g. one for the Windows Startup folder (T38)', async () => {
    const startup = 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/update.bat';
    const report = await restorer().restore(
      { kind: 'global' },
      [collected(`.agentnomad/home/${startup}`, 'echo pwned\n')],
      answer('merge').resolve,
    );
    expect(report.written).toEqual([]);
    expect(report.skipped).toEqual([`.agentnomad/home/${startup}`]);
    await expect(read(join(home, ...startup.split('/')))).rejects.toThrow();
  });
});

describe('restorer: one bad entry never stops the rest (T43)', () => {
  it('skips an entry it cannot write, with a warning, and writes the others', async () => {
    await writeTestFile(join(base, 'skills', 'deploy'), 'a file where the bundle has a folder');
    const report = await restorer().restore(
      { kind: 'global' },
      [collected('skills/deploy/SKILL.md', 'x'), collected('skills/review/SKILL.md', 'ok')],
      answer('overwrite').resolve,
    );
    expect(report.skipped).toEqual(['skills/deploy/SKILL.md']);
    expect(report.warnings[0]).toMatch(/^Skipped "skills\/deploy\/SKILL.md": /);
    expect(await read(join(base, 'skills', 'review', 'SKILL.md'))).toBe('ok');
  });

  it('a thrown non-Error still gives a readable warning (T53)', async () => {
    await writeTestFile(join(home, '.claude.json'), '{}');
    const report = await restorer({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
      isClaudeRunning: () => Promise.reject('the process list was empty'),
    }).restore(
      { kind: 'global' },
      [collected('.agentnomad/claude.json', '{"diffTool":"terminal"}')],
      answer('merge').resolve,
    );
    expect(report.warnings).toEqual([
      'Skipped ".agentnomad/claude.json": the process list was empty.',
    ]);
  });

  it('a broken .agentnomad/claude.json is skipped, not fatal', async () => {
    const report = await restorer().restore(
      { kind: 'global' },
      [collected('.agentnomad/claude.json', '{not json'), collected('rules/a.md', 'a')],
      answer('skip').resolve,
    );
    expect(report.skipped).toEqual(['.agentnomad/claude.json']);
    expect(await read(join(base, 'rules', 'a.md'))).toBe('a');
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')(
    'writes only the first of two names this OS sees as one file',
    async () => {
      const report = await restorer().restore(
        { kind: 'global' },
        [collected('rules/Notes.md', 'upper'), collected('rules/notes.md', 'lower')],
        answer('overwrite').resolve,
      );
      expect(report.written).toEqual(['rules/Notes.md']);
      expect(report.skipped).toEqual(['rules/notes.md']);
      expect(report.warnings).toEqual([
        'Skipped "rules/notes.md": on this PC it is the same file as "rules/Notes.md".',
      ]);
    },
  );
});

describe('restorer: a cancelled question stops the restore (T53)', () => {
  class Cancelled extends Error {}

  it('a rejected conflict question rejects restore, and no later file is written', async () => {
    await writeTestFile(join(base, 'rules', 'a.md'), 'mine a');
    await writeTestFile(join(base, 'rules', 'b.md'), 'mine b');
    const questions: string[] = [];
    const restore = restorer().restore(
      { kind: 'global' },
      [
        collected('rules/a.md', 'theirs a'),
        collected('rules/b.md', 'theirs b'),
        collected('rules/c.md', 'c'),
      ],
      (path) => {
        questions.push(path);
        return Promise.reject(new Cancelled('Cancelled'));
      },
    );
    await expect(restore).rejects.toBeInstanceOf(Cancelled);
    expect(questions).toEqual(['rules/a.md']);
    expect((await readdir(join(base, 'rules'))).sort()).toEqual(['a.md', 'b.md']);
    expect(await read(join(base, 'rules', 'a.md'))).toBe('mine a');
  });
});

describe('restorer: auto memory folder chosen by project settings (T43)', () => {
  const memory = collected('.agentnomad/auto-memory/MEMORY.md', 'remember');

  it.each([
    ['~/.config/autostart', 'a folder whose files run by themselves'],
    ['~/.ssh', 'a folder for keys and logins'],
    ['~/.claude', "inside Claude Code's own folder"],
    ['~/', 'your home folder itself'],
  ])('refuses %s', async (dir, reason) => {
    await writeTestFile(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: dir }),
    );
    const report = await restorer().restore(
      { kind: 'project', projectDir: project },
      [memory],
      answer('skip').resolve,
    );
    expect(report.skipped).toContain('.agentnomad/auto-memory/MEMORY.md');
    expect(report.warnings.join('\n')).toContain(reason);
    expect(report.written).not.toContain('.agentnomad/auto-memory/MEMORY.md');
  });

  it('refuses a folder outside the home folder', async () => {
    const outside = join(root, 'elsewhere');
    await writeTestFile(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: outside }),
    );
    const report = await restorer().restore(
      { kind: 'project', projectDir: project },
      [memory],
      answer('skip').resolve,
    );
    expect(report.warnings.join('\n')).toContain('it is outside your home folder');
    await expect(stat(outside)).rejects.toThrow();
  });

  it('uses a folder in the home folder', async () => {
    await writeTestFile(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: '~/notes/my-app' }),
    );
    await restorer().restore(
      { kind: 'project', projectDir: project },
      [memory],
      answer('skip').resolve,
    );
    expect(await read(join(home, 'notes', 'my-app', 'MEMORY.md'))).toBe('remember');
  });
});

describe('restorer: per-OS fixes', () => {
  it('scripts get LF; .bat and .cmd get CRLF on Windows; other files stay as they are', () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    const text = (content: Uint8Array) => new TextDecoder().decode(content);
    expect(text(lineEndingsFor('linux', 'a.sh', bytes('a\r\nb\r\n')))).toBe('a\nb\n');
    expect(text(lineEndingsFor('win32', 'a.sh', bytes('a\r\nb\r\n')))).toBe('a\nb\n');
    expect(text(lineEndingsFor('win32', 'a.cmd', bytes('a\nb\n')))).toBe('a\r\nb\r\n');
    expect(text(lineEndingsFor('linux', 'a.cmd', bytes('a\r\nb\r\n')))).toBe('a\r\nb\r\n');
    expect(text(lineEndingsFor('linux', 'CLAUDE.md', bytes('a\r\nb')))).toBe('a\r\nb');
  });

  it('a script kept with the other line endings is unchanged: pulled twice, no question, no write (T53)', async () => {
    // Git's autocrlf gives a CRLF .py on Windows; an LF .cmd comes from macOS or Linux.
    const py = 'print("a")\r\nprint("b")\r\n';
    const cmd = '@echo off\necho ok\n';
    await writeTestFile(join(base, 'hooks', 'check.py'), py);
    await writeTestFile(join(base, 'hooks', 'run.cmd'), cmd);
    const incoming = [collected('hooks/check.py', py), collected('hooks/run.cmd', cmd)];
    for (const choice of ['merge', 'overwrite'] as const) {
      const { questions, resolve } = answer(choice);
      const report = await restorer().restore({ kind: 'global' }, incoming, resolve);
      expect(questions).toEqual([]);
      expect(report.written).toEqual([]);
      expect(report.backups).toEqual([]);
    }
    expect((await readdir(join(base, 'hooks'))).sort()).toEqual(['check.py', 'run.cmd']);
    expect(await read(join(base, 'hooks', 'check.py'))).toBe(py);
    expect(await read(join(base, 'hooks', 'run.cmd'))).toBe(cmd);
  });

  it('a script pulled onto a fresh PC is unchanged by a second pull (T53)', async () => {
    // Base-folder scripts outside the synced folders come back only when a hook runs them (T55).
    const hooks = [
      { type: 'command', command: 'python ~/.claude/hooks/check.py' },
      { type: 'command', command: '~/.claude/hooks/run.cmd' },
    ];
    const incoming = [
      collected('settings.json', JSON.stringify({ hooks: { Stop: [{ hooks }] } })),
      collected('hooks/check.py', 'print("a")\r\n'),
      collected('hooks/run.cmd', '@echo off\n'),
    ];
    const first = await restorer().restore({ kind: 'global' }, incoming, answer('skip').resolve);
    expect([...first.written].sort()).toEqual(['hooks/check.py', 'hooks/run.cmd', 'settings.json']);
    const { questions, resolve } = answer('merge');
    const second = await restorer().restore({ kind: 'global' }, incoming, resolve);
    expect(questions).toEqual([]);
    expect(second.written).toEqual([]);
    expect((await readdir(join(base, 'hooks'))).sort()).toEqual(['check.py', 'run.cmd']);
  });

  it('sameForRestore: equal before or after the line-ending fix, never otherwise (T53)', () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(sameForRestore('linux', 'a.py', bytes('a\r\n'), bytes('a\r\n'))).toBe(true);
    expect(sameForRestore('linux', 'a.py', bytes('a\n'), bytes('a\r\n'))).toBe(true);
    expect(sameForRestore('win32', 'a.cmd', bytes('a\n'), bytes('a\n'))).toBe(true);
    expect(sameForRestore('win32', 'a.cmd', bytes('a\r\n'), bytes('a\n'))).toBe(true);
    expect(sameForRestore('linux', 'a.cmd', bytes('a\r\n'), bytes('a\n'))).toBe(false);
    expect(sameForRestore('linux', 'a.md', bytes('a\r\n'), bytes('a\n'))).toBe(false);
    expect(sameForRestore('linux', 'a.py', bytes('b\n'), bytes('a\n'))).toBe(false);
  });

  it.runIf(posix)('makes scripts runnable on macOS and Linux, even from a Windows PC', async () => {
    // The hooks run both scripts, so they are restored (T55).
    const hooks = [
      { type: 'command', command: '~/.claude/hooks/a.sh' },
      { type: 'command', command: 'sh ~/.claude/hooks/b.sh' },
    ];
    await restorer().restore(
      { kind: 'global' },
      [
        collected('settings.json', JSON.stringify({ hooks: { Stop: [{ hooks }] } })),
        collected('hooks/a.sh', 'echo a\n', true),
        collected('hooks/b.sh', '#!/bin/sh\necho b\n'),
        collected('CLAUDE.md', 'x'),
      ],
      answer('skip').resolve,
    );
    expect((await stat(join(base, 'hooks', 'a.sh'))).mode & 0o111).not.toBe(0);
    expect((await stat(join(base, 'hooks', 'b.sh'))).mode & 0o111).not.toBe(0);
    expect((await stat(join(base, 'CLAUDE.md'))).mode & 0o111).toBe(0);
  });

  it.runIf(posix)('an overwritten file keeps its own permissions', async () => {
    await writeTestFile(join(base, 'CLAUDE.md'), 'mine');
    await chmod(join(base, 'CLAUDE.md'), 0o600);
    await restorer().restore(
      { kind: 'global' },
      [collected('CLAUDE.md', 'theirs')],
      answer('overwrite').resolve,
    );
    expect((await stat(join(base, 'CLAUDE.md'))).mode & 0o777).toBe(0o600);
  });

  it('warns about hooks from another OS that will likely not run here', async () => {
    const settings = JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'powershell -File C:/hooks/notify.ps1' }] },
          { hooks: [{ type: 'command', command: '~/.claude/hooks/check.sh' }] },
          { hooks: [{ type: 'command', command: 'node ~/tool.js' }] },
        ],
      },
    });
    const otherOs = posix ? 'win32' : 'linux';
    const report = await restorer().restore(
      { kind: 'global' },
      [collected('settings.json', settings)],
      answer('skip').resolve,
      { sourceOs: otherOs },
    );
    const expected = posix ? 'powershell -File C:/hooks/notify.ps1' : '~/.claude/hooks/check.sh';
    expect(report.warnings).toEqual([
      `This hook or status line came from ${otherOs} and will likely not run here: ${expected}`,
    ]);
    // Nothing to warn about from the same OS.
    const same = await restorer().restore(
      { kind: 'global' },
      [collected('settings.json', settings)],
      answer('skip').resolve,
      { sourceOs: process.platform === 'darwin' ? 'darwin' : posix ? 'linux' : 'win32' },
    );
    expect(same.warnings).toEqual([]);
  });

  it('flags commands by what they run', () => {
    const json = (command: string) => JSON.stringify({ statusLine: { type: 'command', command } });
    expect(hooksForOtherOs(json('pwsh ./x.ps1'), 'linux')).toHaveLength(1);
    expect(hooksForOtherOs(json('bash ~/x.sh'), 'win32')).toHaveLength(1);
    expect(hooksForOtherOs(json('ccstatusline'), 'win32')).toEqual([]);
  });

  it('flags a hook in exec form by its args (BUG-01)', () => {
    const hook = (command: string, args: string[]) =>
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command, args }] }] } });
    expect(hooksForOtherOs(hook('pwsh.exe', ['-File', 'C:/hooks/x.ps1']), 'linux')).toEqual([
      'pwsh.exe "-File" "C:/hooks/x.ps1"',
    ]);
    expect(hooksForOtherOs(hook('node', ['~/hooks/x.js']), 'linux')).toEqual([]);
  });
});

describe('restorer: hooks in exec form and compound commands (BUG-01, SEC-01)', () => {
  it('restores the scripts they run', async () => {
    const settings = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'node', args: ['~/.claude/hooks/check.js', '--fast'] },
              { type: 'command', command: 'bash -c "~/tools/stop.sh; true"' },
              { type: 'command', command: '~/tools/notify.sh;' },
            ],
          },
        ],
      },
    });
    const report = await restorer().restore(
      { kind: 'global' },
      [
        collected('settings.json', settings),
        collected('hooks/check.js', 'check'),
        collected('.agentnomad/home/tools/stop.sh', 'stop'),
        collected('.agentnomad/home/tools/notify.sh', 'notify'),
      ],
      answer('skip').resolve,
    );
    expect(report.skipped).toEqual([]);
    expect(await read(join(base, 'hooks', 'check.js'))).toBe('check');
    expect(await read(join(home, 'tools', 'stop.sh'))).toBe('stop');
    expect(await read(join(home, 'tools', 'notify.sh'))).toBe('notify');
  });
});

describe('restorer: project scripts', () => {
  const settings = (command: string) =>
    collected(
      '.claude/settings.json',
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }),
    );

  it('restores a script outside .claude/ only when a project hook runs it', async () => {
    const report = await restorer().restore(
      { kind: 'project', projectDir: project },
      [
        settings('python scripts/check.py && "$CLAUDE_PROJECT_DIR"/tools/lint.sh'),
        collected('scripts/check.py', 'print(1)'),
        collected('tools/lint.sh', 'lint'),
        collected('src/evil.ts', 'SECRET'),
        collected('.claude/hooks/any.sh', 'ok'),
      ],
      answer('skip').resolve,
    );
    expect(report.written).toEqual([
      '.claude/hooks/any.sh',
      '.claude/settings.json',
      'scripts/check.py',
      'tools/lint.sh',
    ]);
    expect(report.skipped).toEqual(['src/evil.ts']);
  });
});

describe('restorer: names Windows cannot write safely (T38)', () => {
  it.each([
    ['skills/a/notes:secret.md', 'a name with ":" cannot be written on Windows'],
    ['skills/CON/SKILL.md', 'a name Windows keeps for devices'],
    ['skills/a/nul.txt', 'a name Windows keeps for devices'],
    ['skills/a/COM1.md', 'a name Windows keeps for devices'],
    ['skills/a/COM¹.md', 'a name Windows keeps for devices'],
    ['skills/lpt³', 'a name Windows keeps for devices'],
    ['.agentnomad/home/SSH~1/run.sh', 'a Windows short name (like PROGRA~1)'],
    ['skills/PROGRA~1/SKILL.md', 'a Windows short name (like PROGRA~1)'],
    ['skills/a/file?.md', 'a name Windows does not allow'],
    ['skills/a/trailing.', 'a name ending in a dot or space on Windows'],
    ['skills/a/space ', 'a name ending in a dot or space on Windows'],
  ])('%s', (path, reason) => {
    expect(windowsNameProblem(path)).toBe(reason);
  });

  it.each(['skills/deploy/SKILL.md', 'skills/a/console.md', 'hooks/check.sh', 'CLAUDE.md'])(
    'allows %s',
    (path) => {
      expect(windowsNameProblem(path)).toBeNull();
    },
  );
});

describe('restorer: what pull asks before writing (T61)', () => {
  it('lists each file here that differs, in order, and ~/.claude.json whenever it is pulled', () => {
    const r = restorer();
    const conflicts = r.conflicts(
      [
        collected('rules/b.md', 'theirs'),
        collected('rules/a.md', 'same'),
        collected('new.md', 'new'),
        collected('.agentnomad/claude.json', '{"diffTool":"terminal"}'),
        // Saved from Windows with CRLF; this PC keeps it with LF: the same script (T53).
        collected('hooks/run.sh', 'echo ok\r\n'),
      ],
      [
        collected('rules/b.md', 'mine'),
        collected('rules/a.md', 'same'),
        collected('hooks/run.sh', 'echo ok\n'),
      ],
    );
    expect(conflicts.map((conflict) => conflict.path)).toEqual([
      '.agentnomad/claude.json',
      'rules/b.md',
    ]);
    expect(conflicts[0]?.question.overwriteAllowed).toBe(false);
    expect(conflicts[1]?.question).toEqual({ overwriteAllowed: true });
  });

  it('reviews runnable entries and knows the variables that redirect Claude Code', () => {
    const r = restorer();
    const settings = collected(
      'settings.json',
      JSON.stringify({ statusLine: { type: 'command', command: 'ccstatusline' } }),
    );
    expect(r.reviewRunnable([settings], []).map((entry) => entry.label)).toEqual(['status line']);
    expect(r.reviewRunnable([settings], [settings])).toEqual([]);
    expect(r.isRedirectVariable('ANTHROPIC_BASE_URL')).toBe(true);
    expect(r.isRedirectVariable('https_proxy')).toBe(true);
    expect(r.isRedirectVariable('GITHUB_TOKEN')).toBe(false);
  });
});

describe('project hook scripts: one rule for push and pull (DUP-03)', () => {
  it('restores a script that a hook names by its absolute path in the project', async () => {
    const source = join(root, 'old', 'my-app');
    const command = `${join(source, 'scripts', 'a.sh')} --fix`;
    await writeTestFile(
      join(source, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }),
    );
    await writeTestFile(join(source, 'scripts', 'a.sh'), 'echo hi');
    const files = await createClaudeCodeProjectCollector({
      baseDir: base,
      homedir: home,
      platform: process.platform,
      env: {},
    }).collect({ kind: 'project', projectDir: source }, { includeMemory: false });
    expect(files.map((entry) => entry.path)).toContain('scripts/a.sh');

    // Pulled into the same folder (a reinstalled PC), the script comes back.
    await rm(join(source, 'scripts'), { recursive: true });
    const report = await restorer().restore(
      { kind: 'project', projectDir: source },
      files,
      answer('overwrite').resolve,
    );
    expect(report.written).toContain('scripts/a.sh');
  });

  it.each([
    ['$CLAUDE_PROJECT_DIR/scripts/a.sh', ['scripts/a.sh']],
    [`bash -c "bash -lc '$CLAUDE_PROJECT_DIR/scripts/a.sh arg; true'"`, ['scripts/a.sh']],
    ['scripts\\a.sh', ['scripts/a.sh']],
    ['~/a.sh', []],
    ['$HOME/a.sh', []],
    ['../outside/a.sh', []],
  ])('reads %s', (word, expected) => {
    const settings = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: word }] }] },
    });
    expect(
      projectHookScripts(settings, { projectDir: project, platform: process.platform }).map(
        (script) => script.bundlePath,
      ),
    ).toEqual(expected);
  });
});

describe('restorer: a path with a line break stays on one warning line (review 6 SEC-02)', () => {
  it('shows the line break as \\u{000a}', async () => {
    const path = 'not-synced\n✔ Restored settings.json';
    const report = await restorer().restore(
      { kind: 'global' },
      [collected(path, 'x')],
      answer('skip').resolve,
    );
    expect(report.skipped).toEqual([path]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(
      /^Refused "not-synced\\u\{000a\}✔ Restored settings\.json": /,
    );
    expect(report.warnings[0]).not.toContain('\n');
  });
});

describe('restorer: hooks for another OS, by what they run (review 6 UX-02)', () => {
  const statusLine = (command: string) =>
    JSON.stringify({ statusLine: { type: 'command', command } });

  it.each([
    ['echo "use bash here"', 'win32'],
    ['git log -1 --format="%s by sh"', 'win32'],
    ['notify "ran cmd"', 'linux'],
  ] as const)('never flags a shell name that is only a word of the text: %s', (command, os) => {
    expect(hooksForOtherOs(statusLine(command), os)).toEqual([]);
  });

  it('shows the command as it is written in the settings', () => {
    expect(hooksForOtherOs(statusLine('bash -c "echo hi"'), 'win32')).toEqual([
      'bash -c "echo hi"',
    ]);
    expect(hooksForOtherOs(statusLine('node "C:/hooks/x.ps1"'), 'linux')).toEqual([
      'node "C:/hooks/x.ps1"',
    ]);
  });
});
