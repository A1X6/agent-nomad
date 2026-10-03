import { readFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import * as z from 'zod';

import { runProgram } from '../../system/run-program.ts';
import type { Prompter, Reporter } from '../../ui/prompter.ts';
import type { MarketplaceEntry, PluginEntry, PluginManifest } from './plugins.ts';

/** Runs `claude` with arguments in a folder; project-scope installs write there. */
export interface ClaudeCli {
  run(
    args: readonly string[],
    cwd: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/** What is already on this PC, so nothing is added twice. */
export interface CurrentPlugins {
  readonly marketplaces: ReadonlySet<string>;
  /** `plugin@marketplace|scope`. */
  readonly installed: ReadonlySet<string>;
}

export interface PluginSyncPlan {
  readonly marketplaces: readonly MarketplaceEntry[];
  readonly plugins: readonly PluginEntry[];
  readonly alreadyInstalled: readonly PluginEntry[];
}

export interface PluginSyncResult {
  readonly installed: readonly string[];
  readonly failed: readonly { readonly what: string; readonly reason: string }[];
  readonly declined: readonly string[];
}

const installKey = (id: string, scope: string) => `${id}|${scope}`;

/** Only what is missing here: marketplaces not added yet, plugins not installed in that scope. */
export function planPluginSync(manifest: PluginManifest, current: CurrentPlugins): PluginSyncPlan {
  const plugins = manifest.plugins.filter(
    (plugin) => !current.installed.has(installKey(plugin.id, plugin.scope)),
  );
  const needed = new Set(plugins.map((plugin) => plugin.id.split('@')[1]));
  return {
    marketplaces: manifest.marketplaces.filter(
      (marketplace) => needed.has(marketplace.name) && !current.marketplaces.has(marketplace.name),
    ),
    plugins,
    alreadyInstalled: manifest.plugins.filter((plugin) =>
      current.installed.has(installKey(plugin.id, plugin.scope)),
    ),
  };
}

/** Reads this PC's `known_marketplaces.json` and `installed_plugins.json`. */
export async function readCurrentPlugins(
  baseDir: string,
  platform: NodeJS.Platform,
  projectDir?: string,
): Promise<CurrentPlugins> {
  const path = platform === 'win32' ? win32 : posix;
  const read = async (name: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(path.join(baseDir, 'plugins', name), 'utf8'));
    } catch {
      return null;
    }
  };
  const known = z.record(z.string(), z.unknown()).safeParse(await read('known_marketplaces.json'));
  const installed = z
    .looseObject({
      plugins: z.record(
        z.string(),
        z.array(z.looseObject({ scope: z.string(), projectPath: z.string().optional() })),
      ),
    })
    .safeParse(await read('installed_plugins.json'));
  const keys = new Set<string>();
  for (const [id, installs] of Object.entries(installed.success ? installed.data.plugins : {})) {
    for (const install of installs) {
      // A project install only counts for the project being restored.
      if (install.scope !== 'user' && install.projectPath !== projectDir) continue;
      keys.add(installKey(id, install.scope));
    }
  }
  return { marketplaces: new Set(Object.keys(known.success ? known.data : {})), installed: keys };
}

/** The JSON result `claude plugin install --json` prints on its last line. */
const InstallResultSchema = z.looseObject({ outcome: z.string(), message: z.string().optional() });

function installOutcome(stdout: string): { ok: boolean; message: string } | null {
  const last = stdout.trim().split(/\r?\n/).pop() ?? '';
  try {
    const parsed = InstallResultSchema.safeParse(JSON.parse(last));
    return parsed.success
      ? { ok: parsed.data.outcome === 'ok', message: parsed.data.message ?? '' }
      : null;
  } catch {
    return null;
  }
}

/** What pull's plan step asks about saved plugins (T61): nothing is installed here. */
export interface AskPluginSyncDeps {
  readonly manifest: PluginManifest;
  readonly current: CurrentPlugins;
  readonly prompter: Pick<Prompter, 'confirm'>;
  readonly reporter: Pick<Reporter, 'info' | 'warn'>;
  /** `--yes`: never ask; without `allowCommands` nothing is installed (T38). */
  readonly assumeYes?: boolean;
  /** `--allow-commands`: install the list, command-source plugins included, without asking. */
  readonly allowCommands?: boolean;
}

/** What the user agreed to install; installing it asks nothing. */
export interface PluginSyncChoice {
  /** Marketplaces to add first. */
  readonly marketplaces: readonly MarketplaceEntry[];
  /** Plugins to install, in order; a command-source one only after its own yes. */
  readonly plugins: readonly PluginEntry[];
  readonly declined: readonly string[];
}

export interface InstallPluginsDeps {
  readonly claude: ClaudeCli;
  readonly reporter: Pick<Reporter, 'success' | 'warn'>;
  /** Where project-scope plugins are installed; the home folder for a global setup. */
  readonly cwd: string;
  /** Turns an install failure into a clearer reason, e.g. "blocked by your organization" (T31). */
  readonly explainFailure?: (reason: string) => string;
}

export type SyncPluginsDeps = AskPluginSyncDeps & InstallPluginsDeps;

/**
 * The questions of a plugin reinstall (T29, T61): shows what is missing, asks once, and asks
 * again for each plugin built by running a command. Installs nothing.
 */
export async function askPluginSync(deps: AskPluginSyncDeps): Promise<PluginSyncChoice> {
  const plan = planPluginSync(deps.manifest, deps.current);
  const nothing: PluginSyncChoice = { marketplaces: [], plugins: [], declined: [] };
  if (plan.plugins.length === 0) {
    if (deps.manifest.plugins.length > 0)
      deps.reporter.info('All saved plugins are already installed.');
    return nothing;
  }

  const list = [
    ...plan.marketplaces.map(
      (marketplace) => `  + marketplace ${marketplace.name}  (${marketplace.add})`,
    ),
    ...plan.plugins.map(
      (plugin) =>
        `  + ${plugin.id}  (${plugin.scope}${plugin.commandSource ? ', runs a command to build' : ''})`,
    ),
  ];
  deps.reporter.info(['Plugins to reinstall with Claude Code:', ...list].join('\n'));
  const count = `${String(plan.plugins.length)} plugin${plan.plugins.length === 1 ? '' : 's'}`;
  const reinstall =
    deps.allowCommands === true ||
    (!deps.assumeYes && (await deps.prompter.confirm(`Reinstall ${count}?`, true)));
  if (!reinstall) {
    if (deps.assumeYes) {
      deps.reporter.warn(
        `Plugins were not reinstalled: --yes never installs or runs new code; add --allow-commands, or run pull without --yes to choose.`,
      );
    }
    return { ...nothing, declined: plan.plugins.map((plugin) => plugin.id) };
  }

  const plugins: PluginEntry[] = [];
  const declined: string[] = [];
  for (const plugin of plan.plugins) {
    // Its own question, unless --allow-commands already accepted code from the setup
    // (--yes alone never gets this far: it reinstalls nothing).
    const accept =
      !plugin.commandSource ||
      deps.allowCommands === true ||
      (await deps.prompter.confirm(
        `${plugin.id} is built by running a command from its marketplace. Allow it?`,
        false,
      ));
    if (accept) plugins.push(plugin);
    else declined.push(plugin.id);
  }
  return { marketplaces: plan.marketplaces, plugins, declined };
}

/**
 * Installs what the user agreed to (T29, T61): adds the marketplaces, then installs the
 * plugins with Claude Code's own commands. Asks nothing.
 */
export async function installPlugins(
  choice: PluginSyncChoice,
  deps: InstallPluginsDeps,
): Promise<PluginSyncResult> {
  const result = {
    installed: [] as string[],
    failed: [] as { what: string; reason: string }[],
    declined: [...choice.declined],
  };
  if (choice.plugins.length === 0) return result;

  const failedMarketplaces = new Set<string>();
  for (const marketplace of choice.marketplaces) {
    const run = await deps.claude.run(['plugin', 'marketplace', 'add', marketplace.add], deps.cwd);
    if (run.exitCode !== 0) {
      failedMarketplaces.add(marketplace.name);
      result.failed.push({
        what: `marketplace ${marketplace.name}`,
        reason: run.stderr.trim() || run.stdout.trim() || `exit code ${String(run.exitCode)}`,
      });
    }
  }

  for (const plugin of choice.plugins) {
    const marketplace = plugin.id.split('@')[1] ?? '';
    if (failedMarketplaces.has(marketplace)) {
      result.failed.push({
        what: plugin.id,
        reason: `marketplace ${marketplace} could not be added`,
      });
      continue;
    }
    const args = ['plugin', 'install', plugin.id, '--scope', plugin.scope, '--json'];
    if (plugin.commandSource) args.push('--yes');
    const run = await deps.claude.run(args, deps.cwd);
    const outcome = installOutcome(run.stdout);
    if (run.exitCode === 0 && (outcome === null || outcome.ok)) {
      result.installed.push(plugin.id);
    } else {
      const reason = outcome?.message || run.stderr.trim() || `exit code ${String(run.exitCode)}`;
      result.failed.push({ what: plugin.id, reason: deps.explainFailure?.(reason) ?? reason });
    }
  }

  if (result.installed.length > 0) {
    deps.reporter.success(`Reinstalled ${result.installed.join(', ')}.`);
  }
  for (const failure of result.failed)
    deps.reporter.warn(`Could not install ${failure.what}: ${failure.reason}`);
  return result;
}

/** Reinstalls saved plugins on this PC (T29): the questions, then the installs. */
export async function syncPlugins(deps: SyncPluginsDeps): Promise<PluginSyncResult> {
  return installPlugins(await askPluginSync(deps), deps);
}

type RunResult = Awaited<ReturnType<ClaudeCli['run']>>;

/** Starts a program without a shell (Node's `execFile`); `verbatim`: no quoting on Windows. */
export type StartProgram = (
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs: number;
    readonly verbatim: boolean;
  },
) => Promise<RunResult>;

