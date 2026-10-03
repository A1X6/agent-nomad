import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import type { BundleParams, BundleSummary } from '@agentnomad/contracts';
import {
  createGzipBundleCodec,
  createSodiumCryptoService,
  type CryptoService,
} from '@agentnomad/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAgentRegistry } from '../src/agents/registry.ts';
import type {
  AfterRestoreContext,
  AgentAdapter,
  CollectedFile,
  CollectOptions,
  ConflictToAsk,
  ScopeTarget,
} from '../src/agents/adapter.ts';
import type { ApiClient, BundleUpload } from '../src/api/api-client.ts';
import { createPullCommand } from '../src/pull/pull-command.ts';
import { createPushCommand } from '../src/push/push-command.ts';
import type { SecretName, SecretStore } from '../src/secrets/secret-store.ts';
import { createLocalState } from '../src/state/local-state.ts';
import { AnswerNeededError, createNoTerminalPrompter } from '../src/ui/no-terminal-prompter.ts';
import type { Prompter, Reporter } from '../src/ui/prompter.ts';

/*
 * The agent boundary (T61): push and pull run a second agent from its adapter alone. This
 * file builds "Example CLI" from the adapter interface and imports nothing from
 * `agents/claude-code`; the registry holds only this agent.
 */

let crypto: CryptoService;
let dataKey: Uint8Array;
beforeAll(async () => {
  crypto = await createSodiumCryptoService();
  dataKey = crypto.randomBytes(32);
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentnomad-boundary-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

function fakeServer(): ApiClient {
  const stored = new Map<
    string,
    { params: BundleParams; upload: BundleUpload; revision: number }
  >();
  const key = (params: BundleParams) => `${params.agent}/${params.scopeKey}`;
  return {
    auth: {} as ApiClient['auth'],
    bundles: {
      put: (params, upload) => {
        const revision = (stored.get(key(params))?.revision ?? 0) + 1;
        stored.set(key(params), { params, upload, revision });
        return Promise.resolve({ revision, updatedAt: '2026-10-03T12:00:00Z' });
      },
      list: () =>
        Promise.resolve({
          items: [...stored.values()].map((entry): BundleSummary => ({
            agent: entry.params.agent,
            scopeKey: entry.params.scopeKey,
            nameEnc: entry.upload.nameEnc ?? null,
            revision: entry.revision,
            formatVersion: 1,
            sizeBytes: entry.upload.ciphertext.byteLength,
            updatedAt: '2026-10-03T12:00:00Z',
          })),
          nextCursor: null,
        }),
      get: (params) => {
        const entry = stored.get(key(params));
        if (!entry) return Promise.reject(new Error('not found'));
        return Promise.resolve({
          ciphertext: entry.upload.ciphertext,
          revision: entry.revision,
          contentSha256: entry.upload.contentSha256,
          formatVersion: 1,
          nameEnc: entry.upload.nameEnc ?? null,
        });
      },
      delete: () => Promise.reject(new Error('not used')),
    },
  };
}

function loggedIn(): SecretStore {
  const saved = new Map<SecretName, string>([
    ['session-token', 't'.repeat(43)],
    ['data-key', Buffer.from(dataKey).toString('base64')],
  ]);
  return {
    backend: 'keychain',
    get: (name) => Promise.resolve(saved.get(name) ?? null),
    set: () => Promise.resolve(),
    setMany: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  };
}

function scripted(answers: unknown[]) {
  const asked: string[] = [];
  const next = (message: string): unknown => {
    asked.push(message);
    if (answers.length === 0) throw new Error(`No answer scripted for "${message}"`);
    return answers.shift();
  };
  const prompter = {
    select: (message: string) => Promise.resolve(next(message)),
    multiselect: (message: string) => Promise.resolve(next(message)),
    text: (message: string) => Promise.resolve(next(message)),
    password: (message: string) => Promise.resolve(next(message)),
    confirm: (message: string) => Promise.resolve(next(message)),
  } as unknown as Prompter;
  return { prompter, asked };
}

function recorder() {
  const lines: string[] = [];
  const reporter: Reporter = {
    info: (m) => lines.push(`info: ${m}`),
    success: (m) => lines.push(`success: ${m}`),
    warn: (m) => lines.push(`warn: ${m}`),
    error: (m) => lines.push(`error: ${m}`),
    spinner: () => ({ start: () => undefined, stop: () => undefined }),
  };
  return { reporter, lines };
}

/** What the Example CLI adapter saw, for the assertions. */
interface Seen {
  collected: CollectOptions[];
  followUps: { context: AfterRestoreContext; writtenFirst: boolean }[];
}

/**
 * Example CLI: its setup is every file under `~/.example`; files under `hooks/` run
 * programs; `extensions.json` lists extensions to reinstall after a pull (its own question);
 * `prompts/` is an optional part, saved only after a yes.
 */
function exampleAdapter(home: string, seen: Seen): AgentAdapter {
  const base = join(home, '.example');
  const toPath = (bundlePath: string) => join(base, ...bundlePath.split('/'));

  async function walk(dir: string): Promise<CollectedFile[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const found: CollectedFile[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await walk(full)));
      else
        found.push({
          path: relative(base, full).split(sep).join('/'),
          content: new Uint8Array(await readFile(full)),
          executable: false,
        });
    }
    return found;
  }
  const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

  const adapter: AgentAdapter = {
    id: 'example',
    displayName: 'Example CLI',
    memoryDescription: 'what Example CLI remembers',
    detector: {
      detect: () => Promise.resolve({ installed: true, baseDir: base, version: '1.0.0' }),
    },
    collector: {
      async collect(target: ScopeTarget, options: CollectOptions) {
        seen.collected.push(options);
        if (target.kind !== 'global') return [];
        const files = await walk(base);
        return files.filter(
          (file) => !file.path.startsWith('prompts/') || options.include?.has('prompts') === true,
        );
      },
    },
    envReferences: {
      mcp: new Set(['mcp.json']),
      settings: new Set(),
      ownVariables: new Set(['EXAMPLE_HOME']),
    },
    optionalParts: [
      {
        id: 'prompts',
        scope: 'global',
        available: () => Promise.resolve({ names: ['review'], problem: null }),
        question: (names) => `Also save your prompts library (${names.join(', ')})?`,
        unreadable: (problem) => problem,
        noneFound: 'No prompts library here.',
      },
    ],
    restorer: {
      reviewRunnable: (files, current) =>
        files
          .filter((file) => file.path.startsWith('hooks/'))
          .filter((file) => !current.some((here) => here.path === file.path))
          .map((file) => ({
            file: file.path,
            label: 'hook',
            command: file.path,
            identity: file.path,
            change: 'new' as const,
          })),
      isRedirectVariable: (name) => name === 'EXAMPLE_ENDPOINT',
      conflicts: (files, current) =>
        files.flatMap((file): ConflictToAsk[] => {
          const here = current.find((entry) => entry.path === file.path);
          return here !== undefined && !same(here.content, file.content)
            ? [{ path: file.path, question: { overwriteAllowed: true } }]
            : [];
        }),
      async restore(_target, files, onConflict) {
        const written: string[] = [];
        const skipped: string[] = [];
        for (const file of files) {
          const path = toPath(file.path);
          const before = await readFile(path).catch(() => null);
          if (before !== null && same(new Uint8Array(before), file.content)) continue;
          if (
            before !== null &&
            (await onConflict(file.path, { overwriteAllowed: true })) === 'skip'
          ) {
            skipped.push(file.path);
            continue;
          }
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, file.content);
          written.push(file.path);
        }
        return { written, skipped, backups: [], warnings: [] };
      },
    },
    async planRestore(context) {
      const wanted = context.files.some((file) => file.path === 'extensions.json');
      const reinstall =
        wanted &&
        (context.allowCommands ||
          (!context.assumeYes &&
            (await context.prompter.confirm('Example CLI: reinstall 1 extension?', true))));
      return {
        restore: (onConflict, restoreContext) =>
          adapter.restorer.restore(context.target, context.files, onConflict, restoreContext),
        afterRestore: async (followUp) => {
          if (!reinstall) return;
          seen.followUps.push({
            context: followUp,
            writtenFirst: await exists(toPath('extensions.json')),
          });
        },
      };
    },
  };
  return adapter;
}

