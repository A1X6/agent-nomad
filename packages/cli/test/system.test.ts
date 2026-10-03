import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeManagedSettingsSystem } from '../src/agents/claude-code/managed-settings.ts';
import { createClaudeCli, type StartProgram } from '../src/agents/claude-code/plugin-sync.ts';
import { systemProcessLister } from '../src/agents/claude-code/running-claude.ts';
import { realPowerShell } from '../src/env/shell-profile.ts';
import { windowsOwnerOnly } from '../src/secrets/file-store.ts';

const win32 = process.platform === 'win32';
const posix = !win32;

/** Records what would be started, without starting anything. */
function fakeStart() {
  const calls: { file: string; args: readonly string[]; verbatim: boolean }[] = [];
  const start: StartProgram = (file, args, options) => {
    calls.push({ file, args, verbatim: options.verbatim });
    return Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '' });
  };
  return { calls, start };
}

const windowsPc = { platform: 'win32' as const, env: {} };

describe('createClaudeCli: the command line (every OS)', () => {
  it('runs a Windows .cmd launcher through cmd.exe with one verbatim command line', async () => {
    const { calls, start } = fakeStart();
    const cli = createClaudeCli('C:\\Program Files\\nodejs\\npm.cmd', windowsPc, { start });
    const run = await cli.run(['install', '-g', 'pkg@1.0.0'], 'C:\\Users\\me');
    expect(run).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
    expect(calls).toEqual([
      {
        file: 'cmd.exe',
        args: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\npm.cmd" install -g pkg@1.0.0"'],
        verbatim: true,
      },
    ]);
  });

  it('treats .bat the same, whatever the case of the extension', async () => {
    const { calls, start } = fakeStart();
    await createClaudeCli('C:\\tools\\claude.BAT', windowsPc, { start }).run(['--version'], 'C:\\');
    expect(calls[0]?.file).toBe('cmd.exe');
    expect(calls[0]?.args.at(-1)).toBe('""C:\\tools\\claude.BAT" --version"');
  });

  it('runs a Windows .exe directly, letting Node quote the arguments', async () => {
    const { calls, start } = fakeStart();
    const cli = createClaudeCli('C:\\Users\\me\\.local\\bin\\claude.exe', windowsPc, { start });
    await cli.run(['plugin', 'marketplace', 'add', 'C:\\My Plugins'], 'C:\\');
    expect(calls).toEqual([
      {
        file: 'C:\\Users\\me\\.local\\bin\\claude.exe',
        args: ['plugin', 'marketplace', 'add', 'C:\\My Plugins'],
        verbatim: false,
      },
    ]);
  });

  it('chooses the .cmd branch from the injected platform, not from the PC running it', async () => {
    const { calls, start } = fakeStart();
    await createClaudeCli('/home/me/bin/tool.cmd', { platform: 'linux', env: {} }, { start }).run(
      ['a b'],
      '/home/me',
    );
    expect(calls).toEqual([{ file: '/home/me/bin/tool.cmd', args: ['a b'], verbatim: false }]);
  });

  it.each([
    ['a space', 'my plugin'],
    ['a tab', 'a\tb'],
    ['a line break', 'a\r\nb'],
    ['a quote', 'a"b'],
    ['an ampersand', 'a&calc'],
    ['a pipe', 'a|b'],
    ['a redirect', 'a>out'],
    ['a caret', 'a^b'],
    ['a variable', '%PATH%'],
    ['an exclamation mark', '!x!'],
    ['an empty argument', ''],
  ])('refuses an argument with %s for a .cmd launcher, starting nothing', async (_, arg) => {
    const { calls, start } = fakeStart();
    const cli = createClaudeCli('C:\\nodejs\\npm.cmd', windowsPc, { start });
    const run = await cli.run(['install', '-g', arg], 'C:\\');
    expect(run).toEqual({ exitCode: 1, stdout: '', stderr: 'Unsafe characters for cmd.exe' });
    expect(calls).toEqual([]);
  });

  it('refuses a .cmd launcher whose path cmd.exe would change (%, !, ")', async () => {
    const { calls, start } = fakeStart();
    const cli = createClaudeCli('C:\\100%\\npm.cmd', windowsPc, { start });
    expect((await cli.run(['--version'], 'C:\\')).exitCode).toBe(1);
    expect(calls).toEqual([]);
  });
});

