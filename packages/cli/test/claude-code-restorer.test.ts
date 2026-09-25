import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createClaudeCodeGlobalCollector,
  createClaudeCodeProjectCollector,
  createClaudeCodeRestorer,
  createClaudeRunningCheck,
  globalDestination,
  hooksForOtherOs,
  isClaudeProcess,
  lineEndingsFor,
  projectDestination,
  projectDirName,
  type ClaudeRunningAnswer,
  type CollectedFile,
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

async function put(path: string, content: string | Uint8Array = 'x'): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
const read = (path: string) => readFile(path, 'utf8');
const readJson = async (path: string) => JSON.parse(await read(path)) as Record<string, unknown>;
const file = (path: string, content: string, executable = false): CollectedFile => ({
  path,
  content: new TextEncoder().encode(content),
  executable,
});

interface Setup {
  running?: boolean[];
  runningAnswers?: ClaudeRunningAnswer[];
  customConfigDir?: boolean;
}

function restorer(setup: Setup = {}) {
  const running = [...(setup.running ?? [false])];
  const answers = [...(setup.runningAnswers ?? [])];
  const asked: string[] = [];
  return {
    asked,
    restorer: createClaudeCodeRestorer({
      baseDir: base,
      homedir: home,
      platform: process.platform,
      env: {},
      customConfigDir: setup.customConfigDir ?? false,
      now: () => NOW,
      isClaudeRunning: () => Promise.resolve(running.shift() ?? false),
      onClaudeRunning: () => {
        asked.push('close claude?');
        return Promise.resolve(answers.shift() ?? 'skip');
      },
    }),
  };
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
    await put(join(sourceBase, 'settings.json'), '{"theme":"dark"}\n');
    await put(join(sourceBase, 'CLAUDE.md'), '# Rules\r\nWindows line endings stay.\r\n');
    await put(join(sourceBase, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n');
    await put(join(sourceBase, 'skills', 'deploy', 'logo.png'), new Uint8Array([0, 255, 1, 254]));
    const collected = await createClaudeCodeGlobalCollector({
      baseDir: sourceBase,
      homedir: sourceHome,
      platform: process.platform,
      customConfigDir: false,
    }).collect({ kind: 'global' }, { includeMemory: false });

    const report = await restorer().restorer.restore(
      { kind: 'global' },
      collected,
      answer('skip').resolve,
    );
    expect(report.written).toEqual(collected.map((entry) => entry.path));
    for (const entry of collected) {
      expect(new Uint8Array(await readFile(join(base, ...entry.path.split('/'))))).toEqual(
        entry.content,
      );
    }
  });

  it('a collected project setup restores into another folder, memory included', async () => {
    const source = join(root, 'other-pc', 'my-app');
    await put(join(source, 'CLAUDE.md'), 'project rules');
    await put(join(source, '.claude', 'settings.local.json'), '{}');
    const sourceMemory = join(base, 'projects', projectDirName(source), 'memory');
    await put(join(sourceMemory, 'MEMORY.md'), 'remember this');
    const collected = await createClaudeCodeProjectCollector({
      baseDir: base,
      homedir: home,
      platform: process.platform,
      env: {},
    }).collect({ kind: 'project', projectDir: source }, { includeMemory: true });

    await restorer().restorer.restore(
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
    ['.agentnomad/home/.bashrc', 'not a script or known tool settings file'],
    ['.agentnomad/other.json', 'unknown agentnomad entry'],
    ['../outside.md', 'not a safe path'],
  ])('global: %s', (path, reason) => {
    expect(globalDestination(path)).toEqual({ kind: 'refused', reason });
  });

  it.each([
    ['.git/config', 'never synced'],
    ['.claude/agent-memory-local/a/MEMORY.md', 'never synced'],
    ['.claude/worktrees/wt/CLAUDE.md', 'never synced'],
    ['src/index.ts', 'not part of a Claude Code setup'],
    ['.env', 'not part of a Claude Code setup'],
  ])('project: %s', (path, reason) => {
    expect(projectDestination(path)).toEqual({ kind: 'refused', reason });
  });

  it('never writes into skills/synced/, even when a bundle contains it', async () => {
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('skills/synced/evil/SKILL.md', 'x'), file('skills/mine/SKILL.md', 'ok')],
      answer('overwrite').resolve,
    );
    expect(report.skipped).toEqual(['skills/synced/evil/SKILL.md']);
    expect(report.warnings).toEqual(['Refused "skills/synced/evil/SKILL.md": never synced.']);
    await expect(stat(join(base, 'skills', 'synced'))).rejects.toThrow();
    expect(await read(join(base, 'skills', 'mine', 'SKILL.md'))).toBe('ok');
  });

  it('does not write programs.json (pull only reads it)', async () => {
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('.agentnomad/programs.json', '{"programs":[]}')],
      answer('skip').resolve,
    );
    expect(report).toEqual({ written: [], skipped: [], backups: [], warnings: [] });
    expect(await readdir(base)).toEqual([]);
  });
});

