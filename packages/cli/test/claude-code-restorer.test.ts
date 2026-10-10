import { chmod, lstat, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  base,
  collect,
  globalCollector,
  home,
  memoryDir,
  project,
  root,
  setMemoryDirectory,
  stopHook,
  useProjectFolders,
} from './claude-code-project-fixtures.ts';
import { collected, readJson, readText, writeTestFile } from './fakes.ts';
import {
  CLAUDE_JSON_BUNDLE_PATH,
  createClaudeCodeRestorer,
  LOCAL_MARKETPLACES_PREFIX,
  hooksForOtherOs,
  lineEndingsFor,
  sameForRestore,
  type ClaudeCodeRestorer,
  type CollectedFile,
  type ConflictChoice,
  type ConflictQuestion,
} from '../src/index.ts';

const posix = process.platform !== 'win32';
const NOW = new Date('2026-09-25T12:00:00.000Z');
const STAMP = '20260925T120000Z';

useProjectFolders('agentnomad-restore-');

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

/** Restores `files` into the global setup, answering every conflict question `choice`. */
function restoreGlobal(
  files: readonly CollectedFile[],
  choice: ConflictChoice,
  context?: Parameters<ClaudeCodeRestorer['restore']>[3],
) {
  return restorer().restore({ kind: 'global' }, files, answer(choice).resolve, context);
}

/** Restores `files` into the test's project, answering every conflict question `choice`. */
function restoreProject(
  files: readonly CollectedFile[],
  choice: ConflictChoice,
  context?: Parameters<ClaudeCodeRestorer['restore']>[3],
) {
  return restorer().restore(
    { kind: 'project', projectDir: project },
    files,
    answer(choice).resolve,
    context,
  );
}

/** Settings with a status line that runs `command`. */
const statusLine = (command: string) =>
  JSON.stringify({ statusLine: { type: 'command', command } });

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
    const collected = await globalCollector({
      baseDir: sourceBase,
      homedir: sourceHome,
    }).collect({ kind: 'global' }, { includeMemory: false });

    const report = await restoreGlobal(collected, 'skip');
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
    const sourceMemory = memoryDir(source);
    await writeTestFile(join(sourceMemory, 'MEMORY.md'), 'remember this');
    const collected = await collect(true, {}, source);

    await restoreProject(collected, 'skip');
    expect(await readText(join(project, 'CLAUDE.md'))).toBe('project rules');
    // Memory lands in this folder's own memory directory.
    expect(await readText(join(memoryDir(), 'MEMORY.md'))).toBe('remember this');
  });
});

