import { describe, expect, it } from 'vitest';

import { fileManagedSettings, realisticPlugins } from './claude-code-plugin-fixtures.ts';
import { base, home, project, useProjectFolders } from './claude-code-project-fixtures.ts';
import { recordingReporter, scriptedPrompter } from './fakes.ts';
import {
  askPluginSync,
  explainPluginFailure,
  installPlugins,
  planPluginSync,
  readCurrentPlugins,
  type AskPluginSyncDeps,
  type InstallPluginsDeps,
  type PluginManifest,
  type ProgramCli,
} from '../src/index.ts';

useProjectFolders('agentnomad-plugin-sync-');

const savedManifest: PluginManifest = {
  marketplaces: [
    { name: 'brag', add: 'latent-spaces/brag' },
    { name: 'company', add: 'https://gitlab.example.com/team/plugins.git' },
  ],
  plugins: [
    { id: 'brag@brag', scope: 'user', commandSource: false },
    { id: 'builder@company', scope: 'user', commandSource: true },
    { id: 'lint@company', scope: 'project', commandSource: false },
  ],
  skipped: [],
};

function fakeClaude(failures: Record<string, string> = {}) {
  const runs: string[] = [];
  const claude: ProgramCli = {
    run: (args, cwd) => {
      runs.push(`${args.join(' ')} @ ${cwd}`);
      const key = args.join(' ');
      const failure = Object.entries(failures).find(([part]) => key.includes(part))?.[1];
      if (args[1] === 'install') {
        const outcome = failure
          ? { outcome: 'failed', message: failure }
          : { outcome: 'ok', message: 'Installed' };
        return Promise.resolve({
          exitCode: failure ? 1 : 0,
          stdout: `note\n${JSON.stringify(outcome)}`,
          stderr: '',
        });
      }
      return Promise.resolve({ exitCode: failure ? 1 : 0, stdout: '', stderr: failure ?? '' });
    },
  };
  return { claude, runs };
}

function run(options: {
  answers?: boolean[];
  failures?: Record<string, string>;
  current?: Parameters<typeof planPluginSync>[1];
  assumeYes?: boolean;
  allowCommands?: boolean;
}) {
  const { prompter, asked } = scriptedPrompter(options.answers ?? [true, true]);
  const { reporter, lines } = recordingReporter({ levels: false });
  const { claude, runs } = fakeClaude(options.failures);
  const deps: AskPluginSyncDeps & InstallPluginsDeps = {
    manifest: savedManifest,
    current: options.current ?? { marketplaces: new Set(), installed: new Set() },
    claude,
    prompter,
    reporter,
    cwd: '/work/app',
    ...(options.assumeYes !== undefined && { assumeYes: options.assumeYes }),
    ...(options.allowCommands !== undefined && { allowCommands: options.allowCommands }),
  };
  // As pull does it: the questions in the plan step, the installs after writing (T61).
  const done = askPluginSync(deps).then((choice) => installPlugins(choice, deps));
  return { done, asked, lines, runs };
}