describe('restorer: existing files', () => {
  it('leaves an identical file alone without asking', async () => {
    await put(join(base, 'CLAUDE.md'), 'same');
    const { questions, resolve } = answer('overwrite');
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('CLAUDE.md', 'same')],
      resolve,
    );
    expect(questions).toEqual([]);
    expect(report.written).toEqual([]);
  });

  it('asks about a different file, and skip leaves it untouched', async () => {
    await put(join(base, 'CLAUDE.md'), 'mine');
    const { questions, resolve } = answer('skip');
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('CLAUDE.md', 'theirs')],
      resolve,
    );
    expect(questions).toEqual([['CLAUDE.md', { overwriteAllowed: true }]]);
    expect(report.skipped).toEqual(['CLAUDE.md']);
    expect(await read(join(base, 'CLAUDE.md'))).toBe('mine');
  });

  it('overwrite backs the old file up first', async () => {
    await put(join(base, 'CLAUDE.md'), 'mine');
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('CLAUDE.md', 'theirs')],
      answer('overwrite').resolve,
    );
    expect(await read(join(base, 'CLAUDE.md'))).toBe('theirs');
    expect(await read(join(base, `CLAUDE.md.agentnomad-backup-${STAMP}`))).toBe('mine');
    expect(report.backups).toEqual([`CLAUDE.md.agentnomad-backup-${STAMP}`]);
  });

  it('merge combines JSON keys, the pulled values winning', async () => {
    await put(join(base, 'settings.json'), JSON.stringify({ theme: 'light', model: 'opus' }));
    await restorer().restorer.restore(
      { kind: 'global' },
      [file('settings.json', JSON.stringify({ theme: 'dark', effortLevel: 'high' }))],
      answer('merge').resolve,
    );
    expect(JSON.parse(await read(join(base, 'settings.json')))).toEqual({
      theme: 'dark',
      model: 'opus',
      effortLevel: 'high',
    });
  });

  it('merge keeps a different text file and puts the pulled one next to it', async () => {
    await put(join(base, 'CLAUDE.md'), 'mine');
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('CLAUDE.md', 'theirs')],
      answer('merge').resolve,
    );
    expect(await read(join(base, 'CLAUDE.md'))).toBe('mine');
    expect(await read(join(base, `CLAUDE.md.agentnomad-incoming-${STAMP}`))).toBe('theirs');
    expect(report.written).toEqual([`CLAUDE.md.agentnomad-incoming-${STAMP}`]);
  });

  it('leaves no temporary files behind', async () => {
    await restorer().restorer.restore(
      { kind: 'global' },
      [file('rules/a.md', 'a')],
      answer('skip').resolve,
    );
    expect(await readdir(join(base, 'rules'))).toEqual(['a.md']);
  });
});

describe('restorer: ~/.claude.json', () => {
  const incoming = file(
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
    await put(join(home, '.claude.json'), JSON.stringify(existingJson));
    const { questions, resolve } = answer('merge');
    const report = await restorer().restorer.restore({ kind: 'global' }, [incoming], resolve);
    expect(questions).toEqual([['.agentnomad/claude.json', { overwriteAllowed: false }]]);
    expect(JSON.parse(await read(join(home, '.claude.json')))).toEqual({
      ...existingJson,
      mcpServers: { local: { command: 'local-mcp' }, github: { command: 'gh-mcp' } },
      diffTool: 'terminal',
    });
    expect(report.backups).toEqual([join(home, `.claude.json.agentnomad-backup-${STAMP}`)]);
  });

  it('never replaces the file, even when the answer is overwrite', async () => {
    await put(join(home, '.claude.json'), JSON.stringify(existingJson));
    await restorer().restorer.restore({ kind: 'global' }, [incoming], answer('overwrite').resolve);
    expect((await readJson(join(home, '.claude.json')))['oauthAccount']).toEqual(
      existingJson.oauthAccount,
    );
  });

  it('skip leaves it alone', async () => {
    await put(join(home, '.claude.json'), JSON.stringify(existingJson));
    await restorer().restorer.restore({ kind: 'global' }, [incoming], answer('skip').resolve);
    expect(JSON.parse(await read(join(home, '.claude.json')))).toEqual(existingJson);
  });

  it('asks nothing when the keys are already there', async () => {
    await put(
      join(home, '.claude.json'),
      JSON.stringify({
        ...existingJson,
        mcpServers: { github: { command: 'gh-mcp' } },
        diffTool: 'terminal',
      }),
    );
    const { questions, resolve } = answer('merge');
    const report = await restorer().restorer.restore({ kind: 'global' }, [incoming], resolve);
    expect(questions).toEqual([]);
    expect(report.written).toEqual([]);
  });

  it('waits while Claude Code runs: retry after closing it, then writes', async () => {
    await put(join(home, '.claude.json'), '{}');
    const { restorer: r, asked } = restorer({ running: [true, false], runningAnswers: ['retry'] });
    const report = await r.restore({ kind: 'global' }, [incoming], answer('merge').resolve);
    expect(asked).toEqual(['close claude?']);
    expect(report.written).toEqual(['.agentnomad/claude.json']);
  });

  it('skips it while Claude Code runs when the user says so, and says why', async () => {
    await put(join(home, '.claude.json'), '{}');
    const { restorer: r } = restorer({ running: [true], runningAnswers: ['skip'] });
    const report = await r.restore({ kind: 'global' }, [incoming], answer('merge').resolve);
    expect(await read(join(home, '.claude.json'))).toBe('{}');
    expect(report.skipped).toEqual(['.agentnomad/claude.json']);
    expect(report.warnings[0]).toContain('Claude Code was running');
  });

  it('creates it when missing, readable only by this user', async () => {
    await restorer().restorer.restore({ kind: 'global' }, [incoming], answer('skip').resolve);
    expect((await readJson(join(home, '.claude.json')))['diffTool']).toBe('terminal');
    if (posix) expect((await stat(join(home, '.claude.json'))).mode & 0o777).toBe(0o600);
  });

  it('goes into CLAUDE_CONFIG_DIR when that is set', async () => {
    await restorer({ customConfigDir: true }).restorer.restore(
      { kind: 'global' },
      [incoming],
      answer('skip').resolve,
    );
    expect((await readJson(join(base, '.claude.json')))['diffTool']).toBe('terminal');
  });
});