// Real programs start slowly while the whole suite runs in parallel.
describe('the real programs (run on this OS)', { timeout: 30_000 }, () => {
  let dir: string;

  beforeEach(async () => {
    // A space in the folder name, as in "C:\Program Files".
    dir = await mkdtemp(join(tmpdir(), 'agentnomad system-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.runIf(win32)(
    'createClaudeCli runs a real .cmd launcher and passes its arguments',
    async () => {
      const launcher = join(dir, 'echo-args.cmd');
      await writeFile(launcher, '@echo off\r\necho ARGS:%*\r\n');
      const cli = createClaudeCli(launcher, { platform: 'win32', env: process.env });
      const run = await cli.run(['install', '-g', '@scope/pkg@1.0.0'], dir);
      expect(run.stderr).toBe('');
      expect(run.exitCode).toBe(0);
      expect(run.stdout.trim()).toBe('ARGS:install -g @scope/pkg@1.0.0');
    },
  );

  it.runIf(win32)('createClaudeCli reports the exit code of a failing .cmd launcher', async () => {
    const launcher = join(dir, 'fail.cmd');
    await writeFile(launcher, '@echo off\r\nexit /b 3\r\n');
    const run = await createClaudeCli(launcher, { platform: 'win32', env: process.env }).run(
      [],
      dir,
    );
    expect(run.exitCode).toBe(3);
  });

  it.runIf(posix)('createClaudeCli runs a real program with its arguments as given', async () => {
    const program = join(dir, 'echo-args');
    await writeFile(program, '#!/bin/sh\nprintf "ARGS:%s|" "$@"\n');
    await chmod(program, 0o755);
    const cli = createClaudeCli(program, { platform: process.platform, env: process.env });
    const run = await cli.run(['install', 'two words'], dir);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('ARGS:install|ARGS:two words|');
  });

  it.runIf(win32)('realPowerShell runs a statement with the injected environment', async () => {
    const run = realPowerShell({ ...process.env, AGENTNOMAD_T54_BASE: 'from-base' });
    const output = await run('Write-Output "$env:AGENTNOMAD_T54_BASE $env:AGENTNOMAD_T54_EXTRA"', {
      AGENTNOMAD_T54_EXTRA: 'from-call',
    });
    expect(output.trim()).toBe('from-base from-call');
  });

  it.runIf(posix)('realPowerShell fails clearly where there is no Windows PowerShell', async () => {
    await expect(realPowerShell(process.env)('Write-Output hi', {})).rejects.toThrow(
      /PowerShell failed/,
    );
  });

  it.runIf(win32)('windowsOwnerOnly leaves only the current user on a temp file', async () => {
    const file = join(dir, 'secret.json');
    await writeFile(file, '{}');
    await windowsOwnerOnly(process.env)(file);
    const { stdout: acl } = await promisify(execFile)('icacls', [file], { encoding: 'utf8' });
    // One entry, full control, nothing inherited: "<file> PC\user:(F)".
    const entries = acl.split(/\r?\n/).filter((line) => line.includes(':('));
    expect(entries, acl).toHaveLength(1);
    expect(entries[0]?.trim()).toMatch(/:\(F\)$/);
  });

  it.runIf(win32)('windowsOwnerOnly finds its tools through the injected SystemRoot', async () => {
    const file = join(dir, 'secret.json');
    await writeFile(file, '{}');
    await expect(
      windowsOwnerOnly({ SystemRoot: join(dir, 'no-windows-here') })(file),
    ).rejects.toThrow(/whoami\.exe failed/);
  });

  it.runIf(posix)('windowsOwnerOnly fails where there are no Windows tools', async () => {
    const file = join(dir, 'secret.json');
    await writeFile(file, '{}');
    await expect(windowsOwnerOnly(process.env)(file)).rejects.toThrow(/whoami\.exe failed/);
  });

  it('systemProcessLister lists running processes, this test runner included', async () => {
    const list = await systemProcessLister(process.platform, 25_000)();
    expect(list).not.toBeNull();
    expect(list?.length).toBeGreaterThan(0);
    expect(list?.some((line) => /node/i.test(line))).toBe(true);
  });

  it.runIf(win32)(
    'readRegistry reads the policy key, or answers null when it is absent',
    async () => {
      const system = nodeManagedSettingsSystem(process.env, dir, 'win32');
      for (const hive of ['HKLM', 'HKCU'] as const) {
        const value = await system.readRegistry(hive);
        expect(value === null || typeof value === 'string').toBe(true);
      }
    },
  );

  it.runIf(posix)('readRegistry answers null where there is no registry', async () => {
    const system = nodeManagedSettingsSystem(process.env, dir, process.platform);
    expect(await system.readRegistry('HKCU')).toBeNull();
  });
});