describe('plugin reinstall on pull', () => {
  it('adds the marketplaces, then installs each plugin in its scope', async () => {
    const t = run({});
    expect(await t.done).toEqual({
      installed: ['brag@brag', 'builder@company', 'lint@company'],
      failed: [],
      declined: [],
    });
    expect(t.runs).toEqual([
      'plugin marketplace add latent-spaces/brag @ /work/app',
      'plugin marketplace add https://gitlab.example.com/team/plugins.git @ /work/app',
      'plugin install brag@brag --scope user --json @ /work/app',
      'plugin install builder@company --scope user --json --yes @ /work/app',
      'plugin install lint@company --scope project --json @ /work/app',
    ]);
  });

  it('asks once for the list, and separately for a plugin that runs a command', async () => {
    const t = run({ answers: [true, false] });
    const result = await t.done;
    expect(t.asked).toEqual([
      'Reinstall 3 plugins?',
      'builder@company is built by running a command from its marketplace. Allow it?',
    ]);
    expect(result.declined).toEqual(['builder@company']);
    expect(t.runs.some((line) => line.includes('builder'))).toBe(false);
  });

  it('does nothing when the user says no', async () => {
    const t = run({ answers: [false] });
    expect((await t.done).declined).toHaveLength(3);
    expect(t.runs).toEqual([]);
  });

  it('--yes alone installs nothing, not asked, and says how to allow it (T38)', async () => {
    const t = run({ answers: [], assumeYes: true });
    const result = await t.done;
    expect(t.asked).toEqual([]);
    expect(t.runs).toEqual([]);
    expect(result.declined).toEqual(['brag@brag', 'builder@company', 'lint@company']);
    expect(t.lines).toContain(
      'Plugins were not reinstalled: --yes never installs or runs new code; add --allow-commands, or run pull without --yes to choose.',
    );
  });

  it('--allow-commands installs every plugin, command-source too, without asking', async () => {
    const t = run({ answers: [], assumeYes: true, allowCommands: true });
    const result = await t.done;
    expect(t.asked).toEqual([]);
    expect(result.installed).toEqual(['brag@brag', 'builder@company', 'lint@company']);
  });

  it('skips what is already here', async () => {
    const t = run({
      current: {
        marketplaces: new Set(['brag', 'company']),
        installed: new Set(['brag@brag|user', 'builder@company|user']),
      },
    });
    await t.done;
    expect(t.runs).toEqual(['plugin install lint@company --scope project --json @ /work/app']);
  });

  it('reports failures with the reason, and skips plugins of a marketplace that failed', async () => {
    const t = run({
      failures: { 'gitlab.example.com': 'Repository not found', 'brag@brag': 'Network error' },
    });
    const result = await t.done;
    expect(result.installed).toEqual([]);
    expect(result.failed).toEqual([
      { what: 'marketplace company', reason: 'Repository not found' },
      { what: 'brag@brag', reason: 'Network error' },
      { what: 'builder@company', reason: 'marketplace company could not be added' },
      { what: 'lint@company', reason: 'marketplace company could not be added' },
    ]);
  });

  it('a failed marketplace gets the same clearer reason as a failed plugin (UX-03)', async () => {
    const { claude } = fakeClaude({ 'gitlab.example.com': 'blocked by strictKnownMarketplaces' });
    const { reporter } = recordingReporter();
    const result = await installPlugins(
      { marketplaces: savedManifest.marketplaces, plugins: savedManifest.plugins, declined: [] },
      { claude, reporter, cwd: '/work/app', explainFailure: (reason) => `explained: ${reason}` },
    );
    expect(result.failed[0]).toEqual({
      what: 'marketplace company',
      reason: 'explained: blocked by strictKnownMarketplaces',
    });
  });

  it('plans only what is missing', () => {
    expect(
      planPluginSync(savedManifest, {
        marketplaces: new Set(['brag']),
        installed: new Set(['brag@brag|user']),
      }),
    ).toEqual({
      marketplaces: [{ name: 'company', add: 'https://gitlab.example.com/team/plugins.git' }],
      plugins: savedManifest.plugins.slice(1),
      alreadyInstalled: [savedManifest.plugins[0]],
    });
  });

  it('reads what this PC already has', async () => {
    await realisticPlugins(home, project);
    const current = await readCurrentPlugins(base, process.platform, project);
    expect(current.marketplaces.has('brag')).toBe(true);
    expect(current.installed.has('brag@brag|user')).toBe(true);
    expect(current.installed.has('team-lint@company|project')).toBe(true);
    expect(current.installed.has('other@company|project')).toBe(false);
  });
});

describe('warnings (T31 done-when)', () => {
  const found = fileManagedSettings;

  it('a plugin blocked by policy gets a clear reason', async () => {
    const choice = {
      marketplaces: [],
      plugins: [{ id: 'tool@evil-market', scope: 'user' as const, commandSource: false }],
      declined: [],
    };
    const result = await installPlugins(choice, {
      claude: {
        run: () =>
          Promise.resolve({
            exitCode: 1,
            stdout: JSON.stringify({
              outcome: 'failed',
              message: 'Marketplace evil-market is blocked by strictKnownMarketplaces',
            }),
            stderr: '',
          }),
      },
      reporter: recordingReporter().reporter,
      cwd: '/',
      explainFailure: (reason) => explainPluginFailure(reason, found),
    });
    expect(result.failed[0]?.reason).toBe(
      "blocked by your organization's Claude Code policy (/etc/claude-code/managed-settings.json). Ask your admin to allow it. Details: Marketplace evil-market is blocked by strictKnownMarketplaces",
    );
  });
});
