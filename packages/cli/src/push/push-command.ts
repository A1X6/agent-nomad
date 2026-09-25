import { basename, posix, win32 } from 'node:path';

import {
  BUNDLE_FORMAT_VERSION,
  MAX_BUNDLE_BYTES,
  ProjectNameSchema,
  type Bundle,
  type BundleScope,
  type SourceOs,
} from '@agentnomad/contracts';
import {
  createPathResolver,
  encryptProjectName,
  scopeKeyFor,
  sealBundle,
  type BundleCodec,
  type CryptoService,
} from '@agentnomad/core';

import type { AgentAdapter, AgentRegistry, CollectedFile, ScopeTarget } from '../agents/adapter.ts';
import { unknownEntriesNotice } from '../agents/claude-code/unknown-files.ts';
import type { ApiClient } from '../api/api-client.ts';
import { ApiError } from '../api/api-errors.ts';
import { withSession } from '../auth/local-session.ts';
import type { CommandHandlers, PushOptions } from '../cli/commands.ts';
import { scanEnvReferences } from '../env/env-references.ts';
import { chooseEnvValues, envSectionFile } from '../env/env-section.ts';
import type { SecretStore } from '../secrets/secret-store.ts';
import type { LocalState } from '../state/local-state.ts';
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

/** Not logged in on this PC (no session or no unlocked data key). */
export class NotLoggedInPushError extends Error {
  constructor() {
    super('You are not logged in on this PC. Run `agentnomad login` first.');
    this.name = 'NotLoggedInPushError';
  }
}

type ScopeChoice = 'global' | 'project' | 'both';

