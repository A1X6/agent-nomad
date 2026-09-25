import { copyFile, link, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claudeConfigDir,
  createClaudeCodeDetector,
  findClaudeExecutable,
  nodeDetectorSystem,
  parseVersion,
  type DetectorSystem,
} from '../src/index.ts';

interface FakePc {
  platform: NodeJS.Platform;
  homedir: string;
  env?: Record<string, string>;
  folders?: string[];
  executables?: string[];
  files?: Record<string, string>;
  /** stdout of `<file> --version`; missing = the command fails. */
  versions?: Record<string, string>;
}

function fakeSystem(pc: FakePc) {
  const ran: string[] = [];
  const system: DetectorSystem = {
    platform: pc.platform,
    homedir: pc.homedir,
    env: pc.env ?? {},
    isDirectory: (path) => Promise.resolve((pc.folders ?? []).includes(path)),
    isExecutable: (path) => Promise.resolve((pc.executables ?? []).includes(path)),
    readText: (path) => Promise.resolve(pc.files?.[path] ?? null),
    runVersion: (file) => {
      ran.push(file);
      return Promise.resolve(pc.versions?.[file] ?? null);
    },
  };
  return { system, ran };
}

const detect = (pc: FakePc) => createClaudeCodeDetector(fakeSystem(pc).system).detect();

describe('Claude Code on Windows', () => {
  const home = 'C:\\Users\\ahmed';
  const native = 'C:\\Users\\ahmed\\.local\\bin\\claude.exe';

  it('finds the native install, its folder and its version', async () => {
    expect(
      await detect({
        platform: 'win32',
        homedir: home,
        env: { Path: 'C:\\Windows;C:\\Users\\ahmed\\.local\\bin', PATHEXT: '.COM;.EXE;.CMD' },
        folders: ['C:\\Users\\ahmed\\.claude'],
        executables: [native],
        versions: { [native]: '2.1.282 (Claude Code)\n' },
      }),
    ).toEqual({ installed: true, baseDir: 'C:\\Users\\ahmed\\.claude', version: '2.1.282' });
  });

  it('reads an npm install version from its package instead of running the .cmd shim', async () => {
    const shim = 'C:\\Users\\ahmed\\AppData\\Roaming\\npm\\claude.cmd';
    const { system, ran } = fakeSystem({
      platform: 'win32',
      homedir: home,
      env: { PATH: 'C:\\Users\\ahmed\\AppData\\Roaming\\npm' },
      executables: [shim],
      files: {
        'C:\\Users\\ahmed\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\package.json':
          JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.39' }),
      },
    });
    const found = await createClaudeCodeDetector(system).detect();
    expect(found.version).toBe('2.1.39');
    expect(ran).toEqual([]);
  });

  it('follows PATHEXT order and PATH order, like the shell', async () => {
    const { system } = fakeSystem({
      platform: 'win32',
      homedir: home,
      env: { PATH: 'D:\\first;D:\\second', PATHEXT: '.EXE;.CMD' },
      executables: ['D:\\first\\claude.cmd', 'D:\\second\\claude.exe', 'D:\\first\\claude.exe'],
    });
    expect(await findClaudeExecutable(system)).toBe('D:\\first\\claude.exe');
  });

  it('checks ~/.local/bin even when PATH misses it', async () => {
    const { system } = fakeSystem({
      platform: 'win32',
      homedir: home,
      env: { PATH: 'C:\\Windows' },
      executables: [native],
    });
    expect(await findClaudeExecutable(system)).toBe(native);
  });
});