function machine(name: string) {
  const home = join(root, name);
  return { home, base: join(home, '.example') };
}

function depsFor(
  pc: ReturnType<typeof machine>,
  server: ApiClient,
  prompter: Prompter,
  seen: Seen,
) {
  const { reporter, lines } = recorder();
  const state = createLocalState({
    path: join(pc.home, 'state.json'),
    server: 's',
    platform: process.platform,
  });
  const deps = {
    prompter,
    reporter,
    registry: () => createAgentRegistry([exampleAdapter(pc.home, seen)]),
    secrets: () => Promise.resolve(loggedIn()),
    api: () => server,
    crypto: () => Promise.resolve(crypto),
    codec: createGzipBundleCodec(),
    localState: () => state,
    envWriter: () => ({
      where: 'test profile',
      current: () => Promise.resolve(new Map<string, string>()),
      write: () => Promise.resolve({ backup: null }),
    }),
    env: {},
    cwd: join(pc.home, 'code'),
    homedir: pc.home,
    platform: process.platform,
  };
  return { deps, lines, state };
}

const newSeen = (): Seen => ({ collected: [], followUps: [] });

/** PC A pushes its Example CLI setup, the prompts library included by flag. */
async function pushed() {
  const server = fakeServer();
  const a = machine('laptop');
  await put(join(a.base, 'settings.toml'), 'theme = "dark"\n');
  await put(join(a.base, 'hooks', 'check.sh'), 'echo ok\n');
  await put(join(a.base, 'extensions.json'), '["lint"]');
  await put(join(a.base, 'prompts', 'review.md'), 'Review this.');
  const seen = newSeen();
  const push = createPushCommand(depsFor(a, server, scripted([]).prompter, seen).deps).push;
  await push({ global: true, yes: true, parts: new Map([['prompts', true]]) });
  return { server, seen };
}

