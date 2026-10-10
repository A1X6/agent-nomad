import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_BUNDLE_BYTES } from '@agentnomad/contracts';
import { describe, expect, it } from 'vitest';

import { createAppRegistry } from '../src/app.ts';
import type { CommandHandlers } from '../src/cli/commands.ts';
import type { PartFlags } from '../src/cli/program.ts';
import { EXIT, runCli } from '../src/cli/run.ts';
import { SetupsNotDoneError } from '../src/cli/setup-outcomes.ts';
import { formatSize } from '../src/ui/format-size.ts';
import { AnswerNeededError } from '../src/ui/no-terminal-prompter.ts';
import { PromptCancelledError } from '../src/ui/prompter.ts';
import { CLI_VERSION } from '../src/version.ts';

interface Call {
  readonly command: string;
  readonly options?: unknown;
}

/** The optional parts of the agents an installed CLI registers (Claude Code's claude.ai skills). */
const REGISTERED_PARTS = createAppRegistry({
  env: {},
  homedir: join(tmpdir(), 'agentnomad-program-home'),
  platform: process.platform,
})
  .list()
  .flatMap((adapter) => adapter.optionalParts ?? []);

/** Runs the CLI with handlers that record what they were called with. */
async function run(
  args: string[],
  overrides: Partial<CommandHandlers> = {},
  optionalParts: readonly PartFlags[] = REGISTERED_PARTS,
) {
  const calls: Call[] = [];
  let out = '';
  let err = '';
  const messages: string[] = [];
  const record =
    (command: string) =>
    (options?: unknown): Promise<void> => {
      calls.push(options === undefined ? { command } : { command, options });
      return Promise.resolve();
    };
  const handlers: CommandHandlers = {
    register: record('register'),
    login: record('login'),
    logout: record('logout'),
    push: record('push'),
    pull: record('pull'),
    list: record('list'),
    agents: record('agents'),
    status: record('status'),
    delete: record('delete'),
    accountDelete: record('accountDelete'),
    env: record('env'),
    ...overrides,
  };
  const code = await runCli(args, {
    handlers,
    optionalParts,
    reporter: {
      error: (message) => messages.push(`error: ${message}`),
      warn: (message) => messages.push(`warn: ${message}`),
    },
    output: {
      writeOut: (text) => {
        out += text;
      },
      writeErr: (text) => {
        err += text;
      },
    },
  });
  return { code, calls, out, err, messages };
}

