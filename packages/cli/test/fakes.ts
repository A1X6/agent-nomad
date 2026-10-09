import {
  BUNDLE_FORMAT_VERSION,
  type BundleParams,
  type BundleSummary,
} from '@agentnomad/contracts';
import { createSodiumCryptoService, DATA_KEY_BYTES, type CryptoService } from '@agentnomad/core';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, beforeEach } from 'vitest';

// Module paths, not the package index: the agent boundary test uses these fakes and must
// not load any agent's adapter.
import type { AgentAdapter, CollectedFile, DetectedAgent } from '../src/agents/adapter.ts';
import type { ExecutableLookupSystem } from '../src/agents/shared/detector-system.ts';
import type { ApiClient, BundleUpload } from '../src/api/api-client.ts';
import { ApiError } from '../src/api/api-errors.ts';
import { loadZxcvbnChecker, type PasswordChecker } from '../src/auth/password-policy.ts';
import type { EnvWriter } from '../src/env/shell-profile.ts';
import { SECRET_NAMES, type SecretName, type SecretStore } from '../src/secrets/secret-store.ts';
import { createLocalState, STATE_FILE, type LocalState } from '../src/state/local-state.ts';
import type { Choice, Prompter, Reporter } from '../src/ui/prompter.ts';

import { stubRestorer } from './stub-restorer.ts';

/** Shared test fakes (DUP-01): one copy, so every test runs against the same behaviour. */

const notUsed = (): Promise<never> => Promise.reject(new Error('not used'));

/** A collected (or pulled) file as an adapter hands it over. */
export const collected = (
  path: string,
  content: string | Uint8Array,
  executable = false,
): CollectedFile => ({
  path,
  content: typeof content === 'string' ? new TextEncoder().encode(content) : content,
  executable,
});

/** A collected file holding `value` as JSON. */
export const collectedJson = (path: string, value: unknown): CollectedFile =>
  collected(path, JSON.stringify(value));

/** The paths of collected files, in order. */
export const paths = (files: readonly CollectedFile[]) => files.map((file) => file.path);

/** The text of the collected file at `path` (empty when there is none). */
export const text = (files: readonly CollectedFile[], path: string) =>
  new TextDecoder().decode(files.find((file) => file.path === path)?.content);

const makeTempDir = (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), prefix));
const removeTempDir = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });

/**
 * The one temporary-folder hook of the CLI tests (review 9 DUP-01): a fresh folder named
 * `prefix` plus random letters before each test of the calling file or `describe`, handed to
 * `use`, and removed after the test.
 */
export function useTempDir(prefix: string, use: (dir: string) => void): void {
  let dir: string | undefined;
  beforeEach(async () => {
    dir = await makeTempDir(prefix);
    use(dir);
  });
  afterEach(async () => {
    if (dir !== undefined) await removeTempDir(dir);
  });
}

/** Runs `use` in a fresh temporary folder of its own, removed afterwards even when it fails. */
export async function withTempDir(
  prefix: string,
  use: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await makeTempDir(prefix);
  try {
    await use(dir);
  } finally {
    await removeTempDir(dir);
  }
}

// The real crypto service and a data key, made by `useDataKey` before the tests of the
// calling file. Live bindings, as in claude-code-project-fixtures.ts.
export let crypto: CryptoService;
export let dataKey: Uint8Array;

/** Makes the real crypto service and a random data key once for the calling file. */
export function useDataKey(): void {
  beforeAll(async () => {
    crypto = await createSodiumCryptoService();
    dataKey = crypto.randomBytes(DATA_KEY_BYTES);
  });
}

// The real password checker (zxcvbn), loaded by `useZxcvbnChecker` before the tests of the
// calling file. A live binding, like `crypto` and `dataKey`.
export let zxcvbn: PasswordChecker;

/** Loads the real password checker once for the calling file. */
export function useZxcvbnChecker(): void {
  beforeAll(async () => {
    zxcvbn = await loadZxcvbnChecker();
  });
}

/**
 * Writes a file in a test's temporary folder, creating its folders first. The content
 * defaults to `x` for tests where only the file being there matters.
 */
export async function writeTestFile(
  path: string,
  content: string | Uint8Array = 'x',
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/** Links the folder `target` at `path`: a junction on Windows, which needs no admin rights. */
export const linkFolder = (target: string, path: string): Promise<void> =>
  symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');

/** A file's text (UTF-8). */
export const readText = (path: string): Promise<string> => readFile(path, 'utf8');

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A JSON file that must hold an object; anything else fails the test here. */
export async function readJson(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readText(path));
  if (!isJsonObject(value)) throw new Error(`${path} does not hold a JSON object`);
  return value;
}

/** Whether anything (a file or a folder) is at `path`. */
export const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * An EnvWriter that touches no profile: `written` records the variables of each write.
 * `current` is what its block holds already (nothing by default).
 */
