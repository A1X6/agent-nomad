import { basename } from 'node:path';

import {
  BUNDLE_FORMAT_VERSION,
  MAX_BUNDLE_BYTES,
  ProjectNameSchema,
  type Bundle,
  toBase64,
  toHex,
  type BundleScope,
} from '@agentnomad/contracts';
import {
  createPathResolver,
  encryptProjectName,
  scopeKeyFor,
  sealBundle,
  sourceOsOf,
  type BundleCodec,
  type CryptoService,
} from '@agentnomad/core';

import {
  chosenAgent,
  type AgentAdapter,
  type AgentRegistry,
  type ChosenAgent,
  type CollectedFile,
  type ScopeTarget,
} from '../agents/adapter.ts';
import { showNotices, unknownEntriesNotice } from '../agents/notices.ts';
import type { ApiClient } from '../api/api-client.ts';
import { ApiError } from '../api/api-errors.ts';
import { readDataKey, withSession } from '../auth/local-session.ts';
import type { CommandHandlers, PushOptions } from '../cli/commands.ts';
import { ProjectFolderError, projectFolderRefusal } from '../cli/project-folder.ts';
import { finishSetups, setupLabel, type SetupOutcome } from '../cli/setup-outcomes.ts';
import { scanEnvReferences } from '../env/env-references.ts';
import { chooseEnvValues, envSectionFile } from '../env/env-section.ts';
import type { SecretStore } from '../secrets/secret-store.ts';
import type { LocalState } from '../state/local-state.ts';
import { listSavedRevisions } from '../pull/saved-setups.ts';
import { formatSize } from '../ui/format-size.ts';
import type { Prompter, Reporter } from '../ui/prompter.ts';
import { toBundleFiles } from './bundle-files.ts';

export interface PushDeps {
  readonly prompter: Prompter;
  readonly reporter: Reporter;
  readonly registry: () => AgentRegistry;
  readonly secrets: () => Promise<SecretStore>;
  readonly api: () => ApiClient;
  readonly crypto: () => Promise<CryptoService>;
  readonly codec: BundleCodec;
  readonly localState: () => LocalState;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The folder push runs in: the project, when a project is chosen. */
  readonly cwd: string;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
}

/** What the apply step gets: no prompter, so it cannot ask anything (T59). */
export type PushApplyDeps = Omit<PushDeps, 'prompter'>;

/** What push says without a login: its own wording, kept as it was (carry-over D). */
const NOT_LOGGED_IN_ON_THIS_PC = 'You are not logged in on this PC. Run `agentnomad login` first.';

/** The logged-in session and the data key, for the length of one push. */
export interface PushKeys {
  readonly secrets: SecretStore;
  readonly crypto: CryptoService;
  readonly dataKey: Uint8Array;
}

type ScopeChoice = 'global' | 'project' | 'both';

/** One save: an agent and a scope. */
interface PushItem {
  readonly adapter: AgentAdapter;
  readonly version: string | null;
  readonly scope: BundleScope;
  readonly target: ScopeTarget;
}

/** What goes into every setup: memory, and per agent the optional parts chosen (T61). */
interface Contents {
  readonly includeMemory: boolean;
  readonly include: ReadonlyMap<AgentAdapter, ReadonlySet<string>>;
}

/** One upload the plan decided on: the bundle and the revision it replaces on the server. */
export interface PlannedUpload {
  readonly adapter: AgentAdapter;
  /** E.g. `Claude Code global setup`. */
  readonly setup: string;
  readonly scope: BundleScope;
  readonly scopeKey: string;
  readonly bundle: Omit<Bundle, 'revision'>;
  readonly expectedRevision: number;
}

/** Every answer push needs, gathered before the first upload (T59). */
export interface PushPlan {
  readonly uploads: readonly PlannedUpload[];
  /** Setups already decided while planning: nothing to save, or skipped. */
  readonly outcomes: readonly SetupOutcome[];
}

const describe = (item: PushItem) =>
  setupLabel(item.adapter.displayName, item.scope.kind === 'global' ? null : item.scope.name);

