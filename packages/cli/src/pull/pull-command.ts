import { type Bundle, type BundleScope, type SourceOs } from '@agentnomad/contracts';
import { createPathResolver, type BundleCodec, type CryptoService } from '@agentnomad/core';

import type {
  AgentAdapter,
  AgentRegistry,
  CollectedFile,
  ConflictChoice,
  ConflictResolver,
  DetectedAgent,
  ScopeTarget,
} from '../agents/adapter.ts';
import { sameForRestore } from '../agents/claude-code/restorer.ts';
import { agentVersionNotice } from '../agents/claude-code/version-stamp.ts';
import type { ApiClient } from '../api/api-client.ts';
import { NotLoggedInError } from '../api/api-errors.ts';
import { withSession } from '../auth/local-session.ts';
import type { CommandHandlers, PullOptions } from '../cli/commands.ts';
import { ProjectFolderError, projectFolderRefusal } from '../cli/project-folder.ts';
import { finishSetups, type SetupOutcome } from '../cli/setup-outcomes.ts';
import { planEnvRestore, writeEnvValues } from '../env/env-restore.ts';
import { ENV_BUNDLE_PATH, parseEnvSection, type EnvSection } from '../env/env-section.ts';
import type { EnvWriter } from '../env/shell-profile.ts';
import { fromBundleFiles, preferLocalEquivalents } from '../push/bundle-files.ts';
import type { SecretStore } from '../secrets/secret-store.ts';
import type { LocalState } from '../state/local-state.ts';
import type { Prompter, Reporter } from '../ui/prompter.ts';
import { reviewRunnable } from './command-review.ts';
import { downloadSetup, listSavedSetups, type SavedSetup } from './saved-setups.ts';

export interface PullDeps {
  readonly prompter: Prompter;
  readonly reporter: Reporter;
  readonly registry: () => AgentRegistry;
  readonly secrets: () => Promise<SecretStore>;
  readonly api: () => ApiClient;
  readonly crypto: () => Promise<CryptoService>;
  readonly codec: BundleCodec;
  readonly localState: () => LocalState;
  readonly envWriter: () => EnvWriter;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** A project is restored into this folder. */
  readonly cwd: string;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
}

/** What the apply step gets: no prompter, so it cannot ask anything (T59). */
export type PullApplyDeps = Omit<PullDeps, 'prompter'>;

/** The logged-in session and the data key, for the length of one pull. */
export interface PullKeys {
  readonly secrets: SecretStore;
  readonly crypto: CryptoService;
  readonly dataKey: Uint8Array;
}

type ScopeChoice = 'global' | 'project' | 'both';

/** An agent chosen for this pull, with what its detector found. */
interface ChosenAgent {
  readonly adapter: AgentAdapter;
  readonly version: string | null;
  readonly baseDir: string | null;
}

const chosenAgent = (entry: { adapter: AgentAdapter; found: DetectedAgent }): ChosenAgent => ({
  adapter: entry.adapter,
  version: entry.found.version,
  baseDir: entry.found.baseDir,
});

/** A setup downloaded, checked and reviewed. */
interface Prepared {
  readonly adapter: AgentAdapter;
  readonly setup: SavedSetup;
  readonly bundle: Bundle;
  readonly revision: number;
  readonly target: ScopeTarget;
  readonly files: CollectedFile[];
  /** What this PC has now, as the collector sees it. */
  readonly current: readonly CollectedFile[];
  /** The user declined commands it holds, so they were left out. */
  readonly declined: boolean;
}

/** One setup the plan will restore, with every answer the restore needs (T59). */
export interface PlannedRestore {
  readonly adapter: AgentAdapter;
  /** E.g. `Claude Code global setup`. */
  readonly name: string;
  readonly setup: SavedSetup;
  readonly revision: number;
  readonly sourceOs: SourceOs;
  readonly target: ScopeTarget;
  readonly files: readonly CollectedFile[];
  readonly declined: boolean;
  /** The answer for each file here that differs, by bundle path. */
  readonly conflicts: ReadonlyMap<string, ConflictChoice>;
  /** Saved environment values to add, already chosen. */
  readonly env: { readonly section: EnvSection; readonly toAdd: readonly string[] } | null;
}

/** Every answer pull needs, gathered before the first file is written (T59). */
export interface PullPlan {
  readonly restores: readonly PlannedRestore[];
  /** Setups already decided while planning: skipped. */
  readonly outcomes: readonly SetupOutcome[];
  /** The answer for every file from flags or "… all remaining files", if one was given. */
  readonly conflictAnswer: ConflictChoice | undefined;
}

