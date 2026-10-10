import type { AgentAdapter, CollectedFile, Collector, OptionalPart } from '../adapter.ts';
import { agentVersionNotice } from '../notices.ts';
import { underFolder } from '../shared/bundle-paths.ts';
import { nodeDetectorSystem, pathsOf } from '../shared/detector-system.ts';
import { ACCOUNT_SKILLS_PART, readSyncedSkills } from './account-skills.ts';
import { createClaudeCodeAfterRestore } from './after-restore.ts';
import { claudeConfigDir, createClaudeCodeDetector } from './detector.ts';
import { CLAUDE_ENV_REFERENCES } from './env-files.ts';
import { createClaudeCodeGlobalCollector } from './global-collector.ts';
import { CLAUDE_JSON_BUNDLE_PATH } from './global-paths.ts';
import { findGit, planLocalMarketplaces } from './local-marketplaces.ts';
import {
  detectManagedSettings,
  managedSettingsNotice,
  nodeManagedSettingsSystem,
  type ManagedSettingsSystem,
} from './managed-settings.ts';
import {
  askPluginFolders,
  findPluginValidator,
  pluginFolderChange,
  type PluginGateContext,
  type PluginValidator,
} from './plugin-review.ts';
import { readKnownMarketplaces } from './plugins.ts';
import { createProgramLocator } from './programs.ts';
import { createClaudeCodeProjectCollector } from './project-collector.ts';
import { createClaudeCodeRestorer } from './restorer.ts';
import {
  createClaudeRunningCheck,
  systemProcessLister,
  type ClaudeRunningCheck,
} from './running-claude.ts';
import { skillsPluginFolders, skillsPluginsNote } from './skills-dir-plugins.ts';
import { findUnknownEntries } from './unknown-files.ts';

export interface ClaudeCodeAdapterOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
  /** Defaults to the real process list. */
  readonly isClaudeRunning?: ClaudeRunningCheck;
  /** Where organization-managed settings are read (T31); defaults to this PC (SOLID-01). */
  readonly managedSystem?: ManagedSettingsSystem;
  /** Runs `claude plugin validate` for pull's plugin review (T97); defaults to this PC's. */
  readonly pluginValidator?: PluginValidator;
}

/**
 * The Claude Code adapter (T28): the detector (T24), the global and project collectors
 * (T25, T26), the restorer (T27) and pull's Claude Code questions (T61) for this PC, behind
 * the AgentAdapter interface.
 */