/**
 * Push's plan step (T59): asks every question (agents, scopes, project name, memory, the
 * agents' optional parts, environment values, replacing a newer copy, pushing after a partial
 * pull), collects each setup and decides what happens to it. Nothing is uploaded here.
 * Without a terminal, a question the flags leave open stops push here, before anything is
 * saved (T46).
 */
export function createPushPlanner(deps: PushDeps) {
  const { prompter, reporter } = deps;

  async function chooseAgents(options: PushOptions): Promise<ChosenAgent[]> {
    const registry = deps.registry();
    const detected = await Promise.all(
      registry.list().map(async (adapter) => ({ adapter, found: await adapter.detector.detect() })),
    );
    const installed = detected.filter((entry) => entry.found.installed);
    if (options.agents) {
      return options.agents.map((id) => {
        const match = detected.find((entry) => entry.adapter.id === id);
        if (!match)
          throw new Error(
            `Unknown agent "${id}". Run \`agentnomad agents\` to see the supported ones.`,
          );
        if (!match.found.installed)
          throw new Error(`${match.adapter.displayName} is not installed on this PC.`);
        return chosenAgent(match);
      });
    }
    if (installed.length === 0) return [];
    if (installed.length === 1 || options.yes) {
      return installed.map(chosenAgent);
    }
    const chosen = await prompter.multiselect(
      'Which agents?',
      installed.map((entry) => ({
        value: entry.adapter.id,
        label: entry.adapter.displayName,
        ...(entry.found.version !== null && { hint: entry.found.version }),
      })),
      { required: true, initial: installed.map((entry) => entry.adapter.id) },
    );
    return installed.filter((entry) => chosen.includes(entry.adapter.id)).map(chosenAgent);
  }

  async function chooseScope(agent: ChosenAgent, options: PushOptions): Promise<ScopeChoice> {
    const { adapter } = agent;
    // The home folder and the agent's own folder are never a project: their `.claude/` is the
    // global setup (BUG-05).
    const refusal = projectFolderRefusal(deps.cwd, {
      homedir: deps.homedir,
      baseDir: agent.baseDir,
      agentName: adapter.displayName,
      platform: deps.platform,
    });
    if (options.project !== undefined && refusal !== null) {
      throw new ProjectFolderError(deps.cwd, refusal);
    }
    if (options.global && options.project !== undefined) return 'both';
    if (options.global) return 'global';
    if (options.project !== undefined) return 'project';
    if (refusal !== null || options.yes) return 'global';
    return prompter.select(`${adapter.displayName}: what to save?`, [
      { value: 'global', label: 'Global setup', hint: 'your settings, skills, agents, commands…' },
      { value: 'project', label: 'This project', hint: deps.cwd },
      { value: 'both', label: 'Both' },
    ]);
  }

  /**
   * The folder's saved name, the `--project` name, or a new one the user types once. The
   * apply step remembers it once the project is saved, so a cancelled push forgets it (UX-03).
   */
  async function projectName(options: PushOptions): Promise<string> {
    const state = deps.localState();
    return (
      (options.project ??
        (await state.projectNameFor(deps.cwd)) ??
        (
          await prompter.text('Name this project (you will pick it by this name on other PCs)', {
            placeholder: basename(deps.cwd),
            validate: (value) => {
              const parsed = ProjectNameSchema.safeParse(value.trim() || basename(deps.cwd));
              return parsed.success ? undefined : parsed.error.issues[0]?.message;
            },
          })
        ).trim()) ||
      basename(deps.cwd)
    );
  }

  /** Each chosen agent with its scopes: one item per setup to save. */
  async function chooseItems(
    agents: readonly ChosenAgent[],
    options: PushOptions,
  ): Promise<PushItem[]> {
    const items: PushItem[] = [];
    let name: string | null = null;
    for (const agent of agents) {
      const { adapter, version } = agent;
      const choice = await chooseScope(agent, options);
      if (choice !== 'project')
        items.push({ adapter, version, scope: { kind: 'global' }, target: { kind: 'global' } });
      if (choice !== 'global') {
        name ??= await projectName(options);
        items.push({
          adapter,
          version,
          scope: { kind: 'project', name },
          target: { kind: 'project', projectDir: deps.cwd },
        });
      }
    }
    return items;
  }

  /**
   * Memory, and each agent's optional parts (T61), e.g. Claude Code's copy of the user's own
   * claude.ai skills for the global setup (T42).
   */
  async function chooseContents(
    agents: readonly { adapter: AgentAdapter }[],
    items: readonly PushItem[],
    options: PushOptions,
  ): Promise<Contents> {
    const described = [
      ...new Set(agents.flatMap(({ adapter }) => adapter.memoryDescription ?? [])),
    ].join('; ');
    const includeMemory =
      options.memory ??
      (options.yes
        ? false
        : await prompter.confirm(
            `Include memory${described === '' ? '' : ` (${described})`}?`,
            false,
          ));

    // Each part is only asked about when there is something, and only for its own scope.
    const include = new Map<AgentAdapter, Set<string>>();
    for (const { adapter } of agents) {
      const chosen = new Set<string>();
      include.set(adapter, chosen);
      for (const part of adapter.optionalParts ?? []) {
        const flag = options.parts?.get(part.id);
        const saving = items.some(
          (item) => item.adapter === adapter && item.scope.kind === part.scope,
        );
        if (!saving || flag === false) continue;
        const found = await part.available();
        if (found.problem) reporter.warn(part.unreadable(found.problem));
        if (found.names.length > 0) {
          const yes =
            flag ?? (!options.yes && (await prompter.confirm(part.question(found.names), false)));
          if (yes) chosen.add(part.id);
        } else if (flag === true) {
          reporter.info(part.noneFound);
        }
      }
    }
    return { includeMemory, include };
  }

  /** Collects one setup and asks which environment values go with it; `null`: nothing to save. */
  async function collectItem(
    item: PushItem,
    contents: Contents,
    options: PushOptions,
  ): Promise<Omit<Bundle, 'revision'> | null> {
    const leftOut: string[] = [];
    const parts = new Set(
      (item.adapter.optionalParts ?? [])
        .filter(
          (part) =>
            part.scope === item.scope.kind && contents.include.get(item.adapter)?.has(part.id),
        )
        .map((part) => part.id),
    );
    const collected: CollectedFile[] = [
      ...(await item.adapter.collector.collect(item.target, {
        includeMemory: contents.includeMemory,
        include: parts,
        onSkipped: (path, reason) => leftOut.push(`  - ${path}: ${reason}`),
      })),
    ];
    if (leftOut.length > 0) reporter.warn([`${describe(item)}: left out`, ...leftOut].join('\n'));
    const unknown = unknownEntriesNotice(
      item.adapter.displayName,
      (await item.adapter.inspector?.unknownEntries(item.target)) ?? [],
    );
    if (unknown !== null) reporter.warn(`${describe(item)}: ${unknown}`);
    if (collected.length === 0) {
      reporter.info(`Nothing to save for the ${describe(item)}.`);
      return null;
    }

    const envSection = options.yes
      ? null
      : await chooseEnvValues({
          scan: scanEnvReferences(collected, item.adapter.envReferences),
          env: deps.env,
          prompter,
        });
    if (envSection) collected.push(envSectionFile(envSection));

    const resolver = createPathResolver({ os: sourceOsOf(deps.platform), homeDir: deps.homedir });
    return {
      formatVersion: BUNDLE_FORMAT_VERSION,
      agent: item.adapter.id,
      scope: item.scope,
      sourceOs: sourceOsOf(deps.platform),
      agentVersion: item.version,
      files: toBundleFiles(collected, resolver),
    };
  }

  /**
   * Whether to upload one collected setup, and over which revision. Asks before pushing a
   * setup whose last pull did not restore everything (T46, BUG-05) and before replacing a
   * copy the server has in another revision than this PC knows (T38); a no from the user is their choice, a skip by
   * `--yes` is not done.
   */
  async function decide(
    item: PushItem,
    scopeKey: string,
    saved: ReadonlyMap<string, number>,
    options: PushOptions,
  ): Promise<{ expectedRevision: number } | SetupOutcome> {
    const setup = describe(item);
    const skipped = (reason: string): SetupOutcome =>
      options.yes ? { setup, result: 'not-done', reason } : { setup, result: 'declined' };
    const state = deps.localState();

    // This PC's last pull left out declined commands or kept files it did not ask about, so
    // replacing the saved copy could drop parts of it for every PC. state.json does not say
    // which, so the words fit both (UX-01).
    if (await state.isPartial(item.adapter.id, scopeKey)) {
      const question = `This PC's last pull of the ${setup} did not restore everything, so pushing now may drop parts of the saved copy (and of your other PCs on their next pull). Push anyway?`;
      if (options.yes || !(await prompter.confirm(question, false))) {
        reporter.warn(
          `Skipped the ${setup}: its last pull here did not restore everything. Run \`agentnomad pull\` first and answer its questions, or push without --yes to choose.`,
        );
        return skipped('its last pull here did not restore everything');
      }
    }

    const known = await state.revisionOf(item.adapter.id, scopeKey);
    const onServer = saved.get(`${item.adapter.id}/${scopeKey}`) ?? null;
    if (onServer !== known) {
      const question =
        onServer === null
          ? `The saved ${setup} was deleted since this PC last had it. Save it again?`
          : `A newer copy of the ${setup} (revision ${String(onServer)}) was saved from another PC. Replace it with this PC's setup?`;
      if (options.yes || !(await prompter.confirm(question, false))) {
        const reason = onServer === null ? 'it was deleted on the server' : 'a newer copy exists';
        reporter.warn(
          `Skipped the ${setup}: ${reason}. Run \`agentnomad pull\` first to keep its changes.`,
        );
        return skipped(reason);
      }
    }
    return { expectedRevision: onServer ?? 0 };
  }

  return {
    async plan(options: PushOptions, keys: PushKeys): Promise<PushPlan> {
      const agents = await chooseAgents(options);
      if (agents.length === 0) {
        reporter.info('No supported agent is installed on this PC, so there is nothing to push.');
        return { uploads: [], outcomes: [] };
      }
      const items = await chooseItems(agents, options);
      const contents = await chooseContents(agents, items, options);
      await showNotices(
        agents.map(({ adapter }) => adapter),
        'push',
        reporter,
      );

      const outcomes: SetupOutcome[] = [];
      const collected: { item: PushItem; bundle: Omit<Bundle, 'revision'> }[] = [];
      for (const item of items) {
        const bundle = await collectItem(item, contents, options);
        if (bundle === null) outcomes.push({ setup: describe(item), result: 'done' });
        else collected.push({ item, bundle });
      }
      if (collected.length === 0) return { uploads: [], outcomes };

      const saved = await withSession(keys.secrets, () => listSavedRevisions(deps.api()));
      const uploads: PlannedUpload[] = [];
      for (const { item, bundle } of collected) {
        const scopeKey = scopeKeyFor(keys.crypto, keys.dataKey, item.scope);
        const decision = await decide(item, scopeKey, saved, options);
        if ('result' in decision) outcomes.push(decision);
        else
          uploads.push({
            adapter: item.adapter,
            setup: describe(item),
            scope: item.scope,
            scopeKey,
            bundle,
            expectedRevision: decision.expectedRevision,
          });
      }
      return { uploads, outcomes };
    },
  };
}

