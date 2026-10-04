import { describe, expect, it } from 'vitest';

import { collected, collectedJson, recordingReporter, scriptedPrompter } from './fakes.ts';

import {
  createClaudeCodeAfterRestore,
  type ProgramCli,
  type CollectedFile,
  type ExecutableLookupSystem,
  type FollowUpPlanContext,
  type ManagedSettings,
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

/** A saved `.agentnomad/plugins.json` with these marketplaces and plugins. */
const savedPlugins = (marketplaces: object[], plugins: object[]) =>
  collectedJson('.agentnomad/plugins.json', { marketplaces, plugins, skipped: [] });

/** brag@brag, a user plugin whose marketplace builds it without running a command. */
const brag = { id: 'brag@brag', scope: 'user', commandSource: false };

/** The plan step (it asks), then the follow-up it returns (it gets no prompter). */
function afterRestore(deps: {
  system: ExecutableLookupSystem;
  cli: (path: string) => ProgramCli;
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

/** Only what after-restore reads (SOLID-06): no full detector system to fake. */
function system(executables: string[]): ExecutableLookupSystem {
  return {
    platform: 'linux',
    homedir: '/home/a',
    env: { PATH: '/usr/bin' },
    isExecutable: (path) => Promise.resolve(executables.includes(path)),
  };
}

function context(files: CollectedFile[], answers: boolean[] = [true, true]) {
  const script = scriptedPrompter(answers);
  const { reporter, lines } = recordingReporter({ levels: false });
  const ctx: FollowUpPlanContext = {
    target: { kind: 'global' },
    files,
    assumeYes: false,
    allowCommands: false,
    parts: new Map(),
    prompter: script.prompter,
    reporter,
  };
  return { ctx, lines, asked: script.asked };
}

function recordingCli() {
  const runs: string[] = [];
  const cli = (path: string): ProgramCli => ({
    run: (args) => {
      runs.push(`${path} ${args.join(' ')}`);
      return Promise.resolve({ exitCode: 0, stdout: '{"outcome":"ok"}', stderr: '' });
    },
  });
  return { cli, runs };
}

const programs = collectedJson('.agentnomad/programs.json', {
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
      const bad = collectedJson('.agentnomad/programs.json', {
        programs: [{ command: 'x', npm: { package: pkg, version: '1.0.0' } }],
      });
      await afterRestore({ system: system(['/usr/bin/npm']), cli })(context([bad]).ctx);
      expect(runs).toEqual([]);
    },
  );

  it('reinstalls saved plugins with the claude command', async () => {
    const { cli, runs } = recordingCli();
    const plugins = savedPlugins([{ name: 'brag', add: 'latent-spaces/brag' }], [brag]);
    const t = context([plugins]);
    await afterRestore({ system: system(['/usr/bin/claude']), cli })(t.ctx);
    expect(runs).toEqual([
      '/usr/bin/claude plugin marketplace add latent-spaces/brag',
      '/usr/bin/claude plugin install brag@brag --scope user --json',
    ]);
  });

  it('asks in the plan step and installs only in the follow-up (T61)', async () => {
    const { cli, runs } = recordingCli();
    const plugins = savedPlugins([], [{ id: 'build@market', scope: 'user', commandSource: true }]);
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
    const plugins = savedPlugins([], [brag]);
    const blocked = (path: string): ProgramCli => ({
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
    const plugins = savedPlugins([], [brag]);
    const t = context([plugins]);
    await afterRestore({ system: system([]), cli: recordingCli().cli })(t.ctx);
    expect(t.lines[0]).toContain('the claude command was not found');
  });
});

describe('pull says when saved plugins or programs cannot be read (BUG-01)', () => {
  it('offers the other plugins and names an entry it refuses', async () => {
    const { cli, runs } = recordingCli();
    const plugins = savedPlugins(
      [
        { name: 'brag', add: 'latent-spaces/brag' },
        { name: 'odd', add: 'https://host/my%20market.json' },
      ],
      [brag, { id: '.x@brag', scope: 'user', commandSource: false }],
    );
    const t = context([plugins]);
    await afterRestore({ system: system(['/usr/bin/claude']), cli })(t.ctx);
    expect(runs).toEqual([
      '/usr/bin/claude plugin marketplace add latent-spaces/brag',
      '/usr/bin/claude plugin install brag@brag --scope user --json',
    ]);
    const refused = t.lines.filter((line) => line.startsWith('A saved plugin entry was left out'));
    expect(refused).toHaveLength(2);
    expect(refused[0]).toContain('my%20market.json');
    expect(refused[1]).toContain('.x@brag');
  });

  it.each([
    ['not JSON', '{'],
    ['not the expected shape', '{"plugins": 1}'],
  ])('warns when plugins.json is %s', async (_, text) => {
    const { cli, runs } = recordingCli();
    const file = collected('.agentnomad/plugins.json', text);
    const t = context([file]);
    await afterRestore({ system: system(['/usr/bin/claude']), cli })(t.ctx);
    expect(runs).toEqual([]);
    expect(t.lines.some((line) => line.startsWith('Saved plugins could not be read: '))).toBe(true);
  });

  it('offers the other programs and names one it refuses', async () => {
    const { cli, runs } = recordingCli();
    const saved = collectedJson('.agentnomad/programs.json', {
      programs: [
        { command: '_tool', npm: null },
        { command: 'ccstatusline', npm: { package: 'ccstatusline', version: '2.2.22' } },
      ],
    });
    const t = context([saved]);
    await afterRestore({ system: system(['/usr/bin/npm']), cli })(t.ctx);
    expect(runs).toEqual(['/usr/bin/npm install -g ccstatusline@2.2.22']);
    expect(
      t.lines.some(
        (line) => line.startsWith('A saved program entry was left out') && line.includes('_tool'),
      ),
    ).toBe(true);
  });

  it('warns when programs.json cannot be read', async () => {
    const { cli } = recordingCli();
    const file = collected('.agentnomad/programs.json', '[]');
    const t = context([file]);
    await afterRestore({ system: system(['/usr/bin/npm']), cli })(t.ctx);
    expect(t.lines.some((line) => line.startsWith('Saved programs could not be read: '))).toBe(
      true,
    );
  });
});