export function fakeEnvWriter(
  options: { where?: string; current?: ReadonlyMap<string, string>; backup?: string | null } = {},
) {
  const written: Record<string, string>[] = [];
  const writer: EnvWriter = {
    where: options.where ?? 'test profile',
    current: () => Promise.resolve(options.current ?? new Map<string, string>()),
    write: (variables) => {
      written.push({ ...variables });
      return Promise.resolve({ backup: options.backup ?? null });
    },
  };
  return { writer, written };
}

/**
 * An API client built from the parts a test gives; every other method rejects `not used`.
 */
export function fakeApi(
  parts: { auth?: Partial<ApiClient['auth']>; bundles?: Partial<ApiClient['bundles']> } = {},
): ApiClient {
  return {
    auth: {
      prelogin: notUsed,
      register: notUsed,
      login: notUsed,
      logout: notUsed,
      deleteAccount: notUsed,
      ...parts.auth,
    },
    bundles: { list: notUsed, get: notUsed, put: notUsed, delete: notUsed, ...parts.bundles },
  };
}

/**
 * A SecretStore in memory. Given `loggedIn` (the account's data key), it starts with a
 * session token and that key. `saved` lets a test look at or seed what is stored.
 */
export function memorySecretStore(
  options: {
    loggedIn?: Uint8Array;
    backend?: SecretStore['backend'];
    saved?: Map<SecretName, string>;
  } = {},
): SecretStore {
  const saved = options.saved ?? new Map<SecretName, string>();
  if (options.loggedIn) {
    saved
      .set('session-token', 't'.repeat(43))
      .set('data-key', Buffer.from(options.loggedIn).toString('base64'));
  }
  return {
    backend: options.backend ?? 'keychain',
    get: (name) => Promise.resolve(saved.get(name) ?? null),
    setMany: (values) => {
      for (const name of SECRET_NAMES) {
        const value = values[name];
        if (value !== undefined) saved.set(name, value);
      }
      return Promise.resolve();
    },
    delete: (name) => {
      saved.delete(name);
      return Promise.resolve();
    },
  };
}

/** A memory SecretStore and the map behind it. */
export function memorySecrets(backend: SecretStore['backend'] = 'keychain') {
  const saved = new Map<SecretName, string>();
  return { store: memorySecretStore({ backend, saved }), saved };
}

/** A password the real password policy accepts. */
export const STRONG = 'plum-garage-violin-47';

/** A project folder for tests that never look inside it. */
export const CWD = process.platform === 'win32' ? 'C:\\code\\my-app' : '/code/my-app';

/** A local state kept in `file` (`state.json` by default) in a test's temporary folder. */
export const localStateIn = (dir: string, file = STATE_FILE): LocalState =>
  createLocalState({
    path: join(dir, file),
    server: 's',
    platform: process.platform,
  });

/** An adapter whose detector reports `found`; it collects and restores nothing. */
export const fakeAdapter = (
  id: string,
  displayName: string,
  found: DetectedAgent,
): AgentAdapter => ({
  id,
  displayName,
  detector: { detect: () => Promise.resolve(found) },
  collector: { collect: () => Promise.resolve([]) },
  restorer: stubRestorer(),
});

/**
 * A Linux PC where exactly `executables` can be run, for code that looks a command up on PATH
 * (`/usr/bin`) and nothing else (SOLID-06; review 15 DUP-04).
 */
export const fakeExecutables = (executables: readonly string[]): ExecutableLookupSystem => ({
  platform: 'linux',
  homedir: '/home/a',
  env: { PATH: '/usr/bin' },
  isExecutable: (path) => Promise.resolve(executables.includes(path)),
});

/** What a detector reports for an installed agent, and for one that is not. */
export const installedAgent: DetectedAgent = {
  installed: true,
  baseDir: '/home/a/.claude',
  version: '2.1.282',
};
export const missingAgent: DetectedAgent = { installed: false, baseDir: null, version: null };

/**
 * Answers questions from a script, in order, and throws when it runs out. A validator's
 * complaint is recorded in `rejected` and the next answer used, like the real prompter
 * asking again; an Error answer is thrown, like a question the user cancels.
 */