/**
 * Push's apply step (T59): encrypts each planned setup for the revision it will become (T38)
 * and uploads it. It has no prompter, so it never asks; a setup over the size limit, or one
 * another PC replaced while this push ran, is not done.
 */
export function createPushApplier(deps: PushApplyDeps) {
  const { reporter } = deps;

  async function uploadOne(planned: PlannedUpload, keys: PushKeys): Promise<SetupOutcome> {
    const { crypto, dataKey } = keys;
    const { setup, bundle, scopeKey, expectedRevision } = planned;
    const spinner = reporter.spinner();
    spinner.start(`Encrypting and uploading the ${setup}…`);
    let result:
      | { kind: 'saved'; revision: number; size: number }
      | { kind: 'too-large'; size: number }
      | { kind: 'conflict' };
    try {
      const ciphertext = sealBundle(
        crypto,
        await deps.codec.encode({ ...bundle, revision: expectedRevision + 1 }),
        dataKey,
        { formatVersion: BUNDLE_FORMAT_VERSION, agent: bundle.agent, scopeKey },
      );
      const size = ciphertext.byteLength;
      if (size > MAX_BUNDLE_BYTES) {
        result = { kind: 'too-large', size };
      } else {
        const nameEnc =
          planned.scope.kind === 'project'
            ? toBase64(
                encryptProjectName(crypto, dataKey, planned.scope.name, {
                  agent: bundle.agent,
                  scopeKey,
                }),
              )
            : undefined;
        try {
          const { revision } = await withSession(keys.secrets, () =>
            deps.api().bundles.put(
              { agent: planned.adapter.id, scopeKey },
              {
                ciphertext,
                expectedRevision,
                contentSha256: toHex(crypto.sha256(ciphertext)),
                formatVersion: BUNDLE_FORMAT_VERSION,
                ...(nameEnc !== undefined && { nameEnc }),
              },
            ),
          );
          await deps.localState().setRevision(planned.adapter.id, scopeKey, revision);
          if (planned.scope.kind === 'project')
            await deps.localState().rememberProject(deps.cwd, planned.scope.name);
          result = { kind: 'saved', revision, size };
        } catch (error) {
          // Another PC saved it after the plan compared revisions: never replaced unasked.
          if (!(error instanceof ApiError && error.code === 'revision_conflict')) throw error;
          result = { kind: 'conflict' };
        }
      }
    } finally {
      spinner.stop();
    }

    if (result.kind === 'too-large') {
      reporter.error(
        `The ${setup} is ${formatSize(result.size)} after compression and encryption; the limit is ${formatSize(MAX_BUNDLE_BYTES)}. Remove large files (e.g. images in skills) and try again.`,
      );
      return {
        setup,
        result: 'not-done',
        reason: `${formatSize(result.size)}, over the ${formatSize(MAX_BUNDLE_BYTES)} limit`,
      };
    }
    if (result.kind === 'conflict') {
      reporter.warn(
        `Skipped the ${setup}: a newer copy was saved from another PC while this push ran. Run \`agentnomad pull\` first to keep its changes.`,
      );
      return { setup, result: 'not-done', reason: 'a newer copy exists' };
    }
    const count = bundle.files.length;
    reporter.success(
      `Saved the ${setup}: ${String(count)} file${count === 1 ? '' : 's'}, ${formatSize(result.size)} (revision ${String(result.revision)}).`,
    );
    return { setup, result: 'done' };
  }

  return {
    async apply(plan: PushPlan, keys: PushKeys): Promise<SetupOutcome[]> {
      const outcomes: SetupOutcome[] = [];
      for (const planned of plan.uploads) outcomes.push(await uploadOne(planned, keys));
      return outcomes;
    },
  };
}

/**
 * `agentnomad push` (T33): choose agents and scopes, collect, make paths portable, stamp,
 * compress, encrypt on this PC and upload. The server only ever receives ciphertext and a
 * keyed hash of each project name. Plan, then apply (T59); exits with code 1 when a setup
 * was not saved (BUG-03).
 */
export function createPushCommand(deps: PushDeps): Pick<CommandHandlers, 'push'> {
  const planner = createPushPlanner(deps);
  const applier = createPushApplier(deps);
  return {
    async push(options) {
      const secrets = await deps.secrets();
      const dataKey = await readDataKey(secrets, NOT_LOGGED_IN_ON_THIS_PC);
      // Wiped on every path from here on, also when a question is cancelled (BP-01).
      try {
        const keys: PushKeys = { secrets, crypto: await deps.crypto(), dataKey };
        const plan = await planner.plan(options, keys);
        const applied = await applier.apply(plan, keys);
        finishSetups('push', [...plan.outcomes, ...applied]);
      } finally {
        dataKey.fill(0);
      }
    },
  };
}
