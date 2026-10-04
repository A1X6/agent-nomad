import { execFile } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { nodeManagedSettingsSystem } from '../src/agents/claude-code/managed-settings.ts';
import { createProgramCli, type StartProgram } from '../src/agents/claude-code/plugin-sync.ts';
import {
  createClaudeRunningCheck,
  systemProcessLister,
  type RunForOutput,
} from '../src/agents/claude-code/running-claude.ts';
import { realPowerShell } from '../src/env/shell-profile.ts';
import { aclPrincipals, principalsToRemove, windowsOwnerOnly } from '../src/secrets/file-store.ts';
import { useTempDir } from './fakes.ts';

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

describe('createProgramCli: the command line (every OS)', () => {
  it('runs a Windows .cmd launcher through cmd.exe with one verbatim command line', async () => {
    const { calls, start } = fakeStart();
    const cli = createProgramCli('C:\\Program Files\\nodejs\\npm.cmd', windowsPc, { start });
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
    await createProgramCli('C:\\tools\\claude.BAT', windowsPc, { start }).run(
      ['--version'],
      'C:\\',
    );
    expect(calls[0]?.file).toBe('cmd.exe');
    expect(calls[0]?.args.at(-1)).toBe('""C:\\tools\\claude.BAT" --version"');
  });

  it('runs a Windows .exe directly, letting Node quote the arguments', async () => {
    const { calls, start } = fakeStart();
    const cli = createProgramCli('C:\\Users\\me\\.local\\bin\\claude.exe', windowsPc, { start });
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
    await createProgramCli('/home/me/bin/tool.cmd', { platform: 'linux', env: {} }, { start }).run(
      ['a b'],
      '/home/me',
    );
    expect(calls).toEqual([{ file: '/home/me/bin/tool.cmd', args: ['a b'], verbatim: false }]);
  });

  it.each([
    ['a tab', 'a\tb'],
    ['a non-breaking space', 'a\u00a0b'],
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
    const cli = createProgramCli('C:\\nodejs\\npm.cmd', windowsPc, { start });
    const run = await cli.run(['install', '-g', arg], 'C:\\');
    expect(run).toEqual({ exitCode: 1, stdout: '', stderr: 'Unsafe characters for cmd.exe' });
    expect(calls).toEqual([]);
  });

  it('quotes an argument with spaces for a .cmd launcher, e.g. a local marketplace folder', async () => {
    const { calls, start } = fakeStart();
    const cli = createProgramCli('C:\\nodejs\\claude.cmd', windowsPc, { start });
    await cli.run(['plugin', 'marketplace', 'add', 'C:\\My Plugins', 'C:\\My Plugins\\'], 'C:\\');
    expect(calls).toEqual([
      {
        file: 'cmd.exe',
        // A trailing backslash is doubled so it does not escape the closing quote.
        args: [
          '/d',
          '/s',
          '/c',
          '""C:\\nodejs\\claude.cmd" plugin marketplace add "C:\\My Plugins" "C:\\My Plugins\\\\""',
        ],
        verbatim: true,
      },
    ]);
  });

  it('refuses a .cmd launcher whose path cmd.exe would change (%, !, ")', async () => {
    const { calls, start } = fakeStart();
    const cli = createProgramCli('C:\\100%\\npm.cmd', windowsPc, { start });
    expect((await cli.run(['--version'], 'C:\\')).exitCode).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe('systemProcessLister: which program it runs (every OS)', () => {
  /** Answers each program with a scripted output (`null`: it failed), recording the calls. */
  function fakeRun(outputs: Record<string, string | null>) {
    const calls: { file: string; env: Readonly<Record<string, string | undefined>> }[] = [];
    const run: RunForOutput = (file, _args, options) => {
      calls.push({ file, env: options.env });
      return Promise.resolve(outputs[file] ?? null);
    };
    return { calls, run };
  }
  const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
  const npmClaude =
    '"C:\\Program Files\\nodejs\\node.exe" C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';

  it('Windows: reads command lines through PowerShell, with the injected environment (BUG-08)', async () => {
    const { calls, run } = fakeRun({
      'powershell.exe': base64(`System Idle Process\n${npmClaude}\nC:\\Windows\\explorer.exe\n`),
    });
    const env = { SystemRoot: 'C:\\Windows', AGENTNOMAD_T60: 'injected' };
    const list = await systemProcessLister({ platform: 'win32', env }, { run })();
    expect(list).toEqual(['System Idle Process', npmClaude, 'C:\\Windows\\explorer.exe']);
    expect(calls).toEqual([{ file: 'powershell.exe', env }]);
    expect(await createClaudeRunningCheck(() => Promise.resolve(list))()).toBe(true);
  });

  it('Windows: falls back to program names when PowerShell fails', async () => {
    const { calls, run } = fakeRun({
      tasklist:
        '"explorer.exe","1","Console","1","1 K"\r\n"claude.exe","2","Console","1","1 K"\r\n',
    });
    const list = await systemProcessLister({ platform: 'win32', env: {} }, { run })();
    expect(list).toEqual(['explorer.exe', 'claude.exe']);
    expect(calls.map((call) => call.file)).toEqual(['powershell.exe', 'tasklist']);
  });

  it('Windows: an answer that is not base64 also falls back', async () => {
    const { run } = fakeRun({ 'powershell.exe': 'Get-CimInstance : Access denied', tasklist: '' });
    expect(await systemProcessLister({ platform: 'win32', env: {} }, { run })()).toEqual([]);
  });

  it('elsewhere: `ps`, chosen from the injected platform, not from the PC running it', async () => {
    const { calls, run } = fakeRun({ ps: '/sbin/init\n/Users/John Smith/.local/bin/claude\n' });
    const env = { PATH: '/usr/bin' };
    const list = await systemProcessLister({ platform: 'darwin', env }, { run })();
    expect(list).toEqual(['/sbin/init', '/Users/John Smith/.local/bin/claude']);
    expect(calls).toEqual([{ file: 'ps', env }]);
  });

  it('nothing readable answers null, which never blocks a pull', async () => {
    const { run } = fakeRun({});
    const list = systemProcessLister({ platform: 'win32', env: {} }, { run });
    expect(await list()).toBeNull();
    expect(await createClaudeRunningCheck(list)()).toBe(false);
  });
});

describe('icacls output, parsed (every OS)', () => {
  it('aclPrincipals reads every principal of an icacls listing (a GitHub runner, every OS)', () => {
    const file = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\agentnomad system-v3MTv6\\secret.json';
    const pad = ' '.repeat(file.length + 1);
    const listing = [
      `${file} NT AUTHORITY\\SYSTEM:(F)`,
      `${pad}BUILTIN\\Administrators:(F)`,
      `${pad}runnervmfi6oq\\runneradmin:(F)`,
      `${pad}S-1-5-21-1-2-3-1001:(I)(RX)`,
      '',
      'Successfully processed 1 files; Failed processing 0 files',
      '',
    ].join('\r\n');
    expect(aclPrincipals(listing, file)).toEqual([
      'NT AUTHORITY\\SYSTEM',
      'BUILTIN\\Administrators',
      'runnervmfi6oq\\runneradmin',
      'S-1-5-21-1-2-3-1001',
    ]);
  });

  it('principalsToRemove removes the others only when the current user is found once', () => {
    const user = { name: 'runnervmfi6oq\\runneradmin', sid: 'S-1-5-21-1-2-3-500' };
    const others = ['NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators'];
    expect(principalsToRemove([...others, 'RUNNERVMFI6OQ\\RunnerAdmin'], user)).toEqual(others);
    expect(principalsToRemove([...others, 's-1-5-21-1-2-3-500'], user)).toEqual(others);
    // icacls names the user differently from whoami: take nothing away.
    expect(principalsToRemove([...others, 'runneradmin'], user)).toEqual([]);
    expect(principalsToRemove(others, user)).toEqual([]);
    expect(principalsToRemove([...others, user.name, user.sid], user)).toEqual([]);
  });
});

// Real programs start slowly while the whole suite runs in parallel.
describe('the real programs (run on this OS)', { timeout: 30_000 }, () => {
  let dir: string;
  // A space in the folder name, as in "C:\Program Files".
  useTempDir('agentnomad system-', (temp) => (dir = temp));

  /** A `secret.json` holding `{}` in the test's folder. */
  async function secretFile(): Promise<string> {
    const file = join(dir, 'secret.json');
    await writeFile(file, '{}');
    return file;
  }

  it.runIf(win32)(
    'createProgramCli runs a real .cmd launcher and passes its arguments',
    async () => {
      const launcher = join(dir, 'echo-args.cmd');
      await writeFile(launcher, '@echo off\r\necho ARGS:%*\r\n');
      const cli = createProgramCli(launcher, { platform: 'win32', env: process.env });
      const run = await cli.run(['install', '-g', '@scope/pkg@1.0.0'], dir);
      expect(run.stderr).toBe('');
      expect(run.exitCode).toBe(0);
      expect(run.stdout.trim()).toBe('ARGS:install -g @scope/pkg@1.0.0');
    },
  );

  it.runIf(win32)(
    'createProgramCli passes a path with spaces through a real npm-style .cmd launcher intact',
    async () => {
      // Like npm's launcher for Claude Code: node runs the script with every argument (%*).
      await writeFile(
        join(dir, 'print-args.js'),
        'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
      );
      const launcher = join(dir, 'claude.cmd');
      await writeFile(launcher, `@echo off\r\n"${process.execPath}" "%~dp0print-args.js" %*\r\n`);
      const folder = join(dir, 'My Plugins');
      const args = ['plugin', 'marketplace', 'add', folder, `${folder}\\`, 'two  spaces'];
      const run = await createProgramCli(launcher, { platform: 'win32', env: process.env }).run(
        args,
        dir,
      );
      expect(run.stderr).toBe('');
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual(args);
    },
  );

  it.runIf(win32)('createProgramCli reports the exit code of a failing .cmd launcher', async () => {
    const launcher = join(dir, 'fail.cmd');
    await writeFile(launcher, '@echo off\r\nexit /b 3\r\n');
    const run = await createProgramCli(launcher, { platform: 'win32', env: process.env }).run(
      [],
      dir,
    );
    expect(run.exitCode).toBe(3);
  });

  it.runIf(posix)('createProgramCli runs a real program with its arguments as given', async () => {
    const program = join(dir, 'echo-args');
    await writeFile(program, '#!/bin/sh\nprintf "ARGS:%s|" "$@"\n');
    await chmod(program, 0o755);
    const cli = createProgramCli(program, { platform: process.platform, env: process.env });
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
    const file = await secretFile();
    const icacls = (args: string[]) => promisify(execFile)('icacls', args, { encoding: 'utf8' });
    // What a GitHub runner's elevated account leaves on a new file: SYSTEM and
    // Administrators by name, not inherited.
    await icacls([file, '/grant', '*S-1-5-18:F', '*S-1-5-32-544:F']);
    await windowsOwnerOnly(process.env)(file);
    const { stdout: acl } = await icacls([file]);
    // One entry, full control, nothing inherited: "<file> PC\user:(F)".
    const entries = acl.split(/\r?\n/).filter((line) => line.includes(':('));
    expect(entries, acl).toHaveLength(1);
    expect(entries[0]?.trim()).toMatch(/:\(F\)$/);
  });

  it.runIf(win32)('windowsOwnerOnly finds its tools through the injected SystemRoot', async () => {
    const file = await secretFile();
    await expect(
      windowsOwnerOnly({ SystemRoot: join(dir, 'no-windows-here') })(file),
    ).rejects.toThrow(/whoami\.exe failed/);
  });

  it.runIf(posix)('windowsOwnerOnly fails where there are no Windows tools', async () => {
    const file = await secretFile();
    await expect(windowsOwnerOnly(process.env)(file)).rejects.toThrow(/whoami\.exe failed/);
  });

  it('systemProcessLister lists command lines, this test runner included (BUG-08)', async () => {
    const list = await systemProcessLister(
      { platform: process.platform, env: process.env },
      { timeoutMs: 25_000 },
    )();
    expect(list).not.toBeNull();
    // A command line, not only `node.exe`: npm's Claude Code is seen the same way.
    expect(list?.some((line) => /vitest/i.test(line))).toBe(true);
  });

  // No ClaudeCode policy key exists on the CI runners (or a developer PC without a
  // managed Claude Code), so the real `reg query` must find no value in either hive.
  // What a value present is read as is tested on parseRegSettings (claude-code-managed-settings.test.ts).
  it.runIf(win32)('readRegistry answers null when the policy key is absent', async () => {
    const system = nodeManagedSettingsSystem(process.env, dir, 'win32');
    expect(await system.readRegistry('HKLM')).toBeNull();
    expect(await system.readRegistry('HKCU')).toBeNull();
  });

  it.runIf(posix)('readRegistry answers null where there is no registry', async () => {
    const system = nodeManagedSettingsSystem(process.env, dir, process.platform);
    expect(await system.readRegistry('HKCU')).toBeNull();
  });
});