const startProgram: StartProgram = async (file, args, options) => {
  const { exitCode, stdout, stderr } = await runProgram(file, args, {
    ...options,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { exitCode, stdout, stderr };
};

/** Windows launchers npm creates; they need `cmd.exe` to run. */
const SHIMS = new Set(['.cmd', '.bat']);
/**
 * What cmd.exe acts on in an argument, and any white space but a plain space. A space is
 * fine: such an argument is quoted, as a local marketplace folder like `C:\My Plugins` needs.
 */
const CMD_UNSAFE = /["&|<>^%!\p{Cc}]|[^\S ]/u;

/**
 * One argument on the cmd.exe line: as it is, or in quotes when it holds a space. Inside the
 * quotes only a backslash right before the closing quote means something (to the program's
 * argument parser), so trailing backslashes are doubled.
 */
const cmdArgument = (arg: string) =>
  arg.includes(' ') ? `"${arg.replace(/(\\+)$/, '$1$1')}"` : arg;

/** What cmd.exe still acts on inside the quotes around the launcher's path. */
const CMD_UNSAFE_PATH = /["%!\p{Cc}]/u;

/**
 * The real `claude` (or `npm`) command. Arguments come from a validated manifest. On Windows a
 * `.cmd` launcher runs through `cmd.exe` with one command line passed as written (Node would
 * escape the quotes in it): an argument with a space is quoted, and arguments cmd.exe would
 * read differently are refused.
 */
export function createClaudeCli(
  claudePath: string,
  system: {
    readonly platform: NodeJS.Platform;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
  options: { readonly timeoutMs?: number; readonly start?: StartProgram } = {},
): ClaudeCli {
  const shim = system.platform === 'win32' && SHIMS.has(win32.extname(claudePath).toLowerCase());
  const start = options.start ?? startProgram;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  return {
    run(args, cwd) {
      const common = { cwd, env: system.env, timeoutMs };
      if (!shim) return start(claudePath, args, { ...common, verbatim: false });
      if (
        CMD_UNSAFE_PATH.test(claudePath) ||
        args.some((arg) => arg === '' || CMD_UNSAFE.test(arg))
      ) {
        return Promise.resolve({
          exitCode: 1,
          stdout: '',
          stderr: 'Unsafe characters for cmd.exe',
        });
      }
      // `/s`: cmd.exe drops the outer quotes and runs the rest exactly as written.
      const line = `"${[`"${claudePath}"`, ...args.map(cmdArgument)].join(' ')}"`;
      return start('cmd.exe', ['/d', '/s', '/c', line], { ...common, verbatim: true });
    },
  };
}