describe('restorer: refuses what a collector never produces', () => {
  it('restores no script outside the synced folders unless a hook in the bundle runs it', async () => {
    const settings = JSON.stringify(stopHook('~/.claude/hooks/check.sh'));
    const report = await restoreGlobal(
      [
        collected('settings.json', settings),
        collected('hooks/check.sh', 'echo ok'),
        collected('chrome/chrome-native-host.bat', 'evil'),
        collected('local/node_modules/@anthropic-ai/claude-code/cli.js', 'evil'),
        collected('anything/else/run.ps1', 'evil'),
      ],
      'overwrite',
    );
    expect([...report.written].sort()).toEqual(['hooks/check.sh', 'settings.json']);
    expect([...report.skipped].sort()).toEqual([
      'anything/else/run.ps1',
      'chrome/chrome-native-host.bat',
      'local/node_modules/@anthropic-ai/claude-code/cli.js',
    ]);
    expect(await readText(join(base, 'hooks', 'check.sh'))).toBe('echo ok');
    await expect(stat(join(base, 'chrome'))).rejects.toThrow();
    await expect(stat(join(base, 'local'))).rejects.toThrow();
    await expect(stat(join(base, 'anything'))).rejects.toThrow();
  });

  it('never writes into skills/synced/, even when a bundle contains it', async () => {
    const report = await restoreGlobal(
      [collected('skills/synced/evil/SKILL.md', 'x'), collected('skills/mine/SKILL.md', 'ok')],
      'overwrite',
    );
    expect(report.skipped).toEqual(['skills/synced/evil/SKILL.md']);
    expect(report.warnings).toEqual(['Refused "skills/synced/evil/SKILL.md": never synced.']);
    await expect(stat(join(base, 'skills', 'synced'))).rejects.toThrow();
    expect(await readText(join(base, 'skills', 'mine', 'SKILL.md'))).toBe('ok');
  });

  it('does not write programs.json (pull only reads it)', async () => {
    const report = await restoreGlobal(
      [collected('.agentnomad/programs.json', '{"programs":[]}')],
      'skip',
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
    expect(await readText(join(base, 'CLAUDE.md'))).toBe('mine');
  });

  it('overwrite backs the old file up first', async () => {
    await writeTestFile(join(base, 'CLAUDE.md'), 'mine');
    const report = await restoreGlobal([collected('CLAUDE.md', 'theirs')], 'overwrite');
    expect(await readText(join(base, 'CLAUDE.md'))).toBe('theirs');
    expect(await readText(join(base, `CLAUDE.md.agentnomad-backup-${STAMP}`))).toBe('mine');
    expect(report.backups).toEqual([`CLAUDE.md.agentnomad-backup-${STAMP}`]);
  });

  it('never replaces an earlier backup made in the same second (T45)', async () => {
    await writeTestFile(join(base, 'CLAUDE.md'), 'first');
    await writeTestFile(join(base, `CLAUDE.md.agentnomad-backup-${STAMP}`), 'older backup');
    const report = await restoreGlobal([collected('CLAUDE.md', 'second')], 'overwrite');
    expect(report.backups).toEqual([`CLAUDE.md.agentnomad-backup-${STAMP}-2`]);
    expect(await readText(join(base, `CLAUDE.md.agentnomad-backup-${STAMP}`))).toBe('older backup');
    expect(await readText(join(base, `CLAUDE.md.agentnomad-backup-${STAMP}-2`))).toBe('first');
  });

  it('merge combines JSON keys, the pulled values winning', async () => {
    await writeTestFile(
      join(base, 'settings.json'),
      JSON.stringify({ theme: 'light', model: 'opus' }),
    );
    await restoreGlobal(
      [collected('settings.json', JSON.stringify({ theme: 'dark', effortLevel: 'high' }))],
      'merge',
    );
    expect(await readJson(join(base, 'settings.json'))).toEqual({
      theme: 'dark',
      model: 'opus',
      effortLevel: 'high',
    });
  });

  it('merge keeps a different text file and puts the pulled one next to it', async () => {
    await writeTestFile(join(base, 'CLAUDE.md'), 'mine');
    const report = await restoreGlobal([collected('CLAUDE.md', 'theirs')], 'merge');
    expect(await readText(join(base, 'CLAUDE.md'))).toBe('mine');
    expect(await readText(join(base, `CLAUDE.md.agentnomad-incoming-${STAMP}`))).toBe('theirs');
    expect(report.written).toEqual([`CLAUDE.md.agentnomad-incoming-${STAMP}`]);
  });

  it.runIf(posix)('writes through a linked file, keeping the link (T53)', async () => {
    const real = join(root, 'dotfiles', 'CLAUDE.md');
    await writeTestFile(real, 'mine');
    await symlink(real, join(base, 'CLAUDE.md'));
    const report = await restoreGlobal([collected('CLAUDE.md', 'theirs')], 'overwrite');
    expect((await lstat(join(base, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
    expect(await readText(real)).toBe('theirs');
    expect(await readText(join(base, `CLAUDE.md.agentnomad-backup-${STAMP}`))).toBe('mine');
    expect(report.written).toEqual(['CLAUDE.md']);
    expect(await readdir(join(root, 'dotfiles'))).toEqual(['CLAUDE.md']);
  });

  it.runIf(posix)('merges through a linked ~/.claude.json, keeping the link (T53)', async () => {
    const real = join(root, 'dotfiles', 'claude.json');
    await writeTestFile(real, '{"diffTool":"auto"}');
    await symlink(real, join(home, '.claude.json'));
    await restoreGlobal([collected(CLAUDE_JSON_BUNDLE_PATH, '{"diffTool":"terminal"}')], 'merge');
    expect((await lstat(join(home, '.claude.json'))).isSymbolicLink()).toBe(true);
    expect(await readJson(real)).toEqual({ diffTool: 'terminal' });
  });

  it('leaves no temporary files behind', async () => {
    await restoreGlobal([collected('rules/a.md', 'a')], 'skip');
    expect(await readdir(join(base, 'rules'))).toEqual(['a.md']);
  });
});

describe('restorer: ~/.claude.json', () => {
  const incoming = collected(
    CLAUDE_JSON_BUNDLE_PATH,
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
    expect(await readJson(join(home, '.claude.json'))).toEqual({
      ...existingJson,
      mcpServers: { local: { command: 'local-mcp' }, github: { command: 'gh-mcp' } },
      diffTool: 'terminal',
    });
    expect(report.backups).toEqual([join(home, `.claude.json.agentnomad-backup-${STAMP}`)]);
  });

  it('never replaces the file, even when the answer is overwrite', async () => {
    await writeTestFile(join(home, '.claude.json'), JSON.stringify(existingJson));
    await restoreGlobal([incoming], 'overwrite');
    expect((await readJson(join(home, '.claude.json')))['oauthAccount']).toEqual(
      existingJson.oauthAccount,
    );
  });

  it('skip leaves it alone', async () => {
    await writeTestFile(join(home, '.claude.json'), JSON.stringify(existingJson));
    await restoreGlobal([incoming], 'skip');
    expect(await readJson(join(home, '.claude.json'))).toEqual(existingJson);
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
    expect(await readText(join(home, '.claude.json'))).toBe('{}');
    expect(report.skipped).toEqual(['.agentnomad/claude.json']);
    expect(report.warnings[0]).toContain('Claude Code or the Claude app was running');
  });

  it('leaves it as it is when the plan chose to skip it, with the same warning (T61)', async () => {
    await writeTestFile(join(home, '.claude.json'), '{}');
    const r = restorer({ running: [false] });
    const report = await r.restore({ kind: 'global' }, [incoming], answer('merge').resolve, {
      leaveClaudeJson: true,
    });
    expect(await readText(join(home, '.claude.json'))).toBe('{}');
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
      CLAUDE_JSON_BUNDLE_PATH,
      JSON.stringify({
        mcpServers: { github: { command: 'gh-mcp' } },
        projects: {
          '/x': { mcpServers: { evil: { command: 'sh' } }, hasTrustDialogAccepted: true },
        },
        oauthAccount: { emailAddress: 'attacker@example.com' },
      }),
    );
    const report = await restoreGlobal([forged], 'merge');
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
    const forged = collected(CLAUDE_JSON_BUNDLE_PATH, JSON.stringify({ projects: {} }));
    const report = await restoreGlobal([forged], 'merge');
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
    await restoreGlobal([incoming], 'skip');
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
    await restoreGlobal(
      [
        collected('settings.json', JSON.stringify(stopHook('~/scripts/notify.sh'))),
        collected('.agentnomad/home/.config/ccstatusline/settings.json', '{"lines":[]}'),
        collected('.agentnomad/home/scripts/notify.sh', 'echo hi\n', true),
      ],
      'skip',
    );
    expect(await readText(join(home, '.config', 'ccstatusline', 'settings.json'))).toBe(
      '{"lines":[]}',
    );
    expect(await readText(join(home, 'scripts', 'notify.sh'))).toBe('echo hi\n');
  });

  it('skips a home script no hook runs, e.g. one for the Windows Startup folder (T38)', async () => {
    const startup = 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/update.bat';
    const report = await restoreGlobal(
      [collected(`.agentnomad/home/${startup}`, 'echo pwned\n')],
      'merge',
    );
    expect(report.written).toEqual([]);
    expect(report.skipped).toEqual([`.agentnomad/home/${startup}`]);
    await expect(readText(join(home, ...startup.split('/')))).rejects.toThrow();
  });
});

describe('restorer: one bad entry never stops the rest (T43)', () => {
  it('skips an entry it cannot write, with a warning, and writes the others', async () => {
    await writeTestFile(join(base, 'skills', 'deploy'), 'a file where the bundle has a folder');
    const report = await restoreGlobal(
      [collected('skills/deploy/SKILL.md', 'x'), collected('skills/review/SKILL.md', 'ok')],
      'overwrite',
    );
    expect(report.skipped).toEqual(['skills/deploy/SKILL.md']);
    expect(report.warnings[0]).toMatch(/^Skipped "skills\/deploy\/SKILL.md": /);
    expect(await readText(join(base, 'skills', 'review', 'SKILL.md'))).toBe('ok');
  });

  it('a thrown non-Error still gives a readable warning (T53)', async () => {
    await writeTestFile(join(home, '.claude.json'), '{}');
    const report = await restorer({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
      isClaudeRunning: () => Promise.reject('the process list was empty'),
    }).restore(
      { kind: 'global' },
      [collected(CLAUDE_JSON_BUNDLE_PATH, '{"diffTool":"terminal"}')],
      answer('merge').resolve,
    );
    expect(report.warnings).toEqual([
      'Skipped ".agentnomad/claude.json": the process list was empty.',
    ]);
  });

  it('a broken .agentnomad/claude.json is skipped, not fatal', async () => {
    const report = await restoreGlobal(
      [collected(CLAUDE_JSON_BUNDLE_PATH, '{not json'), collected('rules/a.md', 'a')],
      'skip',
    );
    expect(report.skipped).toEqual(['.agentnomad/claude.json']);
    expect(await readText(join(base, 'rules', 'a.md'))).toBe('a');
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')(
    'writes only the first of two names this OS sees as one file',
    async () => {
      const report = await restoreGlobal(
        [collected('rules/Notes.md', 'upper'), collected('rules/notes.md', 'lower')],
        'overwrite',
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
    expect(await readText(join(base, 'rules', 'a.md'))).toBe('mine a');
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
    await setMemoryDirectory(join(project, '.claude', 'settings.json'), dir);
    const report = await restoreProject([memory], 'skip');
    expect(report.skipped).toContain('.agentnomad/auto-memory/MEMORY.md');
    expect(report.warnings.join('\n')).toContain(reason);
    expect(report.written).not.toContain('.agentnomad/auto-memory/MEMORY.md');
  });

  it('refuses a folder outside the home folder', async () => {
    const outside = join(root, 'elsewhere');
    await setMemoryDirectory(join(project, '.claude', 'settings.json'), outside);
    const report = await restoreProject([memory], 'skip');
    expect(report.warnings.join('\n')).toContain('it is outside your home folder');
    await expect(stat(outside)).rejects.toThrow();
  });

  it('uses a folder in the home folder', async () => {
    await setMemoryDirectory(join(project, '.claude', 'settings.json'), '~/notes/my-app');
    await restoreProject([memory], 'skip');
    expect(await readText(join(home, 'notes', 'my-app', 'MEMORY.md'))).toBe('remember');
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
    expect(await readText(join(base, 'hooks', 'check.py'))).toBe(py);
    expect(await readText(join(base, 'hooks', 'run.cmd'))).toBe(cmd);
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
    const first = await restoreGlobal(incoming, 'skip');
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
    await restoreGlobal(
      [
        collected('settings.json', JSON.stringify({ hooks: { Stop: [{ hooks }] } })),
        collected('hooks/a.sh', 'echo a\n', true),
        collected('hooks/b.sh', '#!/bin/sh\necho b\n'),
        collected('CLAUDE.md', 'x'),
      ],
      'skip',
    );
    expect((await stat(join(base, 'hooks', 'a.sh'))).mode & 0o111).not.toBe(0);
    expect((await stat(join(base, 'hooks', 'b.sh'))).mode & 0o111).not.toBe(0);
    expect((await stat(join(base, 'CLAUDE.md'))).mode & 0o111).toBe(0);
  });

  it.runIf(posix)('an overwritten file keeps its own permissions', async () => {
    await writeTestFile(join(base, 'CLAUDE.md'), 'mine');
    await chmod(join(base, 'CLAUDE.md'), 0o600);
    await restoreGlobal([collected('CLAUDE.md', 'theirs')], 'overwrite');
    expect((await stat(join(base, 'CLAUDE.md'))).mode & 0o777).toBe(0o600);
  });

  /** Hooks for Windows, for macOS and Linux, and for any OS. */
  const mixedHooks = JSON.stringify({
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'powershell -File C:/hooks/notify.ps1' }] },
        { hooks: [{ type: 'command', command: '~/.claude/hooks/check.sh' }] },
        { hooks: [{ type: 'command', command: 'node ~/tool.js' }] },
      ],
    },
  });
  const otherOs = posix ? 'win32' : 'linux';
  /** The hook of `mixedHooks` that will likely not run on this OS. */
  const foreignHook = posix ? 'powershell -File C:/hooks/notify.ps1' : '~/.claude/hooks/check.sh';

  it('warns about hooks from another OS that will likely not run here', async () => {
    const report = await restoreGlobal([collected('settings.json', mixedHooks)], 'skip', {
      sourceOs: otherOs,
    });
    expect(report.warnings).toEqual([
      `This hook or status line came from ${otherOs} and will likely not run here: ${foreignHook}`,
    ]);
  });

  it('warns about project hooks from another OS too', async () => {
    const report = await restoreProject([collected('.claude/settings.json', mixedHooks)], 'skip', {
      sourceOs: otherOs,
    });
    expect(report.warnings).toEqual([
      `This hook or status line came from ${otherOs} and will likely not run here: ${foreignHook}`,
    ]);
  });

  it('gives no other-OS warning for hooks from this OS', async () => {
    const report = await restoreGlobal([collected('settings.json', mixedHooks)], 'skip', {
      sourceOs: process.platform === 'darwin' ? 'darwin' : posix ? 'linux' : 'win32',
    });
    expect(report.warnings).toEqual([]);
  });

  it('shows a hook command with a line break on one warning line (SEC-01)', async () => {
    const command = posix
      ? 'powershell -File C:/hooks/notify.ps1\nagentnomad: restore complete'
      : '~/.claude/hooks/check.sh\nagentnomad: restore complete';
    const settings = JSON.stringify(stopHook(command));
    const otherOs = posix ? 'win32' : 'linux';
    const report = await restoreGlobal([collected('settings.json', settings)], 'skip', {
      sourceOs: otherOs,
    });
    expect(report.warnings).toEqual([
      `This hook or status line came from ${otherOs} and will likely not run here: ${command.replace('\n', '\\u{000a}')}`,
    ]);
    expect(report.warnings.join('\n').split('\n')).toHaveLength(1);
  });

  it('flags commands by what they run', () => {
    expect(hooksForOtherOs(statusLine('pwsh ./x.ps1'), 'linux')).toHaveLength(1);
    expect(hooksForOtherOs(statusLine('bash ~/x.sh'), 'win32')).toHaveLength(1);
    expect(hooksForOtherOs(statusLine('ccstatusline'), 'win32')).toEqual([]);
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
    const report = await restoreGlobal(
      [
        collected('settings.json', settings),
        collected('hooks/check.js', 'check'),
        collected('.agentnomad/home/tools/stop.sh', 'stop'),
        collected('.agentnomad/home/tools/notify.sh', 'notify'),
      ],
      'skip',
    );
    expect(report.skipped).toEqual([]);
    expect(await readText(join(base, 'hooks', 'check.js'))).toBe('check');
    expect(await readText(join(home, 'tools', 'stop.sh'))).toBe('stop');
    expect(await readText(join(home, 'tools', 'notify.sh'))).toBe('notify');
  });
});