describe('Claude Code on macOS and Linux', () => {
  it('finds `claude` on PATH', async () => {
    expect(
      await detect({
        platform: 'darwin',
        homedir: '/Users/ahmed',
        env: { PATH: '/usr/bin:/opt/homebrew/bin' },
        folders: ['/Users/ahmed/.claude'],
        executables: ['/opt/homebrew/bin/claude'],
        versions: { '/opt/homebrew/bin/claude': '2.1.39 (Claude Code)' },
      }),
    ).toEqual({ installed: true, baseDir: '/Users/ahmed/.claude', version: '2.1.39' });
  });

  it('ignores relative PATH entries', async () => {
    const { system } = fakeSystem({
      platform: 'linux',
      homedir: '/home/ahmed',
      env: { PATH: 'bin:.:/usr/bin' },
      executables: ['bin/claude', './claude'],
    });
    expect(await findClaudeExecutable(system)).toBeNull();
  });

  it('uses CLAUDE_CONFIG_DIR instead of ~/.claude', async () => {
    const found = await detect({
      platform: 'linux',
      homedir: '/home/ahmed',
      env: { CLAUDE_CONFIG_DIR: '/srv/claude-work' },
      folders: ['/home/ahmed/.claude', '/srv/claude-work'],
    });
    expect(found.baseDir).toBe('/srv/claude-work');
  });
});

describe('what counts as installed', () => {
  it('only the config folder: installed, version unknown', async () => {
    expect(
      await detect({ platform: 'linux', homedir: '/home/a', folders: ['/home/a/.claude'] }),
    ).toEqual({ installed: true, baseDir: '/home/a/.claude', version: null });
  });

  it('only the command: installed, folder where Claude Code will create it', async () => {
    const found = await detect({
      platform: 'linux',
      homedir: '/home/a',
      env: { PATH: '/usr/local/bin' },
      executables: ['/usr/local/bin/claude'],
      versions: { '/usr/local/bin/claude': '2.2.0' },
    });
    expect(found).toEqual({ installed: true, baseDir: '/home/a/.claude', version: '2.2.0' });
  });

  it('neither: not installed', async () => {
    expect(await detect({ platform: 'linux', homedir: '/home/a' })).toEqual({
      installed: false,
      baseDir: null,
      version: null,
    });
  });

  it('a command that fails or hangs: installed, version unknown', async () => {
    const found = await detect({
      platform: 'linux',
      homedir: '/home/a',
      env: { PATH: '/usr/bin' },
      executables: ['/usr/bin/claude'],
    });
    expect(found).toMatchObject({ installed: true, version: null });
  });
});

describe('helpers', () => {
  it.each([
    ['2.1.282 (Claude Code)\n', '2.1.282'],
    ['claude 2.0.0-beta.3', '2.0.0-beta.3'],
    ['v24.16.0', '24.16.0'],
    ['no version here', null],
  ])('parses %j', (output, version) => {
    expect(parseVersion(output)).toBe(version);
  });

  it('CLAUDE_CONFIG_DIR is found whatever its case on Windows only', () => {
    const win = fakeSystem({
      platform: 'win32',
      homedir: 'C:\\u',
      env: { claude_config_dir: 'D:\\c' },
    });
    const linux = fakeSystem({
      platform: 'linux',
      homedir: '/u',
      env: { claude_config_dir: '/c' },
    });
    expect(claudeConfigDir(win.system)).toBe('D:\\c');
    expect(claudeConfigDir(linux.system)).toBe('/u/.claude');
  });
});

/**
 * The real OS: a fake `claude` (a link to the running Node binary, whose `--version` prints
 * e.g. `v24.16.0`) in a temporary PATH folder, found and run like the real one.
 */
describe('real PC', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentnomad-detect-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds and runs `claude` from PATH and sees the config folder', async () => {
    const bin = join(dir, 'bin');
    const home = join(dir, 'home');
    await mkdir(bin);
    await mkdir(join(home, '.claude'), { recursive: true });
    const fake = join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (process.platform === 'win32') {
      await link(process.execPath, fake).catch(() => copyFile(process.execPath, fake));
    } else {
      await symlink(process.execPath, fake);
    }

    const found = await createClaudeCodeDetector(
      nodeDetectorSystem({ PATH: bin, PATHEXT: '.EXE' }, home),
    ).detect();
    expect(found).toEqual({
      installed: true,
      baseDir: join(home, '.claude'),
      version: process.versions.node,
    });
  });

  it('reports nothing installed in an empty home with no PATH', async () => {
    const found = await createClaudeCodeDetector(nodeDetectorSystem({ PATH: '' }, dir)).detect();
    expect(found.installed).toBe(false);
  });
});