export function scriptedPrompter(answers: unknown[]) {
  const asked: string[] = [];
  const rejected: string[] = [];
  const next = (message: string, validate?: (value: string) => string | undefined): unknown => {
    for (;;) {
      asked.push(message);
      if (answers.length === 0) throw new Error(`No answer scripted for "${message}"`);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      const problem = typeof answer === 'string' ? validate?.(answer) : undefined;
      if (problem === undefined) return answer;
      rejected.push(problem);
    }
  };
  // A scripted answer of the wrong kind fails here, near the cause, instead of sending the
  // command down another path (a string where a yes/no is asked is truthy).
  const wrong = (message: string, expected: string, answer: unknown) =>
    new Error(`"${message}" expected ${expected}, got ${JSON.stringify(answer)}`);
  const choice = <T extends string>(
    message: string,
    choices: readonly Choice<T>[],
    answer: unknown,
  ): T => {
    const found = choices.find((option) => option.value === answer);
    if (!found) {
      throw wrong(message, `one of ${choices.map((option) => option.value).join(', ')}`, answer);
    }
    return found.value;
  };
  const text = (message: string, validate?: (value: string) => string | undefined) => {
    const answer = next(message, validate);
    if (typeof answer !== 'string') throw wrong(message, 'text', answer);
    return answer;
  };
  const prompter: Prompter = {
    select: (message, choices) => Promise.resolve(choice(message, choices, next(message))),
    multiselect: (message, choices) => {
      const answer = next(message);
      if (!Array.isArray(answer)) throw wrong(message, 'a list', answer);
      return Promise.resolve(answer.map((value: unknown) => choice(message, choices, value)));
    },
    text: (message, options) => Promise.resolve(text(message, options?.validate)),
    password: (message, options) => Promise.resolve(text(message, options?.validate)),
    confirm: (message) => {
      const answer = next(message);
      if (typeof answer !== 'boolean') throw wrong(message, 'yes/no', answer);
      return Promise.resolve(answer);
    },
  };
  return { prompter, asked, rejected, left: answers };
}

/**
 * A Reporter that records each line as `level: message`, or the bare message with
 * `levels: false`. With `spinner: true` it also records `spin:` and `done:` lines.
 */
export function recordingReporter(options: { levels?: boolean; spinner?: boolean } = {}) {
  const lines: string[] = [];
  const line = (level: string) => (message: string) => {
    lines.push(options.levels === false ? message : `${level}: ${message}`);
  };
  const reporter: Reporter = {
    info: line('info'),
    success: line('success'),
    warn: line('warn'),
    error: line('error'),
    spinner: () =>
      options.spinner
        ? {
            start: (m) => lines.push(`spin: ${m}`),
            stop: (m) => lines.push(`done: ${m ?? ''}`),
          }
        : { start: () => undefined, stop: () => undefined },
  };
  return { reporter, lines };
}

interface StoredBundle {
  params: BundleParams;
  upload: BundleUpload;
  revision: number;
}

/**
 * A bundle server in memory with the real API's revision rule: an upload must name the
 * revision saved now (0 for a new setup), or it is refused with `revision_conflict`.
 * `stored` is keyed by `agent/scopeKey`; `puts` records every upload, refused ones too.
 */
export function fakeBundleServer(updatedAt = '2026-09-25T12:00:00Z') {
  const stored = new Map<string, StoredBundle>();
  const puts: { params: BundleParams; upload: BundleUpload }[] = [];
  const key = (params: BundleParams) => `${params.agent}/${params.scopeKey}`;
  const api = fakeApi({
    bundles: {
      list: () =>
        Promise.resolve({
          items: [...stored.values()].map((entry): BundleSummary => ({
            agent: entry.params.agent,
            scopeKey: entry.params.scopeKey,
            nameEnc: entry.upload.nameEnc ?? null,
            revision: entry.revision,
            formatVersion: BUNDLE_FORMAT_VERSION,
            sizeBytes: entry.upload.ciphertext.byteLength,
            updatedAt,
          })),
          nextCursor: null,
        }),
      get: (params) => {
        const entry = stored.get(key(params));
        if (!entry) return Promise.reject(new ApiError(404, 'not_found', 'No saved setup'));
        return Promise.resolve({
          ciphertext: entry.upload.ciphertext,
          revision: entry.revision,
          contentSha256: entry.upload.contentSha256,
          formatVersion: BUNDLE_FORMAT_VERSION,
          nameEnc: entry.upload.nameEnc ?? null,
        });
      },
      put: (params, upload) => {
        puts.push({ params, upload });
        const current = stored.get(key(params))?.revision ?? 0;
        if (upload.expectedRevision !== current) {
          return Promise.reject(
            new ApiError(
              409,
              'revision_conflict',
              'newer',
              current > 0 ? { currentRevision: current } : {},
            ),
          );
        }
        stored.set(key(params), { params, upload, revision: current + 1 });
        return Promise.resolve({ revision: current + 1, updatedAt });
      },
      delete: (params) => {
        stored.delete(key(params));
        return Promise.resolve();
      },
    },
  });
  return { api, stored, puts };
}

/** What `server` holds for one setup, without knowing how the fake keys its map. */
export function storedOn(
  server: ReturnType<typeof fakeBundleServer>,
  scopeKey: string,
  agent = 'claude-code',
): StoredBundle | undefined {
  return server.stored.get(`${agent}/${scopeKey}`);
}

/** The revision `server` holds for one setup, or `undefined` when none is saved. */
export const revisionOn = (
  server: ReturnType<typeof fakeBundleServer>,
  scopeKey: string,
  agent = 'claude-code',
): number | undefined => storedOn(server, scopeKey, agent)?.revision;
