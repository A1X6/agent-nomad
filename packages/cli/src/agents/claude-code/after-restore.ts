import type { AfterRestoreContext, RestorePlanContext } from '../adapter.ts';
import { findExecutable, type ExecutableLookupSystem } from '../shared/detector-system.ts';
import { claudeConfigDir, findClaudeExecutable } from './detector.ts';
import {
  PLUGIN_VERSIONS_BUNDLE_PATH,
  PLUGINS_BUNDLE_PATH,
  PROGRAMS_BUNDLE_PATH,
} from './global-paths.ts';
import { explainPluginFailure, type ManagedSettings } from './managed-settings.ts';
import {
  askPluginSync,
  createProgramCli,
  installPlugins,
  readCurrentPlugins,
  type ProgramCli,
} from './plugin-sync.ts';
import {
  readPluginVersions,
  readSavedPlugins,
  readSavedPluginVersions,
  type PluginManifest,
  type PluginVersions,
} from './plugins.ts';
import { readSavedPrograms } from './programs.ts';

export interface AfterRestoreDeps {
  readonly system: ExecutableLookupSystem;
  /** Runs a found program (`claude`, `npm`); injected for tests. */
  readonly cli?: (path: string) => ProgramCli;
  /** Organization-managed settings on this PC (T31), read through the adapter (SOLID-01). */
  readonly managedSettings: () => Promise<ManagedSettings>;
}

/** What the follow-up's plan step gets: the setup, the prompter and the flags (T61). */
export type FollowUpPlanContext = Pick<
  RestorePlanContext,
  'target' | 'files' | 'prompter' | 'reporter' | 'assumeYes' | 'allowCommands' | 'parts'
>;

/** Carries out what the plan step decided; gets no prompter, so it never asks. */
export type FollowUp = (context: AfterRestoreContext) => Promise<void>;

const nothingToDo: FollowUp = () => Promise.resolve();

/** Marketplaces to add and plugins to install besides the ones in `plugins.json` (T98). */
type LocalPlugins = Pick<PluginManifest, 'marketplaces' | 'plugins'>;

/**
 * What pull does after writing a Claude Code setup (T34): reinstall its plugins (T29), offer
 * to install programs its hooks or status line need (T25). Every question is asked in the plan
 * step, before anything is written (T61); the follow-up it returns only installs what was
 * agreed to. Saved claude.ai skills are planned with the adapter's plan step (SEC-03).
 */
