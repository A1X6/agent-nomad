import { readdir } from 'node:fs/promises';

import type {
  AfterRestoreContext,
  CollectedFile,
  RestorePlanContext,
  Restorer,
} from '../adapter.ts';
import {
  ACCOUNT_SKILLS_PART,
  ACCOUNT_SKILLS_PREFIX,
  planAccountSkills,
  readSyncedSkills,
} from './account-skills.ts';
import {
  claudeConfigDir,
  findClaudeExecutable,
  findExecutable,
  type ExecutableLookupSystem,
} from './detector.ts';
import { createFileGatherer } from './file-gathering.ts';
import { PLUGINS_BUNDLE_PATH, PROGRAMS_BUNDLE_PATH } from './global-paths.ts';
import { explainPluginFailure, type ManagedSettings } from './managed-settings.ts';
import {
  askPluginSync,
  createProgramCli,
  installPlugins,
  readCurrentPlugins,
  type ProgramCli,
} from './plugin-sync.ts';
import { readSavedPlugins } from './plugins.ts';
import { readSavedPrograms } from './programs.ts';

export interface AfterRestoreDeps {
  readonly system: ExecutableLookupSystem;
  /** Runs a found program (`claude`, `npm`); injected for tests. */
  readonly cli?: (path: string) => ProgramCli;
  /** Writes saved claude.ai skills as local skills (T42), with the restorer's safety rules. */
  readonly restorer?: Restorer;
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

/**
 * What pull does after writing a Claude Code setup (T34): reinstall its plugins (T29), offer
 * to install programs its hooks or status line need (T25), and offer saved claude.ai skills
 * (T42). Every question is asked in the plan step, before anything is written (T61); the
 * follow-up it returns only installs what was agreed to.
 */
export function createClaudeCodeAfterRestore(deps: AfterRestoreDeps) {
  const cli = deps.cli ?? ((path: string) => createProgramCli(path, deps.system));

  async function plugins(context: FollowUpPlanContext): Promise<FollowUp> {
    const file = context.files.find((entry) => entry.path === PLUGINS_BUNDLE_PATH);
    if (!file) return nothingToDo;
    // Said, never dropped silently (BUG-01): the rest of the file is still offered.
    const saved = readSavedPlugins(file.content);
    if (!('value' in saved)) {
      context.reporter.warn(`Saved plugins could not be read: ${saved.problem}`);
      return nothingToDo;
    }
    const { manifest, refused } = saved.value;
    for (const entry of refused) {
      context.reporter.warn(
        `A saved plugin entry was left out, as it is not safe to pass to Claude Code: ${entry}`,
      );
    }
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
      });
    };
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
   * Which saved account skills can be added here: not one this PC gets from its own
   * claude.ai sync, never over a local skill. `incoming`: local skills the restore is about
   * to write, which count as local too.
   */
  async function accountSkillsHere(files: readonly CollectedFile[], incoming: readonly string[]) {
    const baseDir = claudeConfigDir(deps.system);
    const gatherer = createFileGatherer(deps.system.platform);
    const skillsDir = gatherer.path.join(baseDir, 'skills');
    const localNames = new Set([
      ...(await readdir(skillsDir, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory() && entry.name !== 'synced')
        .map((entry) => entry.name.toLowerCase()),
      ...incoming.map((name) => name.toLowerCase()),
    ]);
    const synced = await readSyncedSkills(gatherer, baseDir);
    return planAccountSkills(files, { syncedNames: synced.allNames, localNames });
  }

  /**
   * Saved claude.ai skills (T42): offered as local skills on a PC that does not already get
   * them from its own claude.ai sync, only after a yes. A skill with `` !`command` `` lines
   * runs those as a local skill (a synced one does not), so it is marked, and a flag alone
   * (no question asked) adds it only with --allow-commands too.
   */
  async function accountSkills(context: FollowUpPlanContext): Promise<FollowUp> {
    const { restorer } = deps;
    if (context.target.kind !== 'global' || !restorer) return nothingToDo;
    if (!context.files.some((file) => file.path.startsWith(ACCOUNT_SKILLS_PREFIX))) {
      return nothingToDo;
    }
    const restoredSkills = context.files.flatMap((file) => {
      const [folder, name, rest] = file.path.split('/');
      return folder === 'skills' && name !== undefined && name !== 'synced' && rest !== undefined
        ? [name]
        : [];
    });
    const plan = await accountSkillsHere(context.files, restoredSkills);
    if (plan.toAdd.length === 0 && plan.skipped.length === 0) return nothingToDo;

    context.reporter.info(
      [
        'Skills from your claude.ai account on the other PC:',
        ...plan.toAdd.map(
          (skill) =>
            `  + ${skill.name}${skill.runsCommands ? '  ⚠ runs commands as a local skill (! lines, ```! blocks or hooks)' : ''}`,
        ),
        ...plan.skipped.map((skill) => `  - ${skill.name}: skipped, ${skill.reason}`),
      ].join('\n'),
    );
    if (plan.toAdd.length === 0) return nothingToDo;

    const flag = context.parts.get(ACCOUNT_SKILLS_PART);
    const add =
      flag ??
      (!context.assumeYes &&
        (await context.prompter.confirm(
          'Add them as local skills? Only needed if this PC uses another claude.ai account, or none.',
          false,
        )));
    if (!add) {
      context.reporter.info(
        'Not added. To add them later: agentnomad pull --global --account-skills',
      );
      return nothingToDo;
    }
    // Answered by a flag, not a person: commands only run with --allow-commands as well.
    const blocked = new Set(
      flag !== undefined && !context.allowCommands
        ? plan.toAdd.filter((skill) => skill.runsCommands).map((skill) => skill.name)
        : [],
    );
    for (const name of blocked) {
      context.reporter.warn(
        `Skipped ${name}: it runs commands as a local skill. Add --allow-commands to add it anyway.`,
      );
    }
    const approved = new Set(
      plan.toAdd.filter((skill) => !blocked.has(skill.name)).map((skill) => skill.name),
    );
    if (approved.size === 0) return nothingToDo;

    return async ({ reporter }) => {
      // Checked again now that the setup is written: never over a local skill.
      const now = await accountSkillsHere(context.files, []);
      const added = now.toAdd.map((skill) => skill.name).filter((name) => approved.has(name));
      if (added.length === 0) return;
      const files = now.files.filter((file) => added.includes(file.path.split('/')[1] ?? ''));
      const report = await restorer.restore({ kind: 'global' }, files, () =>
        Promise.resolve('skip'),
      );
      for (const warning of report.warnings) reporter.warn(warning);
      reporter.success(
        `Added ${added.join(', ')} as local skills. If this PC later signs in to the claude.ai account they came from, they sync there too, and your local copy keeps the short name.`,
      );
    };
  }

  /** Asks every question of the follow-up, in order, and returns what to do after writing. */
  return async (context: FollowUpPlanContext): Promise<FollowUp> => {
    const steps = [await plugins(context), await programs(context), await accountSkills(context)];
    return async (applyContext) => {
      for (const step of steps) await step(applyContext);
    };
  };
}
