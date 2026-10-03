import type { AgentAdapter, Collector, OptionalPart } from '../adapter.ts';
import { agentVersionNotice } from '../notices.ts';
import { ACCOUNT_SKILLS_PART, readSyncedSkills } from './account-skills.ts';
import { createClaudeCodeAfterRestore } from './after-restore.ts';
import { claudeConfigDir, createClaudeCodeDetector, nodeDetectorSystem } from './detector.ts';
import { createFileGatherer } from './file-gathering.ts';
import { createClaudeCodeGlobalCollector } from './global-collector.ts';
import { CLAUDE_JSON_BUNDLE_PATH } from './global-paths.ts';
import {
  detectManagedSettings,
  managedSettingsNotice,
  nodeManagedSettingsSystem,
  type ManagedSettingsSystem,
} from './managed-settings.ts';
import { createProgramLocator } from './programs.ts';
import { createClaudeCodeProjectCollector } from './project-collector.ts';
import { createClaudeCodeRestorer } from './restorer.ts';
import {
  createClaudeRunningCheck,
  systemProcessLister,
  type ClaudeRunningCheck,
} from './running-claude.ts';
import { findUnknownEntries } from './unknown-files.ts';

export interface ClaudeCodeAdapterOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
  /** Defaults to the real process list. */
  readonly isClaudeRunning?: ClaudeRunningCheck;
  /** Where organization-managed settings are read (T31); defaults to this PC (SOLID-01). */
  readonly managedSystem?: ManagedSettingsSystem;
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

  const global = createClaudeCodeGlobalCollector({
    ...shared,
    customConfigDir,
    findProgram: createProgramLocator(system),
  });
  const project = createClaudeCodeProjectCollector({ ...shared, env: options.env });
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

  /** A copy of the user's own claude.ai skills (T42), saved only after a yes. */
  const accountSkills: OptionalPart = {
    id: ACCOUNT_SKILLS_PART,
    scope: 'global',
    async available() {
      const synced = await readSyncedSkills(createFileGatherer(options.platform), baseDir);
      return { names: synced.own.map((skill) => skill.name), problem: synced.problem };
    },
    question: (names) =>
      `Also save a copy of your ${String(names.length)} claude.ai skill${names.length === 1 ? '' : 's'} (${names.join(', ')})? Your claude.ai account already syncs them; the copy is for PCs without that account.`,
    unreadable: (problem) => `${problem} Your claude.ai skills were not saved.`,
    noneFound: 'No claude.ai skills of your own were found on this PC.',
  };

  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    memoryDescription: 'what Claude learned: subagent and auto memory',
    detector: createClaudeCodeDetector(system),
    collector,
    restorer,
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
    },

    /**
     * Pull's Claude Code questions (T61), before anything is written: closing Claude Code
     * when `~/.claude.json` would change (it rewrites the file while open), then plugins,
     * programs and claude.ai skills. `--yes` never waits: the file is left with a warning.
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
      const afterRestore = await followUp(context);
      return {
        restore: (onConflict, restoreContext) =>
          restorer.restore(context.target, context.files, onConflict, {
            ...restoreContext,
            leaveClaudeJson,
          }),
        afterRestore,
      };
    },
  };
}