export function createClaudeCodeAfterRestore(deps: AfterRestoreDeps) {
  const cli = deps.cli ?? ((path: string) => createProgramCli(path, deps.system));

  /** The saved `plugins.json` (T29); `null` when there is none, or it cannot be read (said). */
  function savedPlugins(context: FollowUpPlanContext): PluginManifest | null {
    const file = context.files.find((entry) => entry.path === PLUGINS_BUNDLE_PATH);
    if (!file) return null;
    // Said, never dropped silently (BUG-01): the rest of the file is still offered.
    const saved = readSavedPlugins(file.content);
    if (!('value' in saved)) {
      context.reporter.warn(`Saved plugins could not be read: ${saved.problem}`);
      return null;
    }
    const { manifest, refused } = saved.value;
    for (const entry of refused) {
      context.reporter.warn(
        `A saved plugin entry was left out, as it is not safe to pass to Claude Code: ${entry}`,
      );
    }
    return manifest;
  }

  async function plugins(context: FollowUpPlanContext, local: LocalPlugins): Promise<FollowUp> {
    const saved = savedPlugins(context);
    // The plugins of saved local marketplaces (T98), added from the folders pull writes.
    const manifest: PluginManifest = {
      marketplaces: [...(saved?.marketplaces ?? []), ...local.marketplaces],
      plugins: [...(saved?.plugins ?? []), ...local.plugins],
      skipped: saved?.skipped ?? [],
    };
    if (manifest.plugins.length === 0) return nothingToDo;
    const claudePath = await findClaudeExecutable(deps.system);
    if (claudePath === null) {
      context.reporter.warn(
        `${String(manifest.plugins.length)} saved plugin(s) were not reinstalled: the claude command was not found. Install Claude Code, then pull again.`,
      );
      return nothingToDo;
    }
    const baseDir = claudeConfigDir(deps.system);
    const projectDir = context.target.kind === 'project' ? context.target.projectDir : undefined;
    const versions = savedVersions(context);
    const choice = await askPluginSync({
      manifest,
      current: await readCurrentPlugins(baseDir, deps.system.platform, projectDir),
      prompter: context.prompter,
      reporter: context.reporter,
      assumeYes: context.assumeYes,
      allowCommands: context.allowCommands,
    });
    if (choice.plugins.length === 0) return nothingToDo;
    return async ({ reporter }) => {
      const managed = await deps.managedSettings();
      await installPlugins(choice, {
        claude: cli(claudePath),
        reporter,
        cwd: projectDir ?? deps.system.homedir,
        explainFailure: (reason) => explainPluginFailure(reason, managed),
        ...(versions !== null && {
          versions: {
            saved: versions,
            installed: (installed) =>
              readPluginVersions(
                {
                  baseDir,
                  platform: deps.system.platform,
                  scope:
                    projectDir === undefined ? { kind: 'global' } : { kind: 'project', projectDir },
                },
                installed,
              ),
          },
        }),
      });
    };
  }

  /**
   * The saved `plugin-versions.json` (T100); `null` for a bundle without one (pushed before
   * T100, or with no known version) and for one that cannot be read, which is said.
   */
  function savedVersions(context: FollowUpPlanContext): PluginVersions | null {
    const file = context.files.find((entry) => entry.path === PLUGIN_VERSIONS_BUNDLE_PATH);
    if (!file) return null;
    const saved = readSavedPluginVersions(file.content);
    if ('value' in saved) return saved.value;
    context.reporter.warn(
      `Saved plugin versions could not be read, so changed versions are not named: ${saved.problem}`,
    );
    return null;
  }

  async function programs(context: FollowUpPlanContext): Promise<FollowUp> {
    const file = context.files.find((entry) => entry.path === PROGRAMS_BUNDLE_PATH);
    if (!file) return nothingToDo;
    const saved = readSavedPrograms(file.content);
    if (!('value' in saved)) {
      context.reporter.warn(`Saved programs could not be read: ${saved.problem}`);
      return nothingToDo;
    }
    for (const entry of saved.value.refused) {
      context.reporter.warn(
        `A saved program entry was left out, as it is not safe to pass to npm: ${entry}`,
      );
    }
    const installs: { readonly npmPath: string; readonly spec: string }[] = [];
    for (const program of saved.value.programs) {
      if ((await findExecutable(deps.system, program.command)) !== null) continue;
      if (program.npm === null) {
        context.reporter.warn(
          `Your hooks or status line run "${program.command}", which is not installed here. Install it for them to work.`,
        );
        continue;
      }
      const spec = `${program.npm.package}@${program.npm.version}`;
      const npmPath = await findExecutable(deps.system, 'npm');
      if (npmPath === null) {
        context.reporter.warn(
          `"${program.command}" is missing and npm was not found. Install it with: npm install -g ${spec}`,
        );
        continue;
      }
      const question = `"${program.command}" is not installed here. Install it with \`npm install -g ${spec}\`?`;
      if (!context.allowCommands) {
        if (context.assumeYes) {
          context.reporter.warn(
            `"${program.command}" is not installed here and was not installed: --yes never installs or runs new code; add --allow-commands, or run pull without --yes to choose. To install it yourself: npm install -g ${spec}`,
          );
          continue;
        }
        if (!(await context.prompter.confirm(question, true))) continue;
      }
      installs.push({ npmPath, spec });
    }
    if (installs.length === 0) return nothingToDo;
    return async ({ reporter }) => {
      for (const { npmPath, spec } of installs) {
        const run = await cli(npmPath).run(['install', '-g', spec], deps.system.homedir);
        if (run.exitCode === 0) reporter.success(`Installed ${spec}.`);
        else
          reporter.warn(
            `Could not install ${spec}: ${run.stderr.trim() || `exit code ${String(run.exitCode)}`}`,
          );
      }
    };
  }

  /**
   * Asks every question of the follow-up, in order, and returns what to do after writing.
   * `local`: the marketplaces and plugins of the saved local marketplaces pull writes (T98).
   */
  return async (
    context: FollowUpPlanContext,
    local: LocalPlugins = { marketplaces: [], plugins: [] },
  ): Promise<FollowUp> => {
    const steps = [await plugins(context, local), await programs(context)];
    return async (applyContext) => {
      for (const step of steps) await step(applyContext);
    };
  };
}
