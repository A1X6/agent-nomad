import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { NOT_YET_AVAILABLE, type CommandHandlers } from '../src/cli/commands.ts';
import { EXIT, runCli } from '../src/cli/run.ts';
import { AnswerNeededError } from '../src/ui/no-terminal-prompter.ts';
import { PromptCancelledError } from '../src/ui/prompter.ts';
import { CLI_VERSION } from '../src/version.ts';

interface Call {
  readonly command: string;
  readonly options?: unknown;
}

/** Runs the CLI with handlers that record what they were called with. */
async function run(args: string[], overrides: Partial<CommandHandlers> = {}) {
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
  it('lists every command from the PRD', async () => {
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
    ['an empty project name', ['pull', '--project', ''], ''],
    ['a project name with a line break', ['pull', '--project', 'a\nb'], ''],
    ['--merge with --overwrite', ['pull', '--merge', '--overwrite'], 'cannot be used with'],
    ['an unknown flag', ['push', '--force'], "unknown option '--force'"],
    ['an invalid username', ['login', '--username', 'Ahmed Ali'], ''],
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

  it.each([
    [
      ['push'],
      'Use --agent, --global or --project <name>, --memory or --no-memory, and --yes. See `agentnomad push --help`.',
    ],
    [
      ['pull', '--global'],
      'Use --agent, --global or --project <name>, --merge or --overwrite, and --yes. See `agentnomad pull --help`.',
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

  it('says which task brings a command that is not built yet', async () => {
    const messages: string[] = [];
    const code = await runCli(['push'], {
      handlers: NOT_YET_AVAILABLE,
      reporter: { error: (m) => messages.push(m), warn: (m) => messages.push(m) },
    });
    expect(code).toBe(EXIT.failed);
    expect(messages).toEqual(['"agentnomad push" is not available yet (coming in T33).']);
  });
});
