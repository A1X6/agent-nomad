import type {
  AgentAdapter,
  CollectedFile,
  Collector,
  OptionalPart,
  RestorePlanContext,
} from '../adapter.ts';
import { agentVersionNotice } from '../notices.ts';
import { underFolder } from '../shared/bundle-paths.ts';
import { nodeDetectorSystem, pathsOf } from '../shared/detector-system.ts';
import {
  ACCOUNT_PLUGINS_PART,
  askAccountPlugins,
  namesHere,
  readSyncedPlugins,
} from './account-plugins.ts';
import { ACCOUNT_SKILLS_PART, readSyncedSkills } from './account-skills.ts';
import { createClaudeCodeAfterRestore } from './after-restore.ts';
import { claudeConfigDir, createClaudeCodeDetector } from './detector.ts';
import { devModsNotice, readDevMods } from './dev-mods.ts';
import { CLAUDE_ENV_REFERENCES } from './env-files.ts';
import { createClaudeCodeGlobalCollector } from './global-collector.ts';
import { CLAUDE_JSON_BUNDLE_PATH } from './global-paths.ts';
import { findGit, planLocalMarketplaces, savedMarketplaceMods } from './local-marketplaces.ts';
import {
  detectManagedSettings,
  managedSettingsNotice,
  nodeManagedSettingsSystem,
  type ManagedSettingsSystem,
} from './managed-settings.ts';
import { planPluginDirs, savedPluginDirMods } from './plugin-dirs.ts';
import {
  askPluginFolders,
  findPluginValidator,
  pluginFolderChange,
  type PluginGateContext,
  type PluginValidator,
} from './plugin-review.ts';
import {
  idsWithPluginData,
  PLUGIN_DATA_PART,
  planPluginData,
  restoredPluginIds,
} from './plugin-data.ts';
import { readKnownMarketplaces } from './plugins.ts';
import { createProgramLocator } from './programs.ts';
import { createClaudeCodeProjectCollector } from './project-collector.ts';
import { createClaudeCodeRestorer } from './restorer.ts';
import {
  createClaudeRunningCheck,
  systemProcessLister,
  type ClaudeRunningCheck,
} from './running-claude.ts';
import { modsVersionNotice, skillsPluginFolders, skillsPluginsNote } from './skills-dir-plugins.ts';
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

  /** A copy of the user's own claude.ai plugins (T101), saved only after a yes. */
  const accountPlugins: OptionalPart = {
    id: ACCOUNT_PLUGINS_PART,
    scope: 'global',
    async available() {
      const synced = await readSyncedPlugins(pathsOf(options.platform), baseDir);
      return {
        names: synced.own.map((plugin) => plugin.name),
        problem: synced.problem,
        notice: synced.notice,
      };
    },
    question: (names) =>
      `Also save a copy of your ${String(names.length)} claude.ai plugin${names.length === 1 ? '' : 's'} (${names.join(', ')})? Your claude.ai account already syncs them; the copy is for PCs without that account.`,
    unreadable: (problem) => `${problem} Your claude.ai plugins were not saved.`,
    noneFound: 'No claude.ai plugins of your own were found on this PC.',
    flagHelp: {
      push: {
        include: 'save a copy of your own claude.ai plugins (normally synced by your account)',
        leaveOut: 'leave claude.ai plugins out',
      },
      pull: {
        include:
          'add saved claude.ai plugins as local plugins (for a PC without that claude.ai account)',
        leaveOut: 'do not add saved claude.ai plugins',
      },
    },
  };

  /** The data of the plugins a setup restores (T102), saved only after a yes. */
  const pluginData: OptionalPart = {
    id: PLUGIN_DATA_PART,
    scope: 'global',
    async available() {
      const ids = await restoredPluginIds(shared, { accountPlugins: true });
      return {
        names: await idsWithPluginData(pathsOf(options.platform), baseDir, ids),
        problem: null,
      };
    },
    question: (names) =>
      `Also save the data of ${String(names.length)} plugin${names.length === 1 ? '' : 's'} (${names.join(', ')})? It holds what plugins and mods keep, e.g. a mod's saved choices; only for plugins this setup puts back.`,
    unreadable: (problem) => `${problem} Plugin data was not saved.`,
    noneFound: 'No data was found for the plugins this setup puts back.',
    flagHelp: {
      push: {
        include: "save the data of the plugins this setup puts back (e.g. a mod's saved choices)",
        leaveOut: 'leave plugin data out',
      },
      pull: {
        include: 'put back saved plugin data, for plugins installed here',
        leaveOut: 'do not put back saved plugin data',
      },
    },
  };

  /**
   * Saved claude.ai plugins (T101) the user agreed to add, as `skills/<name>/` files next to
   * the setup's own, so the plugin review (T97) checks them like any plugin folder.
   */
  async function withAccountPlugins(context: RestorePlanContext) {
    const path = pathsOf(options.platform);
    const added = await askAccountPlugins(context, await namesHere(path, baseDir, context.files));
    return { files: [...context.files, ...added], added };
  }

  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    memoryDescription: 'what Claude learned: subagent and auto memory',
    detector: createClaudeCodeDetector(system),
    collector,
    restorer,
    envReferences: CLAUDE_ENV_REFERENCES,
    optionalParts: [accountSkills, accountPlugins, pluginData],
    inspector: {
      unknownEntries: (target) =>
        findUnknownEntries(target, {
          baseDir,
          platform: options.platform,
          homedir: options.homedir,
        }),
      async notices(command) {
        const notices = [managedSettingsNotice(await managedSettings(), command)];
        // Mods in development are never pushed (T103): push names them so they can be kept.
        if (command === 'push') {
          notices.push(devModsNotice(await readDevMods(pathsOf(options.platform), baseDir)));
        }
        return notices.filter((notice) => notice !== null);
      },
      versionNotice(savedWith, here, files) {
        const notes = [
          agentVersionNotice('Claude Code', savedWith, here),
          // Mods in saved local marketplaces and plugin folders count too (T104).
          modsVersionNotice(files, here, [
            ...savedMarketplaceMods(files),
            ...savedPluginDirMods(files),
          ]),
        ].filter((note) => note !== null);
        return notes.length === 0 ? null : notes.join('\n');
      },
      pushNotes(files) {
        const note = skillsPluginsNote(files);
        return note === null ? [] : [note];
      },
    },

    /**
     * Pull's Claude Code questions (T61), before anything is written: closing Claude Code
     * when `~/.claude.json` would change (it rewrites the file while open), plugin folders in
     * `skills/` (T97) with saved claude.ai plugins (T101), saved local marketplaces (T98),
     * then plugins, programs, claude.ai skills and plugin data (T102). `--yes` never waits: the
     * file is left with a warning.
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
      const global = context.target.kind === 'global';
      const withSaved = global
        ? await withAccountPlugins(context)
        : { files: context.files, added: [] };
      const plugins = global
        ? await reviewSkillsPlugins(withSaved.files, context)
        : { files: context.files, declined: false };
      const kept = skillsPluginFolders(withSaved.added).filter((folder) =>
        plugins.files.some((file) => underFolder(file.path, folder.folder)),
      );
      if (kept.length > 0) {
        context.reporter.info(
          `Adding ${kept.map((folder) => folder.id).join(', ')} as local plugins. If this PC later signs in to the claude.ai account they came from, Claude Code prefers the local copy.`,
        );
      }
      const local = await planLocalMarketplaces(context, {
        ...shared,
        known: await readKnownMarketplaces(baseDir, options.platform),
        validator,
        restorer,
        git: findGitHere,
      });
      const dirs = await planPluginDirs(context, {
        ...shared,
        validator,
        restorer,
        git: findGitHere,
      });
      // The settings as written: `CLAUDE_CODE_PLUGIN_DIRS` names the folders pull writes (T99).
      const files = dirs.withPluginDirs(plugins.files);
      const settingsRewritten = files.some((file, index) => file !== plugins.files[index]);
      const afterRestore = await followUp({ ...context, files }, local);
      const data = global
        ? await planPluginData(context, { baseDir, platform: options.platform, restorer })
        : null;
      return {
        // The folders first: Claude Code adds the marketplaces after the setup is written.
        async restore(onConflict, restoreContext) {
          // Settings pull did not ask about were the same here, so only the rewritten value
          // differs: written with a backup, as that is what pull is for.
          const answer: typeof onConflict = (path, question) =>
            settingsRewritten && path === 'settings.json' && !context.conflicts.has(path)
              ? Promise.resolve(
                  context.conflictAnswer ?? (question.overwriteAllowed ? 'overwrite' : 'merge'),
                )
              : onConflict(path, question);
          const reports = [
            await local.restore(onConflict),
            await dirs.restore(onConflict),
            await restorer.restore(context.target, files, answer, {
              ...restoreContext,
              leaveClaudeJson,
            }),
          ];
          return {
            written: reports.flatMap((report) => report.written),
            skipped: reports.flatMap((report) => report.skipped),
            backups: reports.flatMap((report) => report.backups),
            warnings: reports.flatMap((report) => report.warnings),
          };
        },
        // Plugin data last (T102): it goes only to plugins installed by then.
        async afterRestore(afterContext) {
          await afterRestore(afterContext);
          await data?.(afterContext);
        },
        declined: plugins.declined || local.declined || dirs.declined,
      };
    },
  };
}