type ConflictAnswer = ConflictChoice | 'merge-all' | 'overwrite-all';

/** `~/.claude.json`'s place in a bundle: only ever merged, never replaced. */
const CLAUDE_JSON_PATH = '.agentnomad/claude.json';

const sourceOsOf = (platform: NodeJS.Platform): SourceOs =>
  platform === 'darwin' || platform === 'win32' ? platform : 'linux';

const describe = (adapter: AgentAdapter, setup: SavedSetup) =>
  `${adapter.displayName} ${setup.projectName === null ? 'global setup' : `project "${setup.projectName}"`}`;

/**
 * Pull's plan step (T59): chooses saved setups, downloads and checks them, and asks every
 * question before anything is written: an older copy, what would run programs, each file
 * here that differs, and saved environment values. Without a terminal, a question the flags
 * leave open stops pull here (T46).
 */
export function createPullPlanner(deps: PullDeps) {
  const { prompter, reporter } = deps;

  async function chooseAgents(
    saved: readonly SavedSetup[],
    options: PullOptions,
  ): Promise<ChosenAgent[]> {
    const withSetups: { adapter: AgentAdapter; found: DetectedAgent }[] = [];
    for (const adapter of deps.registry().list()) {
      if (!saved.some((setup) => setup.agent === adapter.id)) continue;
      const found = await adapter.detector.detect();
      withSetups.push({ adapter, found });
    }
    if (options.agents) {
      return options.agents.map((id) => {
        const match = withSetups.find((entry) => entry.adapter.id === id);
        if (!match) throw new Error(`No saved setup for agent "${id}".`);
        return chosenAgent(match);
      });
    }
    if (withSetups.length <= 1 || options.yes) {
      return withSetups.map(chosenAgent);
    }
    const count = (id: string) => saved.filter((setup) => setup.agent === id).length;
    const chosen = await prompter.multiselect(
      'Which agents?',
      withSetups.map((entry) => ({
        value: entry.adapter.id,
        label: entry.adapter.displayName,
        hint: `${entry.found.installed ? 'installed' : 'not installed here'}, ${String(count(entry.adapter.id))} saved`,
      })),
      { required: true, initial: withSetups.map((entry) => entry.adapter.id) },
    );
    return withSetups.filter((entry) => chosen.includes(entry.adapter.id)).map(chosenAgent);
  }

  async function chooseSetups(
    agent: ChosenAgent,
    saved: readonly SavedSetup[],
    options: PullOptions,
  ): Promise<SavedSetup[]> {
    const { adapter } = agent;
    // A project is never restored into the home folder or the agent's own folder: its
    // `.claude/` there is the global setup (BUG-05).
    const refusal = projectFolderRefusal(deps.cwd, {
      homedir: deps.homedir,
      baseDir: agent.baseDir,
      agentName: adapter.displayName,
      platform: deps.platform,
    });
    if (options.project !== undefined && refusal !== null) {
      throw new ProjectFolderError(deps.cwd, refusal);
    }
    const mine = saved.filter((setup) => setup.agent === adapter.id);
    const global = mine.find((setup) => setup.projectName === null);
    const projects = mine.filter((setup) => setup.projectName !== null);

    let choice: ScopeChoice;
    if (options.global || options.project !== undefined) {
      choice =
        options.global && options.project !== undefined
          ? 'both'
          : options.global
            ? 'global'
            : 'project';
    } else if (projects.length === 0) {
      choice = 'global';
    } else if (!global) {
      if (refusal !== null) throw new ProjectFolderError(deps.cwd, refusal);
      choice = 'project';
    } else if (options.yes || refusal !== null) {
      // --yes alone restores the global setup; a project is picked with --project.
      choice = 'global';
    } else {
      choice = await prompter.select(`${adapter.displayName}: what to restore?`, [
        { value: 'global', label: 'Global setup' },
        { value: 'project', label: 'A project', hint: `into this folder: ${deps.cwd}` },
        { value: 'both', label: 'Both' },
      ]);
    }

    const chosen: SavedSetup[] = [];
    if (choice !== 'project') {
      if (!global) throw new Error(`There is no saved ${adapter.displayName} global setup.`);
      chosen.push(global);
    }
    if (choice !== 'global') {
      let project: SavedSetup | undefined;
      if (options.project !== undefined) {
        project = projects.find((setup) => setup.projectName === options.project);
        if (!project) {
          const names = projects.map((setup) => setup.projectName).join(', ') || 'none';
          throw new Error(
            `No saved ${adapter.displayName} project named "${options.project}". Saved: ${names}.`,
          );
        }
      } else if (projects.length === 1) {
        project = projects[0];
      } else {
        const remembered = await deps.localState().projectNameFor(deps.cwd);
        const pick = await prompter.select(
          'Which project? It is restored into this folder.',
          projects
            .map((setup) => ({
              value: setup.scopeKey,
              label: setup.projectName ?? '',
              ...(setup.projectName === remembered && { hint: 'saved from this folder' }),
            }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        );
        project = projects.find((setup) => setup.scopeKey === pick);
      }
      if (project) chosen.push(project);
    }
    return chosen;
  }

  /**
   * Per file: merge, overwrite, skip; "… all remaining" answers the rest; flags answer all.
   * `fixed()` is the answer that holds for every file from now on, if there is one.
   */
  function conflictAsker(options: PullOptions) {
    let sticky: ConflictChoice | undefined = options.conflict;
    const fixed = () => sticky ?? (options.yes ? 'merge' : undefined);
    const ask: ConflictResolver = async (path, question) => {
      const answer = fixed();
      if (answer !== undefined)
        return answer === 'overwrite' && !question.overwriteAllowed ? 'merge' : answer;
      const chosen: ConflictAnswer = await prompter.select(
        question.overwriteAllowed
          ? `${path} already exists here and is different.`
          : `${path === CLAUDE_JSON_PATH ? '~/.claude.json' : path}: add your MCP servers and preferences (your login and history stay)?`,
        [
          {
            value: 'merge',
            label: 'Merge',
            hint: 'JSON: combine keys; other files: keep yours, add theirs next to it',
          },
          ...(question.overwriteAllowed
            ? [{ value: 'overwrite' as const, label: 'Overwrite', hint: 'a backup is kept' }]
            : []),
          { value: 'skip', label: 'Skip', hint: 'leave it as it is' },
          { value: 'merge-all', label: 'Merge all remaining files' },
          ...(question.overwriteAllowed
            ? [{ value: 'overwrite-all' as const, label: 'Overwrite all remaining files' }]
            : []),
        ],
      );
      if (chosen === 'merge-all' || chosen === 'overwrite-all') {
        sticky = chosen === 'merge-all' ? 'merge' : 'overwrite';
        return sticky;
      }
      return chosen;
    };
    return { ask, fixed };
  }

  /**
   * Everything about one setup that comes before writing: download and check it, and ask
   * about an older copy and about what would run programs. An outcome: it is skipped.
   */
  async function prepareOne(
    adapter: AgentAdapter,
    version: string | null,
    setup: SavedSetup,
    keys: PullKeys,
    options: PullOptions,
  ): Promise<Prepared | SetupOutcome> {
    const spinner = reporter.spinner();
    spinner.start(`Downloading and decrypting the ${describe(adapter, setup)}…`);
    let downloaded;
    try {
      downloaded = await withSession(keys.secrets, () =>
        downloadSetup(setup, {
          api: deps.api(),
          crypto: keys.crypto,
          codec: deps.codec,
          dataKey: keys.dataKey,
        }),
      );
    } finally {
      spinner.stop();
    }
    const { bundle, revision } = downloaded;

    // Older than what this PC already had (T38): deleted and saved again from another PC,
    // or a server sending an old copy. Never restored without a yes from the user.
    const known = await deps.localState().revisionOf(adapter.id, setup.scopeKey);
    if (known !== null && revision < known) {
      const note = `The saved ${describe(adapter, setup)} is revision ${String(revision)}, older than revision ${String(known)} that this PC already had. Either it was deleted and saved again from another PC, or the server is sending an old copy.`;
      reporter.warn(note);
      if (options.yes || !(await prompter.confirm('Restore this older copy anyway?', false))) {
        reporter.info(`Skipped the ${describe(adapter, setup)}.`);
        return options.yes
          ? {
              setup: describe(adapter, setup),
              result: 'not-done',
              reason: `the saved copy (revision ${String(revision)}) is older than the one this PC had (revision ${String(known)})`,
            }
          : { setup: describe(adapter, setup), result: 'declined' };
      }
    }

    const versionNote = agentVersionNotice(adapter.displayName, bundle.agentVersion, version);
    if (versionNote !== null) reporter.warn(versionNote);

    const scope: BundleScope = bundle.scope;
    const target: ScopeTarget =
      scope.kind === 'global' ? { kind: 'global' } : { kind: 'project', projectDir: deps.cwd };
    const resolver = createPathResolver({ os: sourceOsOf(deps.platform), homeDir: deps.homedir });
    let files = fromBundleFiles(bundle.files, resolver);

    // What this PC has now: files that only differ in the home path's slashes stay as they
    // are, and anything that runs programs and is new here is confirmed before writing.
    const current = await adapter.collector.collect(target, { includeMemory: true });
    files = preferLocalEquivalents(bundle.files, files, current, resolver);
    const review = reviewRunnable(files, current);
    let declined = false;
    if (review.length > 0) {
      reporter.info(
        [
          `The ${describe(adapter, setup)} would add or change these, which run programs on this PC:`,
          ...review.map(
            (entry) =>
              `  ${entry.change === 'new' ? '+' : '~'} ${entry.label}: ${entry.command}${entry.change === 'changed' ? '  (changed)' : ''}`,
          ),
        ].join('\n'),
      );
      // --yes never accepts new code by itself (T38): only --allow-commands does.
      const allow =
        options.allowCommands === true ||
        (!options.yes && (await prompter.confirm('Allow them?', false)));
      if (!allow) {
        declined = true;
        const blocked = new Set(review.map((entry) => entry.file));
        files = files.filter((file) => !blocked.has(file.path));
        reporter.warn(
          `Skipped ${[...blocked].join(', ')}: they hold those commands or are run by them. The rest is restored.${options.yes ? ' --yes never accepts new commands; add --allow-commands to accept them.' : ''}`,
        );
      }
    }

    return { adapter, setup, bundle, revision, target, files, current, declined };
  }

  /**
   * The answer for each file that is here and differs, in the order the restorer meets them.
   * `~/.claude.json` is asked about whenever the setup has it: its other keys are not
   * collected, so whether it would change is only known while writing.
   */
  async function answerConflicts(
    { files, current }: Prepared,
    ask: ConflictResolver,
  ): Promise<Map<string, ConflictChoice>> {
    const answers = new Map<string, ConflictChoice>();
    for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const here = current.find((entry) => entry.path === file.path);
      const claudeJson = file.path === CLAUDE_JSON_PATH;
      if (here === undefined && !claudeJson) continue;
      if (
        here !== undefined &&
        sameForRestore(deps.platform, file.path, here.content, file.content)
      )
        continue;
      answers.set(file.path, await ask(file.path, { overwriteAllowed: !claudeJson }));
    }
    return answers;
  }

  return {
    /** `null`: nothing to pull (already said why). */
    async plan(options: PullOptions, keys: PullKeys): Promise<PullPlan | null> {
      const saved = await withSession(keys.secrets, () =>
        listSavedSetups(deps.api(), keys.crypto, keys.dataKey),
      );
      if (saved.length === 0) {
        reporter.info('Nothing is saved yet. Run `agentnomad push` on the PC that has your setup.');
        return null;
      }
      const agents = await chooseAgents(saved, options);
      if (agents.length === 0) {
        reporter.info('None of the saved setups are for an agent agentnomad supports here.');
        return null;
      }
      const chosen: { adapter: AgentAdapter; version: string | null; setups: SavedSetup[] }[] = [];
      for (const agent of agents) {
        const { adapter, version } = agent;
        chosen.push({ adapter, version, setups: await chooseSetups(agent, saved, options) });
      }

      const shown = new Set<string>();
      for (const { adapter } of chosen) {
        for (const notice of (await adapter.inspector?.notices('pull')) ?? []) {
          if (!shown.has(notice)) reporter.warn(notice);
          shown.add(notice);
        }
      }

      const outcomes: SetupOutcome[] = [];
      const prepared: Prepared[] = [];
      for (const { adapter, version, setups } of chosen) {
        for (const setup of setups) {
          const ready = await prepareOne(adapter, version, setup, keys, options);
          if ('result' in ready) outcomes.push(ready);
          else prepared.push(ready);
        }
      }

      const conflicts = conflictAsker(options);
      const restores: PlannedRestore[] = [];
      for (const ready of prepared) {
        const answers = await answerConflicts(ready, conflicts.ask);
        const envFile = ready.files.find((file) => file.path === ENV_BUNDLE_PATH);
        const section = envFile ? parseEnvSection(envFile.content) : null;
        const env = section
          ? {
              section,
              toAdd: (
                await planEnvRestore({
                  section,
                  env: deps.env,
                  writer: deps.envWriter(),
                  prompter,
                  reporter,
                  assumeYes: options.yes,
                  allowCommands: options.allowCommands === true,
                })
              ).toAdd,
            }
          : null;
        restores.push({
          adapter: ready.adapter,
          name: describe(ready.adapter, ready.setup),
          setup: ready.setup,
          revision: ready.revision,
          sourceOs: ready.bundle.sourceOs,
          target: ready.target,
          files: ready.files,
          declined: ready.declined,
          conflicts: answers,
          env,
        });
      }
      return { restores, outcomes, conflictAnswer: conflicts.fixed() };
    },
  };
}

/**
 * Pull's apply step (T59): writes each planned setup with the answers from the plan, adds the
 * chosen environment values and remembers the revision. It has no prompter, so it never
 * asks: a file that differs but was not asked about (only the restorer saw it) is left as it
 * is, and the setup is not done.
 */
export function createPullApplier(deps: PullApplyDeps) {
  const { reporter } = deps;

  async function applyOne(
    planned: PlannedRestore,
    conflictAnswer: ConflictChoice | undefined,
    options: PullOptions,
  ): Promise<SetupOutcome> {
    const { adapter, name, setup, revision, target, files, declined } = planned;
    const notAsked: string[] = [];
    const answer: ConflictResolver = (path, question) => {
      const chosen = planned.conflicts.get(path) ?? conflictAnswer;
      if (chosen === undefined) {
        notAsked.push(path);
        return Promise.resolve('skip');
      }
      return Promise.resolve(
        chosen === 'overwrite' && !question.overwriteAllowed ? 'merge' : chosen,
      );
    };
    const report = await adapter.restorer.restore(target, files, answer, {
      sourceOs: planned.sourceOs,
      assumeYes: options.yes,
    });
    for (const warning of report.warnings) reporter.warn(warning);
    const parts = [
      `${String(report.written.length)} written`,
      ...(report.skipped.length > 0 ? [`${String(report.skipped.length)} skipped`] : []),
      ...(report.backups.length > 0 ? [`${String(report.backups.length)} backed up first`] : []),
    ];
    reporter.success(`Restored the ${name}: ${parts.join(', ')} (revision ${String(revision)}).`);

    // Declined commands are noted, so a later push asks before dropping them (T46).
    await deps
      .localState()
      .setRevision(adapter.id, setup.scopeKey, revision, { partial: declined });
    if (setup.projectName !== null)
      await deps.localState().rememberProject(deps.cwd, setup.projectName);

    if (planned.env !== null && planned.env.toAdd.length > 0) {
      await writeEnvValues(
        { section: planned.env.section, writer: deps.envWriter(), reporter },
        planned.env.toAdd,
      );
    }

    if (notAsked.length === 0) return { setup: name, result: 'done' };
    reporter.warn(
      `Left as they are in the ${name}: ${notAsked.join(', ')}. They differ here, but pull did not ask about them before writing. Pull again with --merge or --overwrite to choose.`,
    );
    return {
      setup: name,
      result: 'not-done',
      reason: `not asked about ${notAsked.join(', ')}, so left as they are`,
    };
  }

  return {
    async apply(plan: PullPlan, options: PullOptions): Promise<SetupOutcome[]> {
      const outcomes: SetupOutcome[] = [];
      for (const planned of plan.restores) {
        outcomes.push(await applyOne(planned, plan.conflictAnswer, options));
      }
      return outcomes;
    },
  };
}

/**
 * `agentnomad pull` (T34): choose saved setups, download and decrypt them on this PC,
 * confirm what would run programs, restore with the user's merge / overwrite / skip
 * choices, then offer plugins, programs and environment variables. Plan, then apply (T59);
 * the agent's own follow-up (plugins, programs, account skills) runs last and still gets
 * the prompter, since the adapter interface hands it one. Exits with code 1 when a setup
 * was not restored (BUG-03).
 */
export function createPullCommand(deps: PullDeps): Pick<CommandHandlers, 'pull'> {
  const planner = createPullPlanner(deps);
  const applier = createPullApplier(deps);
  return {
    async pull(options) {
      const secrets = await deps.secrets();
      const [token, dataKeyText] = await Promise.all([
        secrets.get('session-token'),
        secrets.get('data-key'),
      ]);
      if (token === null || dataKeyText === null) throw new NotLoggedInError();
      const dataKey = new Uint8Array(Buffer.from(dataKeyText, 'base64'));
      try {
        const plan = await planner.plan(options, {
          secrets,
          crypto: await deps.crypto(),
          dataKey,
        });
        if (plan === null) return;
        const applied = await applier.apply(plan, options);
        for (const planned of plan.restores) {
          await planned.adapter.afterRestore?.({
            target: planned.target,
            files: planned.files,
            prompter: deps.prompter,
            reporter: deps.reporter,
            assumeYes: options.yes,
            allowCommands: options.allowCommands === true,
            ...(options.accountSkills !== undefined && { accountSkills: options.accountSkills }),
          });
        }
        finishSetups('pull', [...plan.outcomes, ...applied]);
      } finally {
        dataKey.fill(0);
      }
    },
  };
}
