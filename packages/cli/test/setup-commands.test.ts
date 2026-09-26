import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BundleSummary } from '@agentnomad/contracts';
import {
  createSodiumCryptoService,
  encryptProjectName,
  scopeKeyFor,
  type CryptoService,
} from '@agentnomad/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ApiError,
  createAgentRegistry,
  createAuthCommands,
  createLocalState,
  createSetupCommands,
  formatSize,
  NotLoggedInError,
  OutcomeUnknownError,
  timeAgo,
  type AgentAdapter,
  type ApiClient,
  type LocalState,
  type Prompter,
  type Reporter,
  type SecretName,
  type SecretStore,
} from '../src/index.ts';

const NOW = new Date('2026-09-25T12:00:00Z');
const CWD = process.platform === 'win32' ? 'C:\\code\\my-app' : '/code/my-app';

let crypto: CryptoService;
let dataKey: Uint8Array;
beforeAll(async () => {
  crypto = await createSodiumCryptoService();
  dataKey = crypto.randomBytes(32);
});

let dir: string;
let state: LocalState;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentnomad-cmds-'));
  state = createLocalState({
    path: join(dir, 'state.json'),
    server: 's',
    platform: process.platform,
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const claude: AgentAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  detector: { detect: () => Promise.resolve({ installed: true, baseDir: null, version: null }) },
  collector: { collect: () => Promise.resolve([]) },
  restorer: {
    restore: () => Promise.resolve({ written: [], skipped: [], backups: [], warnings: [] }),
  },
};

/** A server holding a global setup and two projects. */
function fakeServer() {
  const project = (name: string) => {
    const scopeKey = scopeKeyFor(crypto, dataKey, { kind: 'project', name });
    const nameEnc = Buffer.from(
      encryptProjectName(crypto, dataKey, name, { agent: 'claude-code', scopeKey }),
    ).toString('base64');
    return { scopeKey, nameEnc };
  };
  const items: BundleSummary[] = [
    {
      agent: 'claude-code',
      scopeKey: 'global',
      nameEnc: null,
      revision: 3,
      formatVersion: 1,
      sizeBytes: 5120,
      updatedAt: '2026-09-25T10:00:00Z',
    },
    {
      agent: 'claude-code',
      ...project('my-app'),
      revision: 5,
      formatVersion: 1,
      sizeBytes: 3000,
      updatedAt: '2026-09-24T09:00:00Z',
    },
    {
      agent: 'claude-code',
      ...project('website'),
      revision: 1,
      formatVersion: 1,
      sizeBytes: 900,
      updatedAt: '2026-09-10T09:00:00Z',
    },
  ];
  const deleted: string[] = [];
  const api = {
    auth: {},
    bundles: {
      list: () =>
        Promise.resolve({
          items: items.filter((item) => !deleted.includes(item.scopeKey)),
          nextCursor: null,
        }),
      delete: (params: { scopeKey: string }) => {
        deleted.push(params.scopeKey);
        return Promise.resolve();
      },
    },
  } as unknown as ApiClient;
  return { api, items, deleted, keyOf: (name: string) => project(name).scopeKey };
}

function loggedIn(saved = new Map<SecretName, string>()): SecretStore {
  saved
    .set('session-token', 't'.repeat(43))
    .set('data-key', Buffer.from(dataKey).toString('base64'));
  return {
    backend: 'keychain',
    get: (name) => Promise.resolve(saved.get(name) ?? null),
    set: (name, value) => {
      saved.set(name, value);
      return Promise.resolve();
    },
    delete: (name) => {
      saved.delete(name);
      return Promise.resolve();
    },
  };
}

function scripted(answers: unknown[]) {
  const asked: string[] = [];
  const answer = (message: string) => {
    asked.push(message);
    return Promise.resolve(answers.shift());
  };
  const prompter = {
    select: answer,
    multiselect: answer,
    text: answer,
    password: answer,
    confirm: answer,
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

function commands(
  server: ReturnType<typeof fakeServer>,
  answers: unknown[] = [],
  secrets = loggedIn(),
) {
  const script = scripted(answers);
  const { reporter, lines } = recorder();
  const handlers = createSetupCommands({
    prompter: script.prompter,
    reporter,
    registry: () => createAgentRegistry([claude]),
    secrets: () => Promise.resolve(secrets),
    api: () => server.api,
    crypto: () => Promise.resolve(crypto),
    localState: () => state,
    cwd: CWD,
    now: () => NOW,
  });
  return { ...handlers, asked: script.asked, lines };
}

const noFlags = { global: false };

describe('agentnomad list', () => {
  it('shows every saved setup with names decrypted, size and age', async () => {
    const t = commands(fakeServer());
    await t.list();
    expect(t.lines).toEqual([
      [
        'info: Claude Code',
        '  global setup       revision 3    5 KB  2 hours ago',
        '  project "my-app"   revision 5    3 KB  yesterday',
        '  project "website"  revision 1   900 B  15 days ago',
      ].join('\n'),
    ]);
  });

  it('says so when nothing is saved, and needs a login', async () => {
    const empty = fakeServer();
    empty.items.length = 0;
    const t = commands(empty);
    await t.list();
    expect(t.lines[0]).toContain('Nothing is saved yet');
    const none: SecretStore = {
      backend: 'file',
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    await expect(commands(fakeServer(), [], none).list()).rejects.toBeInstanceOf(NotLoggedInError);
  });
});

describe('agentnomad status', () => {
  it('compares this PC’s revisions with the server', async () => {
    const server = fakeServer();
    await state.setRevision('claude-code', 'global', 3);
    await state.setRevision('claude-code', server.keyOf('my-app'), 2);
    await state.setRevision('claude-code', 'f'.repeat(64), 4);
    await state.rememberProject(CWD, 'my-app');
    const t = commands(server);
    await t.status(noFlags);
    expect(t.lines).toEqual([
      [
        'info: ✓ Claude Code global setup: up to date (revision 3)',
        '↓ Claude Code project "my-app": newer copy on the server (revision 5, this PC has 2). Run `agentnomad pull`.',
        '· Claude Code project "website": never pulled or pushed on this PC',
        '✗ A Claude Code setup this PC had was deleted on the server.',
      ].join('\n'),
      'info: This folder is saved as "my-app".',
    ]);
  });

  it('narrows to --project', async () => {
    const t = commands(fakeServer());
    await t.status({ global: false, project: 'website' });
    expect(t.lines[0]).toBe(
      'info: · Claude Code project "website": never pulled or pushed on this PC',
    );
    expect(t.lines[1]).toBe('info: This folder is not saved as a project.');
  });
});

describe('agentnomad delete', () => {
  it('deletes the chosen setups after asking, and forgets them on this PC', async () => {
    const server = fakeServer();
    await state.setRevision('claude-code', server.keyOf('website'), 1);
    const t = commands(server, [[`claude-code/${server.keyOf('website')}`], true]);
    await t.delete({ global: false, yes: false });
    expect(server.deleted).toEqual([server.keyOf('website')]);
    expect(t.asked[1]).toBe(
      'Delete Claude Code project "website" from the server? This cannot be undone.',
    );
    expect(await state.revisionOf('claude-code', server.keyOf('website'))).toBeNull();
    expect(t.lines.at(-1)).toBe(
      'success: Deleted the Claude Code project "website" from the server.',
    );
  });

  it('deletes nothing when the user says no', async () => {
    const server = fakeServer();
    const t2 = commands(server, [false]);
    await t2.delete({ global: true, yes: false });
    expect(t2.lines.at(-1)).toBe('info: Nothing was deleted.');
    expect(server.deleted).toEqual([]);
  });

  it('--project with --yes deletes without asking; an unknown name deletes nothing', async () => {
    const server = fakeServer();
    const t = commands(server);
    await t.delete({ global: false, project: 'my-app', yes: true });
    expect(t.asked).toEqual([]);
    expect(server.deleted).toEqual([server.keyOf('my-app')]);
    await expect(
      commands(server).delete({ global: false, project: 'nope', yes: true }),
    ).rejects.toThrow('No saved setup matches');
  });
});

describe('agentnomad account delete', () => {
  function account(
    answers: unknown[],
    deleteAccount: () => Promise<void>,
    stdin?: string,
    saved = new Map<SecretName, string>(),
  ) {
    const script = scripted(answers);
    const { reporter, lines } = recorder();
    const secrets = loggedIn(saved);
    const sent: string[] = [];
    const api = {
      auth: {
        prelogin: () =>
          Promise.resolve({
            kdfSalt: Buffer.alloc(16, 1).toString('base64'),
            kdfParams: {
              algorithm: 'argon2id',
              version: 19,
              memoryKiB: 19_456,
              passes: 2,
              parallelism: 1,
            },
          }),
        deleteAccount: (request: { authKey: string }) => {
          sent.push(request.authKey);
          return deleteAccount();
        },
      },
    } as unknown as ApiClient;
    const handlers = createAuthCommands({
      prompter: script.prompter,
      reporter,
      api: () => api,
      secrets: () => Promise.resolve(secrets),
      crypto: () => Promise.resolve(crypto),
      passwordChecker: () => Promise.reject(new Error('not used')),
      deviceName: 'pc',
      localState: () => state,
      ...(stdin !== undefined && { readPasswordStdin: () => Promise.resolve(stdin) }),
    });
    return { run: handlers.accountDelete, asked: script.asked, lines, saved, sent };
  }

  it('asks for the username and password, deletes, and cleans up this PC', async () => {
    await state.setRevision('claude-code', 'global', 3);
    const t = account(['ahmed', 'plum-garage-violin-47'], () => Promise.resolve());
    await t.run({ yes: true, passwordStdin: false });
    expect(t.asked).toEqual(['Type your username to confirm', 'Password']);
    expect(Buffer.from(t.sent[0] ?? '', 'base64')).toHaveLength(32);
    expect(t.sent[0]).not.toContain('plum');
    expect(t.saved.size).toBe(0);
    expect(await state.knownRevisions()).toEqual({});
    expect(t.lines[0]).toContain('cannot be undone');
    expect(t.lines.at(-1)).toContain('Account "ahmed" and all its saved setups were deleted');
  });

  it('from a script: username and password by flags, confirmed with --yes', async () => {
    const t = account([], () => Promise.resolve(), 'plum-garage-violin-47');
    await t.run({ yes: true, passwordStdin: true, username: 'ahmed' });
    expect(t.asked).toEqual([]);
    expect(t.sent).toHaveLength(1);
    expect(t.saved.size).toBe(0);
  });

  it('from a script without --yes: refuses, deleting nothing', async () => {
    const t = account([], () => Promise.resolve(), 'plum-garage-violin-47');
    await expect(t.run({ yes: false, passwordStdin: true, username: 'ahmed' })).rejects.toThrow(
      'Nothing was deleted. Add --yes to confirm deleting the account.',
    );
    expect(t.sent).toEqual([]);
    expect(t.saved.has('session-token')).toBe(true);
  });

  it('a wrong password deletes nothing and keeps the login', async () => {
    const t = account(['ahmed', 'wrong'], () =>
      Promise.reject(new ApiError(401, 'unauthorized', 'Wrong password')),
    );
    await expect(t.run({ yes: false, passwordStdin: false })).rejects.toThrow(
      'Wrong username or password. Nothing was deleted.',
    );
    expect(t.saved.has('session-token')).toBe(true);
  });

  it('an ended session clears the login and says to log in again', async () => {
    const t = account(['ahmed', 'pw'], () =>
      Promise.reject(new ApiError(401, 'unauthorized', 'Log in again: no valid session')),
    );
    await expect(t.run({ yes: false, passwordStdin: false })).rejects.toThrow(
      'Your session has expired',
    );
    expect(t.saved.has('session-token')).toBe(false);
  });

  it('a lost answer says the result is unknown and keeps everything here', async () => {
    const t = account(['ahmed', 'pw'], () =>
      Promise.reject(new OutcomeUnknownError('delete-account')),
    );
    await expect(t.run({ yes: false, passwordStdin: false })).rejects.toBeInstanceOf(
      OutcomeUnknownError,
    );
    expect(t.saved.has('session-token')).toBe(true);
  });
});

describe('formatting', () => {
  it.each([
    ['2026-09-25T11:59:30Z', 'just now'],
    ['2026-09-25T11:55:00Z', '5 minutes ago'],
    ['2026-09-25T11:00:00Z', '1 hour ago'],
    ['2026-09-24T11:00:00Z', 'yesterday'],
    ['2026-09-20T12:00:00Z', '5 days ago'],
    ['2026-01-02T12:00:00Z', '2026-01-02'],
  ])('%s is %s', (iso, text) => {
    expect(timeAgo(iso, NOW)).toBe(text);
  });

  it('sizes', () => {
    expect([formatSize(900), formatSize(5120), formatSize(2.5 * 1024 * 1024)]).toEqual([
      '900 B',
      '5 KB',
      '2.5 MB',
    ]);
  });
});