describe('a second agent goes through push and pull from its adapter alone (T61)', () => {
  it('push asks the agent’s own questions and collects its optional part', async () => {
    const server = fakeServer();
    const a = machine('laptop');
    await put(join(a.base, 'settings.toml'), 'theme = "dark"\n');
    const seen = newSeen();
    const script = scripted([false, true]);
    await createPushCommand(depsFor(a, server, script.prompter, seen).deps).push({
      global: true,
      yes: false,
    });
    expect(script.asked).toEqual([
      'Include memory (what Example CLI remembers)?',
      'Also save your prompts library (review)?',
    ]);
    expect(seen.collected[0]?.include).toEqual(new Set(['prompts']));
  });

  it('pull restores it, asks every question before writing, and follows up without a prompter', async () => {
    const { server } = await pushed();
    const b = machine('desktop');
    await put(join(b.base, 'settings.toml'), 'theme = "light"\n');
    const seen = newSeen();
    const script = scripted([true, 'overwrite', true]);
    const t = depsFor(b, server, script.prompter, seen);
    await createPullCommand(t.deps).pull({ global: true, yes: false });

    expect(script.asked).toEqual([
      'Allow them?',
      'settings.toml already exists here and is different.',
      'Example CLI: reinstall 1 extension?',
    ]);
    expect(t.lines.some((line) => line.includes('+ hook: hooks/check.sh'))).toBe(true);
    expect(await readFile(join(b.base, 'settings.toml'), 'utf8')).toBe('theme = "dark"\n');
    expect(await readFile(join(b.base, 'prompts', 'review.md'), 'utf8')).toBe('Review this.');
    expect(seen.followUps).toHaveLength(1);
    expect(seen.followUps[0]?.writtenFirst).toBe(true);
    expect('prompter' in (seen.followUps[0]?.context ?? {})).toBe(false);
    expect(await t.state.revisionOf('example', 'global')).not.toBeNull();
  });

  it('without a terminal, the agent’s open question stops pull before anything is written', async () => {
    const { server } = await pushed();
    const b = machine('desktop');
    const seen = newSeen();
    const t = depsFor(b, server, createNoTerminalPrompter(), seen);
    await expect(
      createPullCommand(t.deps).pull({
        global: true,
        yes: false,
        allowCommands: false,
        conflict: 'merge',
      }),
    ).rejects.toBeInstanceOf(AnswerNeededError);
    expect(await exists(b.base)).toBe(false);
    expect(seen.followUps).toEqual([]);
    expect(await t.state.revisionOf('example', 'global')).toBeNull();
  });

  it('push offers the values its MCP servers use, from the agent’s own files (ARCH-01)', async () => {
    const server = fakeServer();
    const a = machine('laptop');
    await put(
      join(a.base, 'mcp.json'),
      JSON.stringify({
        mcpServers: { docs: { env: { TOKEN: '${EXAMPLE_TOKEN}', DIR: '${EXAMPLE_HOME}' } } },
      }),
    );
    const script = scripted([false, false, ['EXAMPLE_TOKEN']]);
    const pushing = depsFor(a, server, script.prompter, newSeen());
    await createPushCommand({
      ...pushing.deps,
      env: { EXAMPLE_TOKEN: 'token-1', EXAMPLE_HOME: '/opt/example' },
    }).push({ global: true, yes: false });
    expect(script.asked).toEqual([
      'Include memory (what Example CLI remembers)?',
      'Also save your prompts library (review)?',
      'Save these values with your setup (encrypted; only you can read them)? Leave all unticked to save none.',
    ]);

    const b = machine('desktop');
    const written: Record<string, string>[] = [];
    const pulling = depsFor(b, server, createNoTerminalPrompter(), newSeen());
    await createPullCommand({
      ...pulling.deps,
      envWriter: () => ({
        where: 'test profile',
        current: () => Promise.resolve(new Map<string, string>()),
        write: (variables) => {
          written.push({ ...variables });
          return Promise.resolve({ backup: null });
        },
      }),
    }).pull({ global: true, yes: true });
    expect(written).toEqual([{ EXAMPLE_TOKEN: 'token-1' }]);
  });

  it('--yes skips its hooks and extensions and writes the rest', async () => {
    const { server } = await pushed();
    const b = machine('desktop');
    const seen = newSeen();
    const t = depsFor(b, server, createNoTerminalPrompter(), seen);
    await createPullCommand(t.deps).pull({ global: true, yes: true });
    expect(await exists(join(b.base, 'settings.toml'))).toBe(true);
    expect(await exists(join(b.base, 'hooks', 'check.sh'))).toBe(false);
    expect(seen.followUps).toEqual([]);
  });
});