describe('help and version', () => {
  it('lists every command', async () => {
    const { code, out } = await run(['--help']);
    expect(code).toBe(EXIT.ok);
    for (const command of [
      'register',
      'login',
      'logout',
      'push',
      'pull',
      'list',
      'agents',
      'status',
      'delete',
      'account',
      'env',
    ]) {
      expect(out).toMatch(new RegExp(`^  ${command}\\b`, 'm'));
    }
    expect(out).toContain('no password recovery');
  });

  it('gives the size limit from the shared constant (READ-03)', async () => {
    const { out } = await run(['--help']);
    expect(out).toContain(`over ${formatSize(MAX_BUNDLE_BYTES)}`);
  });

  it("describes --memory without one agent's words (ARCH-02)", async () => {
    const { out } = await run(['push', '--help']);
    expect(out).toMatch(/--memory +include the agent's memory/);
    expect(out).not.toContain('subagent');
  });

  it('shows the flags of a command', async () => {
    const { code, out } = await run(['pull', '--help']);
    expect(code).toBe(EXIT.ok);
    for (const flag of [
      '--agent <ids>',
      '--global',
      '--project <name>',
      '--yes',
      '--merge',
      '--overwrite',
    ]) {
      expect(out).toContain(flag);
    }
  });

  it('prints the version, which matches package.json', async () => {
    const { code, out } = await run(['--version']);
    expect(code).toBe(EXIT.ok);
    expect(out.trim()).toBe(CLI_VERSION);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(CLI_VERSION).toBe(pkg.version);
  });

  it('suggests the closest command for a typo', async () => {
    const { code, err } = await run(['pus']);
    expect(code).toBe(EXIT.failed);
    expect(err).toContain('Did you mean push?');
  });
});

describe('routing and flags', () => {
  it('routes each simple command to its handler', async () => {
    for (const command of ['logout', 'list', 'agents', 'env']) {
      const { code, calls } = await run([command]);
      expect(code).toBe(EXIT.ok);
      expect(calls).toEqual([{ command }]);
    }
  });

  it('passes push flags as typed options, without repeated agents', async () => {
    const { calls } = await run([
      'push',
      '--agent',
      'claude-code, codex,claude-code',
      '--global',
      '-y',
    ]);
    expect(calls).toEqual([
      { command: 'push', options: { agents: ['claude-code', 'codex'], global: true, yes: true } },
    ]);
  });

  it.each([
    ['--memory', true],
    ['--no-memory', false],
  ])('passes %s to push', async (flag, memory) => {
    const { calls } = await run(['push', '--global', flag]);
    expect(calls).toEqual([{ command: 'push', options: { global: true, yes: false, memory } }]);
  });

  it('leaves out what was not given, so the command can ask', async () => {
    const { calls } = await run(['push']);
    expect(calls).toEqual([{ command: 'push', options: { global: false, yes: false } }]);
  });

  it('passes the project name and the conflict choice to pull', async () => {
    const { calls } = await run(['pull', '--project', 'my saas app', '--overwrite']);
    expect(calls).toEqual([
      {
        command: 'pull',
        options: { global: false, project: 'my saas app', yes: false, conflict: 'overwrite' },
      },
    ]);
  });

  it('passes --allow-commands to pull only when given', async () => {
    const withFlag = await run(['pull', '--global', '--yes', '--allow-commands']);
    expect(withFlag.calls).toEqual([
      { command: 'pull', options: { global: true, yes: true, allowCommands: true } },
    ]);
    const without = await run(['pull']);
    expect(without.calls).toEqual([{ command: 'pull', options: { global: false, yes: false } }]);
  });

  it.each([
    ['push', '--account-skills', true],
    ['push', '--no-account-skills', false],
    ['pull', '--account-skills', true],
    ['pull', '--no-account-skills', false],
  ])('passes %s %s as the account-skills part', async (command, flag, value) => {
    const { calls } = await run([command, '--global', flag]);
    expect(calls).toEqual([
      {
        command,
        options: { global: true, yes: false, parts: new Map([['account-skills', value]]) },
      },
    ]);
  });

  it.each([
    ['push', '--account-plugins', true],
    ['push', '--no-account-plugins', false],
    ['pull', '--account-plugins', true],
    ['pull', '--no-account-plugins', false],
  ])('passes %s %s as the account-plugins part (T101)', async (command, flag, value) => {
    const { calls } = await run([command, '--global', flag]);
    expect(calls).toEqual([
      {
        command,
        options: { global: true, yes: false, parts: new Map([['account-plugins', value]]) },
      },
    ]);
  });

  it.each([
    ['push', '--plugin-data', true],
    ['push', '--no-plugin-data', false],
    ['pull', '--plugin-data', true],
    ['pull', '--no-plugin-data', false],
  ])('passes %s %s as the plugin-data part (T102)', async (command, flag, value) => {
    const { calls } = await run([command, '--global', flag]);
    expect(calls).toEqual([
      {
        command,
        options: { global: true, yes: false, parts: new Map([['plugin-data', value]]) },
      },
    ]);
  });

  it('gives every optional part of an agent its flags, help and hint (ARCH-02)', async () => {
    const parts: PartFlags[] = [
      ...REGISTERED_PARTS,
      {
        id: 'prompts',
        flagHelp: {
          push: { include: 'save the prompts library', leaveOut: 'leave the prompts out' },
          pull: { include: 'add the prompts library', leaveOut: 'do not add the prompts' },
        },
      },
    ];
    const both = await run(['push', '--global', '--no-account-skills', '--prompts'], {}, parts);
    expect(both.calls).toEqual([
      {
        command: 'push',
        options: {
          global: true,
          yes: false,
          parts: new Map([
            ['account-skills', false],
            ['prompts', true],
          ]),
        },
      },
    ]);
    const pull = await run(['pull', '--global', '--no-prompts'], {}, parts);
    expect(pull.calls).toEqual([
      {
        command: 'pull',
        options: { global: true, yes: false, parts: new Map([['prompts', false]]) },
      },
    ]);
    expect((await run(['push', '--help'], {}, parts)).out).toMatch(
      /--prompts +save the prompts library.*--no-prompts +leave the prompts out/s,
    );
    expect((await run(['pull', '--help'], {}, parts)).out).toMatch(
      /--prompts +add the prompts library.*--no-prompts +do not add the prompts/s,
    );
    const { messages } = await run(
      ['push'],
      { push: () => Promise.reject(new AnswerNeededError('Which agents?')) },
      parts,
    );
    expect(messages[0]).toContain(
      '--account-skills or --no-account-skills, --account-plugins or --no-account-plugins, --plugin-data or --no-plugin-data, --prompts or --no-prompts, and --yes.',
    );
  });

  it('passes --merge to pull as the conflict choice', async () => {
    const { calls } = await run(['pull', '--global', '--merge']);
    expect(calls).toEqual([
      { command: 'pull', options: { global: true, yes: false, conflict: 'merge' } },
    ]);
  });

  it('routes status and delete with their scope and --yes', async () => {
    const status = await run(['status', '--project', 'x']);
    expect(status.calls).toEqual([{ command: 'status', options: { global: false, project: 'x' } }]);
    const removal = await run(['delete', '--global', '--yes']);
    expect(removal.calls).toEqual([{ command: 'delete', options: { global: true, yes: true } }]);
  });

  it('routes account delete', async () => {
    const { calls } = await run(['account', 'delete', '--yes']);
    expect(calls).toEqual([
      { command: 'accountDelete', options: { yes: true, passwordStdin: false } },
    ]);
  });

  it('passes nothing to register and login when no flag is given, so they ask', async () => {
    for (const command of ['register', 'login']) {
      const { calls } = await run([command]);
      expect(calls).toEqual([{ command, options: { yes: false, passwordStdin: false } }]);
    }
  });

  it.each([
    ['register', 'register'],
    ['login', 'login'],
    ['account delete', 'accountDelete'],
  ])('passes --username, --password-stdin and --yes to %s', async (command, handler) => {
    const { calls } = await run([
      ...command.split(' '),
      '--username',
      'ahmed',
      '--password-stdin',
      '--yes',
    ]);
    expect(calls).toEqual([
      { command: handler, options: { yes: true, passwordStdin: true, username: 'ahmed' } },
    ]);
  });

  it('has no --password flag, so a password never lands in shell history', async () => {
    const { code, calls, err } = await run(['login', '--password', 'secret']);
    expect(code).toBe(EXIT.failed);
    expect(calls).toEqual([]);
    expect(err).toContain("unknown option '--password'");
  });

  it.each([
    ['an invalid agent id', ['push', '--agent', 'Claude Code'], 'not a valid agent id'],
    ['an empty agent list', ['push', '--agent', ','], 'at least one agent'],
    [
      'an empty project name',
      ['pull', '--project', ''],
      "option '--project <name>' argument '' is invalid. Too small",
    ],
    [
      'a project name with a line break',
      ['pull', '--project', 'a\nb'],
      "option '--project <name>' argument 'a\nb' is invalid. Project name must not contain control characters",
    ],
    ['--merge with --overwrite', ['pull', '--merge', '--overwrite'], 'cannot be used with'],
    ['an unknown flag', ['push', '--force'], "unknown option '--force'"],
    [
      'an invalid username',
      ['login', '--username', 'Ahmed Ali'],
      "option '--username <name>' argument 'Ahmed Ali' is invalid. Username must be 3–32 lowercase",
    ],
  ])('refuses %s without running the command', async (_, args, message) => {
    const { code, calls, err } = await run(args);
    expect(code).toBe(EXIT.failed);
    expect(calls).toEqual([]);
    expect(err).toContain(message);
  });
});

describe('outcomes', () => {
  it('turns a command error into exit code 1 with its message', async () => {
    const { code, messages } = await run(['list'], {
      list: () => Promise.reject(new Error('Network down')),
    });
    expect(code).toBe(EXIT.failed);
    expect(messages).toEqual(['error: Network down']);
  });

  it('turns Ctrl+C in a question into exit code 130', async () => {
    const { code, messages } = await run(['login'], {
      login: () => Promise.reject(new PromptCancelledError()),
    });
    expect(code).toBe(EXIT.cancelled);
    expect(messages).toEqual(['warn: Cancelled.']);
  });

  it('a setup push or pull did not do is exit code 1, with one message listing them (BUG-03)', async () => {
    const notDone = new SetupsNotDoneError('push', [
      { setup: 'Claude Code global setup', reason: 'a newer copy exists' },
      { setup: 'Claude Code project "my-app"', reason: '6.2 MB, over the 5 MB limit' },
    ]);
    const { code, messages } = await run(['push', '--global', '--yes'], {
      push: () => Promise.reject(notDone),
    });
    expect(code).toBe(EXIT.failed);
    expect(messages).toEqual([
      'error: Not saved:\n  - the Claude Code global setup: a newer copy exists\n  - the Claude Code project "my-app": 6.2 MB, over the 5 MB limit',
    ]);
  });

  it.each([
    [
      ['push'],
      'Use --agent, --global or --project <name>, --memory or --no-memory, --account-skills or --no-account-skills, --account-plugins or --no-account-plugins, --plugin-data or --no-plugin-data, and --yes. See `agentnomad push --help`.',
    ],
    [
      ['pull', '--global'],
      'Use --agent, --global or --project <name>, --merge or --overwrite, --allow-commands, --account-skills or --no-account-skills, --account-plugins or --no-account-plugins, --plugin-data or --no-plugin-data, and --yes. See `agentnomad pull --help`.',
    ],
    [
      ['account', 'delete'],
      'Use --username, --password-stdin and --yes. See `agentnomad account delete --help`.',
    ],
    [['list'], 'Answer it with flags. See `agentnomad list --help`.'],
  ])(
    'a question with no terminal to ask in fails with exit code 1 and the flags to add (%j)',
    async (args, hint) => {
      const fail = () => Promise.reject(new AnswerNeededError('Which agents?'));
      const { code, messages } = await run(args, {
        push: fail,
        pull: fail,
        accountDelete: fail,
        list: fail,
      });
      expect(code).toBe(EXIT.failed);
      expect(messages).toEqual([
        `error: "Which agents?" needs an answer, but there is no terminal to ask in. ${hint}`,
      ]);
    },
  );
});
