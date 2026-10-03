import { describe, expect, it } from 'vitest';

import {
  createClaudeCodeAfterRestore,
  type ClaudeCli,
  type CollectedFile,
  type DetectorSystem,
  type FollowUpPlanContext,
  type ManagedSettings,
  PluginManifestSchema,
} from '../src/index.ts';

/** Organization-managed settings, injected so no test reads this PC's (SOLID-01). */
const blockedByPolicy: ManagedSettings = {
  sources: [{ kind: 'file', where: '/etc/claude-code/managed-settings.json' }],
  keys: ['strictKnownMarketplaces'],
  restrictsPlugins: true,
  restrictsMcpServers: false,
};
const noPolicy: ManagedSettings = {
  sources: [],
  keys: [],
  restrictsPlugins: false,
  restrictsMcpServers: false,
};

/** The plan step (it asks), then the follow-up it returns (it gets no prompter). */
function afterRestore(deps: {
  system: DetectorSystem;
  cli: (path: string) => ClaudeCli;
  managed?: ManagedSettings;
}) {
  return async (ctx: FollowUpPlanContext) => {
    const followUp = await createClaudeCodeAfterRestore({
      ...deps,
      managedSettings: () => Promise.resolve(deps.managed ?? noPolicy),
    })(ctx);
    await followUp({ reporter: ctx.reporter });
  };
}

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
  const ctx: FollowUpPlanContext = {
    target: { kind: 'global' },
    files,
    assumeYes: false,
    allowCommands: false,
    parts: new Map(),
    prompter: {
      confirm: (message: string) => {
        asked.push(message);
        return Promise.resolve(answers.shift() ?? false);
      },
    } as unknown as FollowUpPlanContext['prompter'],
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
    await afterRestore({ system: system(['/usr/bin/npm']), cli })(t.ctx);
    expect(t.asked).toEqual([
      '"ccstatusline" is not installed here. Install it with `npm install -g ccstatusline@2.2.22`?',
    ]);
    expect(runs).toEqual(['/usr/bin/npm install -g ccstatusline@2.2.22']);
    expect(t.lines).toContain('Installed ccstatusline@2.2.22.');
    expect(
      t.lines.some((line) => line.includes('"terminal-notifier", which is not installed here')),
    ).toBe(true);
  });

  it.each([
    [false, []],
    [true, ['/usr/bin/npm install -g ccstatusline@2.2.22']],
  ])(
    '--yes installs a program only with --allow-commands (%s), never asking',
    async (allow, ran) => {
      const { cli, runs } = recordingCli();
      const t = context([programs], []);
      await afterRestore({ system: system(['/usr/bin/npm']), cli })({
        ...t.ctx,
        assumeYes: true,
        allowCommands: allow,
      });
      expect(t.asked).toEqual([]);
      expect(runs).toEqual(ran);
      if (!allow) {
        expect(t.lines.some((line) => line.includes('npm install -g ccstatusline@2.2.22'))).toBe(
          true,
        );
      }
    },
  );

  it('does nothing for programs already installed', async () => {
    const { cli, runs } = recordingCli();
    const t = context([programs]);
    await afterRestore({
      system: system(['/usr/bin/npm', '/usr/bin/ccstatusline', '/usr/bin/terminal-notifier']),
      cli,
    })(t.ctx);
    expect(runs).toEqual([]);
    expect(t.asked).toEqual([]);
  });

  it.each(['x --registry=evil', '--global', '-g'])(
    'refuses a programs file that could smuggle arguments: %s',
    async (pkg) => {
      const { cli, runs } = recordingCli();
      const bad = json('.agentnomad/programs.json', {
        programs: [{ command: 'x', npm: { package: pkg, version: '1.0.0' } }],
      });
      await afterRestore({ system: system(['/usr/bin/npm']), cli })(context([bad]).ctx);
      expect(runs).toEqual([]);
    },
  );

  it('a normal plugin id is accepted (control for the next test)', () => {
    expect(
      PluginManifestSchema.safeParse({
        marketplaces: [],
        plugins: [{ id: 'x@market', scope: 'user', commandSource: false }],
        skipped: [],
      }).success,
    ).toBe(true);
  });

  it.each(['-x@market', 'x@-market', '--help@x'])(
    'a plugin id that starts like an option is refused: %s',
    (id) => {
      expect(
        PluginManifestSchema.safeParse({
          marketplaces: [],
          plugins: [{ id, scope: 'user', commandSource: false }],
          skipped: [],
        }).success,
      ).toBe(false);
    },
  );

  it('reinstalls saved plugins with the claude command', async () => {
    const { cli, runs } = recordingCli();
    const plugins = json('.agentnomad/plugins.json', {
      marketplaces: [{ name: 'brag', add: 'latent-spaces/brag' }],
      plugins: [{ id: 'brag@brag', scope: 'user', commandSource: false }],
      skipped: [],
    });
    const t = context([plugins]);
    await afterRestore({ system: system(['/usr/bin/claude']), cli })(t.ctx);
    expect(runs).toEqual([
      '/usr/bin/claude plugin marketplace add latent-spaces/brag',
      '/usr/bin/claude plugin install brag@brag --scope user --json',
    ]);
  });

  it('asks in the plan step and installs only in the follow-up (T61)', async () => {
    const { cli, runs } = recordingCli();
    const plugins = json('.agentnomad/plugins.json', {
      marketplaces: [],
      plugins: [{ id: 'build@market', scope: 'user', commandSource: true }],
      skipped: [],
    });
    const t = context([plugins, programs], [true, true, true]);
    const followUp = await createClaudeCodeAfterRestore({
      system: system(['/usr/bin/claude', '/usr/bin/npm']),
      cli,
      managedSettings: () => Promise.resolve(noPolicy),
    })(t.ctx);
    expect(t.asked).toEqual([
      'Reinstall 1 plugin?',
      'build@market is built by running a command from its marketplace. Allow it?',
      '"ccstatusline" is not installed here. Install it with `npm install -g ccstatusline@2.2.22`?',
    ]);
    expect(runs).toEqual([]);
    await followUp({ reporter: t.ctx.reporter });
    expect(runs).toEqual([
      '/usr/bin/claude plugin install build@market --scope user --json --yes',
      '/usr/bin/npm install -g ccstatusline@2.2.22',
    ]);
    expect(t.asked).toHaveLength(3);
  });

  it('explains a plugin blocked by the injected managed settings, never this PC’s (SOLID-01)', async () => {
    const plugins = json('.agentnomad/plugins.json', {
      marketplaces: [],
      plugins: [{ id: 'brag@brag', scope: 'user', commandSource: false }],
      skipped: [],
    });
    const blocked = (path: string): ClaudeCli => ({
      run: (args) =>
        Promise.resolve({
          exitCode: 1,
          stdout: '',
          stderr: `${path} ${args[1] ?? ''}: blocked by policy`,
        }),
    });
    const t = context([plugins]);
    await afterRestore({
      system: system(['/usr/bin/claude']),
      cli: blocked,
      managed: blockedByPolicy,
    })(t.ctx);
    expect(t.lines.join('\n')).toContain("blocked by your organization's Claude Code policy");
  });

  it('says so when Claude Code is not installed, instead of failing', async () => {
    const plugins = json('.agentnomad/plugins.json', {
      marketplaces: [],
      plugins: [{ id: 'brag@brag', scope: 'user', commandSource: false }],
      skipped: [],
    });
    const t = context([plugins]);
    await afterRestore({ system: system([]), cli: recordingCli().cli })(t.ctx);
    expect(t.lines[0]).toContain('the claude command was not found');
  });
});