export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions): AgentAdapter {
  const system = nodeDetectorSystem(options.env, options.homedir, options.platform);
  const baseDir = claudeConfigDir(system);
  const customConfigDir = (options.env['CLAUDE_CONFIG_DIR']?.trim() ?? '') !== '';
  const shared = { baseDir, homedir: options.homedir, platform: options.platform };
  const managedSystem =
    options.managedSystem ?? nodeManagedSettingsSystem(options.env, baseDir, options.platform);
  const managedSettings = () => detectManagedSettings(managedSystem);
  const isClaudeRunning =
    options.isClaudeRunning ??
    createClaudeRunningCheck(systemProcessLister({ platform: options.platform, env: options.env }));

  const findGitHere = () => findGit(system);
  const global = createClaudeCodeGlobalCollector({
    ...shared,
    customConfigDir,
    findProgram: createProgramLocator(system),
    findGit: findGitHere,
  });
  const project = createClaudeCodeProjectCollector({
    ...shared,
    env: options.env,
    findGit: findGitHere,
  });
  const collector: Collector = {
    collect: (target, collectOptions) =>
      (target.kind === 'global' ? global : project).collect(target, collectOptions),
  };

  const restorer = createClaudeCodeRestorer({
    ...shared,
    env: options.env,
    customConfigDir,
    isClaudeRunning,
  });
  const followUp = createClaudeCodeAfterRestore({ system, restorer, managedSettings });
  const validator = async () => options.pluginValidator ?? (await findPluginValidator(system));

  /**
   * The plugin folders in `skills/` that a global setup would add or change (T97), reviewed and
   * asked about; the files of the declined ones are left out.
   */
  async function reviewSkillsPlugins(
    files: readonly CollectedFile[],
    gate: PluginGateContext,
  ): Promise<{ files: readonly CollectedFile[]; declined: boolean }> {
    const path = pathsOf(options.platform);
    const toReview = [];
    for (const folder of skillsPluginFolders(files)) {
      const change = await pluginFolderChange(path.join(baseDir, 'skills', folder.name), folder);
      if (change !== null) toReview.push({ folder, change });
    }
    if (toReview.length === 0) return { files, declined: false };
    const accepted = await askPluginFolders(toReview, await validator(), gate);
    const leftOut = toReview
      .map(({ folder }) => folder.folder)
      .filter((folder) => !accepted.has(folder));
    return {
      files: files.filter((file) => !leftOut.some((folder) => underFolder(file.path, folder))),
      declined: leftOut.length > 0,
    };
  }

  /** A copy of the user's own claude.ai skills (T42), saved only after a yes. */
  const accountSkills: OptionalPart = {
    id: ACCOUNT_SKILLS_PART,
    scope: 'global',
    async available() {
      const synced = await readSyncedSkills(pathsOf(options.platform), baseDir);
      return {
        names: synced.own.map((skill) => skill.name),
        problem: synced.problem,
        notice: synced.notice,
      };
    },
    question: (names) =>
      `Also save a copy of your ${String(names.length)} claude.ai skill${names.length === 1 ? '' : 's'} (${names.join(', ')})? Your claude.ai account already syncs them; the copy is for PCs without that account.`,
    unreadable: (problem) => `${problem} Your claude.ai skills were not saved.`,
    noneFound: 'No claude.ai skills of your own were found on this PC.',
    flagHelp: {
      push: {
        include: 'save a copy of your own claude.ai skills (normally synced by your account)',
        leaveOut: 'leave claude.ai skills out',
      },
      pull: {
        include:
          'add saved claude.ai skills as local skills (for a PC without that claude.ai account)',
        leaveOut: 'do not add saved claude.ai skills',
      },
    },
  };

  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    memoryDescription: 'what Claude learned: subagent and auto memory',
    detector: createClaudeCodeDetector(system),
    collector,
    restorer,
    envReferences: CLAUDE_ENV_REFERENCES,
    optionalParts: [accountSkills],
    inspector: {
      unknownEntries: (target) =>
        findUnknownEntries(target, {
          baseDir,
          platform: options.platform,
          homedir: options.homedir,
        }),
      async notices(command) {
        const notice = managedSettingsNotice(await managedSettings(), command);
        return notice === null ? [] : [notice];
      },
      versionNotice: (savedWith, here) => agentVersionNotice('Claude Code', savedWith, here),
      pushNotes(files) {
        const note = skillsPluginsNote(files);
        return note === null ? [] : [note];
      },
    },

    /**
     * Pull's Claude Code questions (T61), before anything is written: closing Claude Code
     * when `~/.claude.json` would change (it rewrites the file while open), plugin folders in
     * `skills/` (T97), saved local marketplaces (T98), then plugins, programs and claude.ai
     * skills. `--yes` never waits: the file is left with a warning.
     */
    async planRestore(context) {
      let leaveClaudeJson = false;
      const change = await restorer.claudeJsonChange(context.files);
      // An unanswered file is left as it is, like a skip.
      const answer = context.conflicts.get(CLAUDE_JSON_BUNDLE_PATH) ?? context.conflictAnswer;
      const merging = change === 'merge' && answer !== undefined && answer !== 'skip';
      if (!context.assumeYes && (change === 'new' || merging)) {
        while (await isClaudeRunning()) {
          const choice = await context.prompter.select(
            'Claude Code (or the Claude app) is running and rewrites ~/.claude.json while open.',
            [
              { value: 'retry', label: 'I closed it, continue' },
              { value: 'skip', label: 'Skip ~/.claude.json this time' },
            ],
          );
          if (choice === 'skip') {
            leaveClaudeJson = true;
            break;
          }
        }
      }
      const plugins =
        context.target.kind === 'global'
          ? await reviewSkillsPlugins(context.files, context)
          : { files: context.files, declined: false };
      const local = await planLocalMarketplaces(context, {
        ...shared,
        known: await readKnownMarketplaces(baseDir, options.platform),
        validator,
        restorer,
        git: findGitHere,
      });
      const afterRestore = await followUp({ ...context, files: plugins.files }, local);
      return {
        // The marketplace folders first: Claude Code adds them after the setup is written.
        async restore(onConflict, restoreContext) {
          const folders = await local.restore(onConflict);
          const setup = await restorer.restore(context.target, plugins.files, onConflict, {
            ...restoreContext,
            leaveClaudeJson,
          });
          return {
            written: [...folders.written, ...setup.written],
            skipped: [...folders.skipped, ...setup.skipped],
            backups: [...folders.backups, ...setup.backups],
            warnings: [...folders.warnings, ...setup.warnings],
          };
        },
        afterRestore,
        declined: plugins.declined || local.declined,
      };
    },
  };
}
