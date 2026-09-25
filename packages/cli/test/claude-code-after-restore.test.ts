import { describe, expect, it } from 'vitest';

import {
  createClaudeCodeAfterRestore,
  type AfterRestoreContext,
  type ClaudeCli,
  type CollectedFile,
  type DetectorSystem,
} from '../src/index.ts';

const json = (path: string, value: unknown): CollectedFile => ({
  path,
  content: new TextEncoder().encode(JSON.stringify(value)),
  executable: false,
});

function system(executables: string[]): DetectorSystem {
  return {
    platform: 'linux',
    homedir: '/home/a',
    env: { PATH: '/usr/bin' },
    isDirectory: () => Promise.resolve(false),
    isExecutable: (path) => Promise.resolve(executables.includes(path)),
    readText: () => Promise.resolve(null),
    runVersion: () => Promise.resolve(null),
  };
}

function context(files: CollectedFile[], answers: boolean[] = [true, true]) {
  const lines: string[] = [];
  const asked: string[] = [];
  const ctx: AfterRestoreContext = {
    target: { kind: 'global' },
    files,
    assumeYes: false,
    prompter: {
      confirm: (message: string) => {
        asked.push(message);
        return Promise.resolve(answers.shift() ?? false);
      },
    } as unknown as AfterRestoreContext['prompter'],
    reporter: {
      info: (m) => lines.push(m),
      success: (m) => lines.push(m),
      warn: (m) => lines.push(m),
      error: (m) => lines.push(m),
      spinner: () => ({ start: () => undefined, stop: () => undefined }),
    },
  };
  return { ctx, lines, asked };
}

function recordingCli() {
  const runs: string[] = [];
  const cli = (path: string): ClaudeCli => ({
    run: (args) => {
      runs.push(`${path} ${args.join(' ')}`);
      return Promise.resolve({ exitCode: 0, stdout: '{"outcome":"ok"}', stderr: '' });
    },
  });
  return { cli, runs };
}

const programs = json('.agentnomad/programs.json', {
  programs: [
    { command: 'ccstatusline', npm: { package: 'ccstatusline', version: '2.2.22' } },
    { command: 'terminal-notifier', npm: null },
  ],
});

describe('after a Claude Code restore', () => {
  it('offers to install a missing npm program, and names the others', async () => {
    const { cli, runs } = recordingCli();
    const t = context([programs]);
    await createClaudeCodeAfterRestore({ system: system(['/usr/bin/npm']), cli })(t.ctx);
    expect(t.asked).toEqual([
      '"ccstatusline" is not installed here. Install it with `npm install -g ccstatusline@2.2.22`?',
    ]);
    expect(runs).toEqual(['/usr/bin/npm install -g ccstatusline@2.2.22']);
    expect(t.lines).toContain('Installed ccstatusline@2.2.22.');
    expect(
      t.lines.some((line) => line.includes('"terminal-notifier", which is not installed here')),
    ).toBe(true);
  });

  it('does nothing for programs already installed', async () => {
    const { cli, runs } = recordingCli();
    const t = context([programs]);
    await createClaudeCodeAfterRestore({
      system: system(['/usr/bin/npm', '/usr/bin/ccstatusline', '/usr/bin/terminal-notifier']),
      cli,
    })(t.ctx);
    expect(runs).toEqual([]);
    expect(t.asked).toEqual([]);
  });

  it('refuses a programs file that could smuggle arguments', async () => {
    const { cli, runs } = recordingCli();
    const bad = json('.agentnomad/programs.json', {
      programs: [{ command: 'x', npm: { package: 'x --registry=evil', version: '1.0.0' } }],
    });
    await createClaudeCodeAfterRestore({ system: system(['/usr/bin/npm']), cli })(
      context([bad]).ctx,
    );
    expect(runs).toEqual([]);
  });

  it('reinstalls saved plugins with the claude command', async () => {
    const { cli, runs } = recordingCli();
    const plugins = json('.agentnomad/plugins.json', {
      marketplaces: [{ name: 'brag', add: 'latent-spaces/brag' }],
      plugins: [{ id: 'brag@brag', scope: 'user', commandSource: false }],
      skipped: [],
    });
    const t = context([plugins]);
    await createClaudeCodeAfterRestore({ system: system(['/usr/bin/claude']), cli })(t.ctx);
    expect(runs).toEqual([
      '/usr/bin/claude plugin marketplace add latent-spaces/brag',
      '/usr/bin/claude plugin install brag@brag --scope user --json',
    ]);
  });

  it('says so when Claude Code is not installed, instead of failing', async () => {
    const plugins = json('.agentnomad/plugins.json', {
      marketplaces: [],
      plugins: [{ id: 'brag@brag', scope: 'user', commandSource: false }],
      skipped: [],
    });
    const t = context([plugins]);
    await createClaudeCodeAfterRestore({ system: system([]), cli: recordingCli().cli })(t.ctx);
    expect(t.lines[0]).toContain('the claude command was not found');
  });
});