describe('restorer: home files', () => {
  it('puts tool settings and hook scripts back in the home folder', async () => {
    await restorer().restorer.restore(
      { kind: 'global' },
      [
        file('.agentnomad/home/.config/ccstatusline/settings.json', '{"lines":[]}'),
        file('.agentnomad/home/scripts/notify.sh', 'echo hi\n', true),
      ],
      answer('skip').resolve,
    );
    expect(await read(join(home, '.config', 'ccstatusline', 'settings.json'))).toBe('{"lines":[]}');
    expect(await read(join(home, 'scripts', 'notify.sh'))).toBe('echo hi\n');
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

  it.runIf(posix)('makes scripts runnable on macOS and Linux, even from a Windows PC', async () => {
    await restorer().restorer.restore(
      { kind: 'global' },
      [
        file('hooks/a.sh', 'echo a\n', true),
        file('hooks/b.sh', '#!/bin/sh\necho b\n'),
        file('CLAUDE.md', 'x'),
      ],
      answer('skip').resolve,
    );
    expect((await stat(join(base, 'hooks', 'a.sh'))).mode & 0o111).not.toBe(0);
    expect((await stat(join(base, 'hooks', 'b.sh'))).mode & 0o111).not.toBe(0);
    expect((await stat(join(base, 'CLAUDE.md'))).mode & 0o111).toBe(0);
  });

  it.runIf(posix)('an overwritten file keeps its own permissions', async () => {
    await put(join(base, 'CLAUDE.md'), 'mine');
    await chmod(join(base, 'CLAUDE.md'), 0o600);
    await restorer().restorer.restore(
      { kind: 'global' },
      [file('CLAUDE.md', 'theirs')],
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
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('settings.json', settings)],
      answer('skip').resolve,
      { sourceOs: otherOs },
    );
    const expected = posix ? 'powershell -File C:/hooks/notify.ps1' : '~/.claude/hooks/check.sh';
    expect(report.warnings).toEqual([
      `This hook or status line came from ${otherOs} and will likely not run here: ${expected}`,
    ]);
    // Nothing to warn about from the same OS.
    const same = await restorer().restorer.restore(
      { kind: 'global' },
      [file('settings.json', settings)],
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
});

describe('running Claude Code', () => {
  it.each([
    ['claude.exe', true],
    ['/usr/local/bin/claude --resume', true],
    ['/Users/a/.local/bin/claude', true],
    ['node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', true],
    ['"C:\\Users\\a\\.local\\bin\\claude.exe" --continue', true],
    ['agentnomad pull', false],
    ['claude-helper', false],
    ['/usr/bin/vim claude.md', false],
  ])('%j is Claude Code: %s', (line, expected) => {
    expect(isClaudeProcess(line)).toBe(expected);
  });

  it('is detected from the process list, and a list that cannot be read never blocks', async () => {
    expect(
      await createClaudeRunningCheck(() => Promise.resolve(['explorer.exe', 'claude.exe']))(),
    ).toBe(true);
    expect(await createClaudeRunningCheck(() => Promise.resolve(['explorer.exe']))()).toBe(false);
    expect(await createClaudeRunningCheck(() => Promise.resolve(null))()).toBe(false);
  });
});

describe('restorer: project scripts', () => {
  const settings = (command: string) =>
    file(
      '.claude/settings.json',
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }),
    );

  it('restores a script outside .claude/ only when a project hook runs it', async () => {
    const report = await restorer().restorer.restore(
      { kind: 'project', projectDir: project },
      [
        settings('python scripts/check.py && "$CLAUDE_PROJECT_DIR"/tools/lint.sh'),
        file('scripts/check.py', 'print(1)'),
        file('tools/lint.sh', 'lint'),
        file('src/evil.ts', 'SECRET'),
        file('.claude/hooks/any.sh', 'ok'),
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