describe('restorer: project scripts', () => {
  const settings = (command: string) =>
    collected('.claude/settings.json', JSON.stringify(stopHook(command)));

  it('restores a script outside .claude/ only when a project hook runs it', async () => {
    const report = await restoreProject(
      [
        settings('python scripts/check.py && "$CLAUDE_PROJECT_DIR"/tools/lint.sh'),
        collected('scripts/check.py', 'print(1)'),
        collected('tools/lint.sh', 'lint'),
        collected('src/evil.ts', 'SECRET'),
        collected('.claude/hooks/any.sh', 'ok'),
      ],
      'skip',
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

describe('restorer: a folder of its own, e.g. a local marketplace (T98)', () => {
  const folder = () => join(home, 'markets', 'tools');

  it('writes the files into the folder, paths from it', async () => {
    const report = await restorer().restoreFolder(
      folder(),
      [collected('plugins/a/README.md', 'a')],
      answer('skip').resolve,
    );
    expect(report.written).toEqual(['plugins/a/README.md']);
    expect(await readText(join(folder(), 'plugins', 'a', 'README.md'))).toBe('a');
  });

  it('never writes into a .git folder, and says so', async () => {
    const report = await restorer().restoreFolder(
      folder(),
      [collected('.git/hooks/pre-commit', 'x'), collected('README.md', 'ok')],
      answer('overwrite').resolve,
    );
    expect(report.skipped).toEqual(['.git/hooks/pre-commit']);
    expect(report.warnings).toEqual([
      'Refused ".git/hooks/pre-commit": git keeps its own files.',
    ]);
    await expect(stat(join(folder(), '.git'))).rejects.toThrow();
  });

  it('refuses a path that leaves the folder', async () => {
    const report = await restorer().restoreFolder(
      folder(),
      [collected('../outside.md', 'x')],
      answer('overwrite').resolve,
    );
    expect(report.warnings).toEqual(['Refused "../outside.md": not a safe path.']);
    await expect(stat(join(home, 'markets', 'outside.md'))).rejects.toThrow();
  });

  it('asks about a file there that differs, and overwrite keeps a backup', async () => {
    await writeTestFile(join(folder(), 'README.md'), 'mine');
    const { questions, resolve } = answer('overwrite');
    const report = await restorer().restoreFolder(
      folder(),
      [collected('README.md', 'theirs')],
      resolve,
    );
    expect(questions).toEqual([['README.md', { overwriteAllowed: true }]]);
    expect(report.backups).toEqual([`README.md.agentnomad-backup-${STAMP}`]);
    expect(await readText(join(folder(), 'README.md'))).toBe('theirs');
  });
});

describe('restorer: what pull asks before writing (T61)', () => {
  it('lists each file here that differs, in order, and ~/.claude.json whenever it is pulled', () => {
    const r = restorer();
    const conflicts = r.conflicts(
      [
        collected('rules/b.md', 'theirs'),
        collected('rules/a.md', 'same'),
        collected('new.md', 'new'),
        collected(CLAUDE_JSON_BUNDLE_PATH, '{"diffTool":"terminal"}'),
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

  it('never asks about a saved local marketplace, which pull writes elsewhere (T98)', () => {
    const saved = `${LOCAL_MARKETPLACES_PREFIX}tools.json`;
    expect(restorer().conflicts([collected(saved, 'theirs')], [collected(saved, 'mine')])).toEqual(
      [],
    );
  });

  it('reviews runnable entries that are new here', () => {
    const r = restorer();
    const settings = collected('settings.json', statusLine('ccstatusline'));
    expect(r.reviewRunnable([settings], []).map((entry) => entry.label)).toEqual(['status line']);
    expect(r.reviewRunnable([settings], [settings])).toEqual([]);
  });

  it('knows the variables that redirect Claude Code', () => {
    const r = restorer();
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
      JSON.stringify(stopHook(command)),
    );
    await writeTestFile(join(source, 'scripts', 'a.sh'), 'echo hi');
    const files = await collect(false, {}, source);
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
});

describe('restorer: a path with a line break stays on one warning line (review 6 SEC-02)', () => {
  it('shows the line break as \\u{000a}', async () => {
    const path = 'not-synced\n✔ Restored settings.json';
    const report = await restoreGlobal([collected(path, 'x')], 'skip');
    expect(report.skipped).toEqual([path]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(
      /^Refused "not-synced\\u\{000a\}✔ Restored settings\.json": /,
    );
    expect(report.warnings[0]).not.toContain('\n');
  });

  it('keeps the error of a failed entry on one line too', async () => {
    // A file error quotes the path as it is (ENOENT … open '…a\nb').
    await writeTestFile(join(home, '.claude.json'), '{}');
    const report = await restorer({
      isClaudeRunning: () => Promise.reject(new Error("open 'a\n✔ Restored settings.json'")),
    }).restore(
      { kind: 'global' },
      [collected(CLAUDE_JSON_BUNDLE_PATH, '{"diffTool":"terminal"}')],
      answer('merge').resolve,
    );
    expect(report.warnings).toEqual([
      'Skipped ".agentnomad/claude.json": open \'a\\u{000a}✔ Restored settings.json\'.',
    ]);
  });

  it.runIf(posix)('keeps a real write error on one line', async () => {
    // A file where the entry needs a folder: the write fails and its error quotes the path.
    await writeTestFile(join(base, 'skills', 'deploy'), 'a file, not a folder');
    const report = await restoreGlobal([collected('skills/deploy/a\nb.md', 'x')], 'skip');
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(/^Skipped "skills\/deploy\/a\\u\{000a\}b\.md": /);
    expect(report.warnings[0]).not.toContain('\n');
  });
});

describe('restorer: hooks for another OS, by what they run (review 6 UX-02)', () => {
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