/** One save: an agent and a scope. */
interface PushItem {
  readonly adapter: AgentAdapter;
  readonly version: string | null;
  readonly scope: BundleScope;
  readonly target: ScopeTarget;
}

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const sizeOf = (bytes: number) =>
  bytes < 1024
    ? `${String(bytes)} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** `darwin` / `win32` stay; anything else counts as Linux for the bundle's source OS. */
const sourceOsOf = (platform: NodeJS.Platform): SourceOs =>
  platform === 'darwin' || platform === 'win32' ? platform : 'linux';

const describe = (item: PushItem) =>
  `${item.adapter.displayName} ${item.scope.kind === 'global' ? 'global setup' : `project "${item.scope.name}"`}`;

/**
 * `agentnomad push` (T33): choose agents and scopes, collect, make paths portable, stamp,
 * compress, encrypt on this PC and upload. The server only ever receives ciphertext and a
 * keyed hash of each project name.
 */
export function createPushCommand(deps: PushDeps): Pick<CommandHandlers, 'push'> {
  const { prompter, reporter } = deps;
  const path = deps.platform === 'win32' ? win32 : posix;
  const samePath = (a: string, b: string) =>
    deps.platform === 'win32'
      ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
      : path.resolve(a) === path.resolve(b);

  async function chooseAgents(
    options: PushOptions,
  ): Promise<{ adapter: AgentAdapter; version: string | null }[]> {
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
        return { adapter: match.adapter, version: match.found.version };
      });
    }
    if (installed.length === 0) return [];
    if (installed.length === 1 || options.yes) {
      return installed.map((entry) => ({ adapter: entry.adapter, version: entry.found.version }));
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
    return installed
      .filter((entry) => chosen.includes(entry.adapter.id))
      .map((entry) => ({ adapter: entry.adapter, version: entry.found.version }));
  }

  async function chooseScope(adapter: AgentAdapter, options: PushOptions): Promise<ScopeChoice> {
    const inHome = samePath(deps.cwd, deps.homedir);
    if (options.global && options.project !== undefined) return 'both';
    if (options.global) return 'global';
    if (options.project !== undefined) return 'project';
    // The home folder is never offered as a project: it would sweep up the whole user folder.
    if (inHome || options.yes) return 'global';
    return prompter.select(`${adapter.displayName}: what to save?`, [
      { value: 'global', label: 'Global setup', hint: 'your settings, skills, agents, commands…' },
      { value: 'project', label: 'This project', hint: deps.cwd },
      { value: 'both', label: 'Both' },
    ]);
  }

  /** The folder's saved name, the `--project` name, or a new one the user types once. */
  async function projectName(options: PushOptions): Promise<string> {
    const state = deps.localState();
    const name =
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
      basename(deps.cwd);
    await state.rememberProject(deps.cwd, name);
    return name;
  }

  /** Uploads one encrypted bundle; asks before replacing a newer copy from another PC. */
  async function upload(
    item: PushItem,
    secrets: SecretStore,
    scopeKey: string,
    ciphertext: Uint8Array,
    extra: { contentSha256: string; nameEnc?: string },
    options: PushOptions,
  ): Promise<number | null> {
    const api = deps.api();
    const state = deps.localState();
    const params = { agent: item.adapter.id, scopeKey };
    const put = (expectedRevision: number) =>
      withSession(secrets, () =>
        api.bundles.put(params, {
          ciphertext,
          expectedRevision,
          contentSha256: extra.contentSha256,
          formatVersion: BUNDLE_FORMAT_VERSION,
          ...(extra.nameEnc !== undefined && { nameEnc: extra.nameEnc }),
        }),
      );
    try {
      return (await put((await state.revisionOf(item.adapter.id, scopeKey)) ?? 0)).revision;
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'revision_conflict')) throw error;
      const current = error.currentRevision;
      const question =
        current === undefined
          ? `The saved ${describe(item)} was deleted since this PC last had it. Save it again?`
          : `A newer copy of the ${describe(item)} (revision ${String(current)}) was saved from another PC. Replace it with this PC's setup?`;
      if (options.yes || !(await prompter.confirm(question, false))) {
        reporter.warn(
          `Skipped the ${describe(item)}: ${current === undefined ? 'it was deleted on the server' : 'a newer copy exists'}. Run \`agentnomad pull\` first to keep its changes.`,
        );
        return null;
      }
      return (await put(current ?? 0)).revision;
    }
  }

  return {
    async push(options) {
      const secrets = await deps.secrets();
      const [token, dataKeyText] = await Promise.all([
        secrets.get('session-token'),
        secrets.get('data-key'),
      ]);
      if (token === null || dataKeyText === null) throw new NotLoggedInPushError();
      const dataKey = new Uint8Array(Buffer.from(dataKeyText, 'base64'));

      const agents = await chooseAgents(options);
      if (agents.length === 0) {
        reporter.info('No supported agent is installed on this PC, so there is nothing to push.');
        return;
      }

      const items: PushItem[] = [];
      let name: string | null = null;
      for (const { adapter, version } of agents) {
        const choice = await chooseScope(adapter, options);
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

      const includeMemory = options.yes
        ? false
        : await prompter.confirm(
            'Include memory (what Claude learned: subagent and auto memory)?',
            false,
          );

      const shown = new Set<string>();
      for (const { adapter } of agents) {
        for (const notice of (await adapter.inspector?.notices('push')) ?? []) {
          if (!shown.has(notice)) reporter.warn(notice);
          shown.add(notice);
        }
      }

      const crypto = await deps.crypto();
      const resolver = createPathResolver({ os: sourceOsOf(deps.platform), homeDir: deps.homedir });
      try {
        for (const item of items) {
          const collected: CollectedFile[] = [
            ...(await item.adapter.collector.collect(item.target, { includeMemory })),
          ];
          const unknown = unknownEntriesNotice(
            (await item.adapter.inspector?.unknownEntries(item.target)) ?? [],
          );
          if (unknown !== null) reporter.warn(`${describe(item)}: ${unknown}`);
          if (collected.length === 0) {
            reporter.info(`Nothing to save for the ${describe(item)}.`);
            continue;
          }

          const envSection = options.yes
            ? null
            : await chooseEnvValues({
                scan: scanEnvReferences(collected),
                env: deps.env,
                prompter,
              });
          if (envSection) collected.push(envSectionFile(envSection));

          const bundle: Bundle = {
            formatVersion: BUNDLE_FORMAT_VERSION,
            agent: item.adapter.id,
            scope: item.scope,
            sourceOs: sourceOsOf(deps.platform),
            agentVersion: item.version,
            files: toBundleFiles(collected, resolver),
          };
          const spinner = reporter.spinner();
          spinner.start(`Encrypting and uploading the ${describe(item)}…`);
          let revision: number | null;
          let size: number;
          try {
            const scopeKey = scopeKeyFor(crypto, dataKey, item.scope);
            const ciphertext = sealBundle(crypto, await deps.codec.encode(bundle), dataKey, {
              formatVersion: BUNDLE_FORMAT_VERSION,
              agent: bundle.agent,
              scopeKey,
            });
            size = ciphertext.byteLength;
            if (size > MAX_BUNDLE_BYTES) {
              spinner.stop();
              reporter.error(
                `The ${describe(item)} is ${sizeOf(size)} after compression and encryption; the limit is 5 MB. Remove large files (e.g. images in skills) and try again.`,
              );
              continue;
            }
            const nameEnc =
              item.scope.kind === 'project'
                ? Buffer.from(
                    encryptProjectName(crypto, dataKey, item.scope.name, {
                      agent: bundle.agent,
                      scopeKey,
                    }),
                  ).toString('base64')
                : undefined;
            revision = await upload(
              item,
              secrets,
              scopeKey,
              ciphertext,
              {
                contentSha256: toHex(crypto.sha256(ciphertext)),
                ...(nameEnc !== undefined && { nameEnc }),
              },
              options,
            );
            if (revision !== null)
              await deps.localState().setRevision(item.adapter.id, scopeKey, revision);
          } finally {
            spinner.stop();
          }
          if (revision !== null) {
            const count = bundle.files.length;
            reporter.success(
              `Saved the ${describe(item)}: ${String(count)} file${count === 1 ? '' : 's'}, ${sizeOf(size)} (revision ${String(revision)}).`,
            );
          }
        }
      } finally {
        dataKey.fill(0);
      }
    },
  };
}
