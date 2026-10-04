import {
  DEFAULT_KDF_PARAMS,
  KDF_SALT_BYTES,
  type KdfParams,
  type LoginRequest,
  type RegisterRequest,
  WRONG_PASSWORD_MESSAGE,
} from '@agentnomad/contracts';
import type { CryptoService } from '@agentnomad/core';

import { describe, expect, it } from 'vitest';

import {
  crypto as realCrypto,
  dataKey,
  fakeApi,
  localStateIn,
  memorySecrets,
  memorySecretStore,
  recordingReporter,
  scriptedPrompter,
  STRONG,
  useDataKey,
  useTempDir,
  useZxcvbnChecker,
  withTempDir,
  zxcvbn,
} from './fakes.ts';

import {
  ApiError,
  createAuthCommands,
  FILE_BACKEND_NOTE,
  NetworkError,
  NO_RECOVERY_WARNING,
  OutcomeUnknownError,
  PromptCancelledError,
  type LocalState,
  type SecretName,
} from '../src/index.ts';

/** Answered by typing: no flags. */
const ASK = { yes: false, passwordStdin: false };

useDataKey();
useZxcvbnChecker();

/** The cheapest Argon2id settings the server allows, so tests stay fast. */
const FAST_KDF_PARAMS: KdfParams = { ...DEFAULT_KDF_PARAMS, memoryKiB: 19_456, passes: 2 };

/** Real crypto with FAST_KDF_PARAMS. */
const fastCrypto = (): CryptoService => ({
  ...realCrypto,
  deriveKeys: (password, salt) => realCrypto.deriveKeys(password, salt, FAST_KDF_PARAMS),
});

/** An in-memory server with the real API's rules for accounts and sessions. */
function fakeServer() {
  const users = new Map<string, RegisterRequest>();
  const sessions = new Set<string>();
  let currentToken: string | null = null;
  let counter = 0;
  const calls: string[] = [];
  const newSession = () => {
    counter += 1;
    const sessionToken = String(counter).padStart(43, 't');
    sessions.add(sessionToken);
    return { sessionToken, expiresAt: '2026-12-24T00:00:00Z' };
  };
  const unauthorized = () => new ApiError(401, 'unauthorized', 'Wrong username or password');
  let logoutFailure: Error | undefined;
  /** The token each logout was given; `undefined` = the stored one. */
  const logoutTokens: (string | undefined)[] = [];

  const api = fakeApi({
    auth: {
      prelogin: ({ username }) => {
        calls.push('prelogin');
        const user = users.get(username);
        return Promise.resolve({
          kdfSalt: user?.kdfSalt ?? Buffer.alloc(KDF_SALT_BYTES, 7).toString('base64'),
          kdfParams: user?.kdfParams ?? DEFAULT_KDF_PARAMS,
        });
      },
      register: (request) => {
        calls.push('register');
        if (users.has(request.username)) {
          return Promise.reject(new ApiError(409, 'username_taken', 'That username is taken'));
        }
        users.set(request.username, request);
        return Promise.resolve(newSession());
      },
      login: (request: LoginRequest) => {
        calls.push('login');
        const user = users.get(request.username);
        if (user?.authKey !== request.authKey) return Promise.reject(unauthorized());
        return Promise.resolve({ ...newSession(), wrappedDataKey: user.wrappedDataKey });
      },
      logout: (sessionToken?: string) => {
        calls.push('logout');
        logoutTokens.push(sessionToken);
        if (logoutFailure) return Promise.reject(logoutFailure);
        const token = sessionToken ?? currentToken;
        if (token === null || !sessions.delete(token)) {
          return Promise.reject(new ApiError(401, 'unauthorized', 'Session expired'));
        }
        return Promise.resolve();
      },
      deleteAccount: ({ authKey }) => {
        calls.push('deleteAccount');
        const user = [...users.values()].find((known) => known.authKey === authKey);
        if (user === undefined) {
          return Promise.reject(new ApiError(401, 'unauthorized', WRONG_PASSWORD_MESSAGE));
        }
        users.delete(user.username);
        return Promise.resolve();
      },
    },
  });
  return {
    api,
    users,
    sessions,
    calls,
    logoutTokens,
    useToken: (token: string | null) => (currentToken = token),
    failLogout: (error: Error) => (logoutFailure = error),
  };
}

/** Damages ahmed's saved data key, so a login succeeds but unlocking fails; returns the original. */
function damageWrappedKey(server: ReturnType<typeof fakeServer>) {
  const user = server.users.get('ahmed');
  if (user === undefined) throw new Error('not registered');
  const wrapped = Buffer.from(user.wrappedDataKey, 'base64');
  wrapped[30] = (wrapped[30] ?? 0) ^ 1;
  server.users.set('ahmed', { ...user, wrappedDataKey: wrapped.toString('base64') });
  return user;
}

function setup(
  answers: (string | boolean | Error)[],
  options: {
    crypto?: CryptoService;
    server?: ReturnType<typeof fakeServer>;
    secrets?: ReturnType<typeof memorySecrets>;
    /** What `--password-stdin` reads. */
    stdin?: string;
    localState?: LocalState;
  } = {},
) {
  const server = options.server ?? fakeServer();
  const secrets = options.secrets ?? memorySecrets();
  const script = scriptedPrompter(answers);
  const { reporter, lines } = recordingReporter({ spinner: true });
  // The fake server sees the token the CLI would send.
  const originalGet = secrets.store.get.bind(secrets.store);
  secrets.store.get = async (name) => {
    const value = await originalGet(name);
    if (name === 'session-token') server.useToken(value);
    return value;
  };
  const commands = createAuthCommands({
    prompter: script.prompter,
    reporter,
    api: () => server.api,
    secrets: () => Promise.resolve(secrets.store),
    crypto: () => Promise.resolve(options.crypto ?? fastCrypto()),
    passwordChecker: () => Promise.resolve(zxcvbn),
    deviceName: 'laptop',
    ...(options.localState !== undefined && { localState: () => options.localState as LocalState }),
    ...(options.stdin !== undefined && {
      readPasswordStdin: () => Promise.resolve(options.stdin ?? ''),
    }),
  });
  return { commands, server, secrets, script, lines };
}

const registerAnswers = (username = 'ahmed', password = STRONG) => [
  username,
  true, // understood: no password reset
  password,
  password,
];

/** "ahmed" registered, and so logged in, on a fresh fake server. */
async function registeredAhmed() {
  const t = setup(registerAnswers());
  await t.commands.register(ASK);
  return t;
}

describe('register', () => {
  it('creates the account, shows the no-recovery warning and saves the login', async () => {
    const t = setup(registerAnswers());
    await t.commands.register(ASK);

    const sent = t.server.users.get('ahmed');
    expect(sent?.kdfParams).toEqual(DEFAULT_KDF_PARAMS);
    expect(Buffer.from(sent?.authKey ?? '', 'base64')).toHaveLength(32);
    expect(Buffer.from(sent?.wrappedDataKey ?? '', 'base64')).toHaveLength(72);
    expect(sent?.deviceName).toBe('laptop');

    expect(t.secrets.saved.get('session-token')).toHaveLength(43);
    expect(Buffer.from(t.secrets.saved.get('data-key') ?? '', 'base64')).toHaveLength(32);
    expect(t.lines).toContain(`warn: ${NO_RECOVERY_WARNING}`);
    expect(t.lines.at(-1)).toBe('success: Account "ahmed" created. You are logged in on this PC.');
  });

  it('never sends the password itself', async () => {
    const t = setup(registerAnswers());
    await t.commands.register(ASK);
    expect(JSON.stringify(t.server.users.get('ahmed'))).not.toContain(STRONG);
  });

  it('stops without creating anything when the warning is not accepted', async () => {
    const t = setup(['ahmed', false]);
    await t.commands.register(ASK);
    expect(t.server.calls).toEqual([]);
    expect(t.secrets.saved.size).toBe(0);
    expect(t.lines.at(-1)).toBe('info: No account was created.');
  });

  it('asks again for a weak password and explains why', async () => {
    const t = setup(['ahmed', true, 'password123456', 'short', STRONG, STRONG]);
    await t.commands.register(ASK);
    expect(t.script.rejected).toHaveLength(2);
    expect(t.script.rejected[1]).toContain('at least 12 characters');
    expect(t.server.users.has('ahmed')).toBe(true);
  });

  it('asks again when the second password does not match', async () => {
    const t = setup(['ahmed', true, STRONG, 'plum-garage-violin-48', STRONG]);
    await t.commands.register(ASK);
    expect(t.script.rejected).toEqual(['The passwords do not match.']);
  });

  it('refuses an invalid username before anything else', async () => {
    const t = setup(['Ahmed Ali', ...registerAnswers()]);
    await t.commands.register(ASK);
    expect(t.script.rejected).toHaveLength(1);
    expect(t.server.users.has('ahmed')).toBe(true);
  });

  it('passes on "username taken" and saves nothing', async () => {
    const { server } = await registeredAhmed();
    const t = setup(registerAnswers(), { server });
    await expect(t.commands.register(ASK)).rejects.toMatchObject({ code: 'username_taken' });
    expect(t.secrets.saved.size).toBe(0);
  });

  it('mentions the private file when there is no keychain', async () => {
    const t = setup(registerAnswers(), { secrets: memorySecrets('file') });
    await t.commands.register(ASK);
    expect(t.lines.at(-1)).toBe(`warn: ${FILE_BACKEND_NOTE}`);
  });
});

describe('already logged in', () => {
  it('keeps the current login when the user says no', async () => {
    const t = await registeredAhmed();
    const before = new Map(t.secrets.saved);

    const again = setup([false], { server: t.server, secrets: t.secrets });
    await again.commands.login(ASK);
    expect(t.secrets.saved).toEqual(before);
    expect(again.lines.at(-1)).toBe('info: Nothing changed.');
  });

  it('logs out first when the user says yes', async () => {
    const t = await registeredAhmed();
    const again = setup([true, ...registerAnswers('second')], {
      server: t.server,
      secrets: t.secrets,
    });
    await again.commands.register(ASK);
    // The old session ends only once the new account and its session exist (UX-01).
    expect(t.server.calls).toEqual(['register', 'register', 'logout']);
    expect(t.server.sessions.size).toBe(1);
    expect(t.server.sessions.has(t.secrets.saved.get('session-token') ?? '')).toBe(true);
  });
});

describe('already logged in: the current login stays until the new one works (UX-01)', () => {
  const QUESTION = 'You are already logged in on this PC. Log out and continue?';

  /** "ahmed" registered and logged in on this PC; returns what is saved here now. */
  async function loggedInAsAhmed() {
    const t = await registeredAhmed();
    t.server.calls.length = 0;
    return { server: t.server, secrets: t.secrets, before: new Map(t.secrets.saved) };
  }

  /** The login on this PC and its session on the server are both untouched. */
  function expectKept(pcLogin: Awaited<ReturnType<typeof loggedInAsAhmed>>) {
    expect(pcLogin.secrets.saved).toEqual(pcLogin.before);
    expect(pcLogin.server.sessions.has(pcLogin.before.get('session-token') ?? '')).toBe(true);
    expect(pcLogin.server.calls).not.toContain('logout');
  }

  it('a wrong password keeps the current login', async () => {
    const pcLogin = await loggedInAsAhmed();
    const t = setup([true, 'ahmed', 'plum-garage-violin-99'], pcLogin);
    await expect(t.commands.login(ASK)).rejects.toThrow('Wrong username or password');
    expect(t.script.asked[0]).toBe(QUESTION);
    expectKept(pcLogin);
  });

  it('a wrong piped password with --yes keeps the current login', async () => {
    const pcLogin = await loggedInAsAhmed();
    const t = setup([], { ...pcLogin, stdin: 'plum-garage-violin-99' });
    await expect(
      t.commands.login({ yes: true, passwordStdin: true, username: 'ahmed' }),
    ).rejects.toThrow('Wrong username or password');
    expectKept(pcLogin);
  });

  it('Ctrl+C at the password keeps the current login', async () => {
    const pcLogin = await loggedInAsAhmed();
    const t = setup([true, 'ahmed', new PromptCancelledError()], pcLogin);
    await expect(t.commands.login(ASK)).rejects.toBeInstanceOf(PromptCancelledError);
    expectKept(pcLogin);
  });

  it('a data key that does not unlock ends only the new session (T66)', async () => {
    const pcLogin = await loggedInAsAhmed();
    damageWrappedKey(pcLogin.server);
    const t = setup([true, 'ahmed', STRONG], pcLogin);
    await expect(t.commands.login(ASK)).rejects.toThrow('could not be unlocked');
    expect(pcLogin.server.calls).toEqual(['prelogin', 'login', 'logout']);
    expect(pcLogin.server.logoutTokens).toHaveLength(1);
    expect(pcLogin.server.logoutTokens[0]).not.toBe(pcLogin.before.get('session-token'));
    expect(pcLogin.secrets.saved).toEqual(pcLogin.before);
    expect(pcLogin.server.sessions.has(pcLogin.before.get('session-token') ?? '')).toBe(true);
  });

  it('register: a taken username or a "no" at the warning keeps the current login', async () => {
    const pcLogin = await loggedInAsAhmed();
    const taken = setup([true, ...registerAnswers('ahmed')], pcLogin);
    await expect(taken.commands.register(ASK)).rejects.toMatchObject({ code: 'username_taken' });
    expectKept(pcLogin);

    const no = setup([true, 'second', false], pcLogin);
    await no.commands.register(ASK);
    expect(no.lines.at(-1)).toBe('info: No account was created.');
    expectKept(pcLogin);
  });

  it('a login that works ends the old session, then saves the new one', async () => {
    const pcLogin = await loggedInAsAhmed();
    const t = setup([true, 'ahmed', STRONG], pcLogin);
    await t.commands.login(ASK);
    expect(pcLogin.server.calls).toEqual(['prelogin', 'login', 'logout']);
    // The old session, read from this PC's store, not the new one.
    expect(pcLogin.server.logoutTokens).toEqual([undefined]);
    const token = pcLogin.secrets.saved.get('session-token') ?? '';
    expect(token).not.toBe(pcLogin.before.get('session-token'));
    expect([...pcLogin.server.sessions]).toEqual([token]);
    expect(pcLogin.secrets.saved.get('data-key')).toBe(pcLogin.before.get('data-key'));
  });
});

describe('login', () => {
  it('unlocks the same data key on another PC with the same password', async () => {
    const first = await registeredAhmed();
    const { server } = first;

    const otherPc = setup(['ahmed', STRONG], { server });
    await otherPc.commands.login(ASK);
    expect(otherPc.secrets.saved.get('data-key')).toBe(first.secrets.saved.get('data-key'));
    expect(otherPc.secrets.saved.get('session-token')).not.toBe(
      first.secrets.saved.get('session-token'),
    );
    expect(otherPc.lines.at(-1)).toBe('success: Logged in as "ahmed".');
    expect(server.calls.slice(-2)).toEqual(['prelogin', 'login']);
  });

  it('another account on this PC starts with no remembered revisions (T56)', async () => {
    const server = fakeServer();
    await setup(registerAnswers('alice'), { server }).commands.register(ASK);
    await setup(registerAnswers('bob'), { server }).commands.register(ASK);
    await withTempDir('agentnomad-auth-', async (dir) => {
      const state = localStateIn(dir);
      const secrets = memorySecrets();
      const pc = (answers: (string | boolean)[]) =>
        setup(answers, { server, secrets, localState: state }).commands;

      await pc(['alice', STRONG]).login(ASK);
      await state.setRevision('claude-code', 'global', 7);
      await state.rememberProject(dir, 'my-app');
      await pc([]).logout();
      await pc(['alice', STRONG]).login(ASK);
      expect(await state.revisionOf('claude-code', 'global')).toBe(7);

      await pc([]).logout();
      await pc(['bob', STRONG]).login(ASK);
      expect(await state.revisionOf('claude-code', 'global')).toBeNull();
      expect(await state.projectNameFor(dir)).toBe('my-app');

      // Registering a new account is a change of account too.
      await state.setRevision('claude-code', 'global', 2);
      await pc([]).logout();
      await pc(registerAnswers('carol')).register(ASK);
      expect(await state.knownRevisions()).toEqual({});
    });
  });

  it('a wrong password saves nothing', async () => {
    const { server } = await registeredAhmed();
    const t = setup(['ahmed', 'plum-garage-violin-99'], { server });
    await expect(t.commands.login(ASK)).rejects.toThrow('Wrong username or password');
    expect(t.secrets.saved.size).toBe(0);
  });
});

describe('login: a data key that does not unlock (T66)', () => {
  const UNLOCK_ERROR = 'Logged in, but your data key could not be unlocked with this password.';

  /** "ahmed" registered, then his saved data key damaged, so login succeeds but unlocking fails. */
  async function lockedAccount() {
    const { server } = await registeredAhmed();
    damageWrappedKey(server);
    server.calls.length = 0;
    return server;
  }

  it('ends the new session on the server with its own token, then gives the same error', async () => {
    const server = await lockedAccount();
    const sessionsBefore = new Set(server.sessions);
    const keys = secretTrackingCrypto();
    const t = setup(['ahmed', STRONG], { server, crypto: keys.crypto });

    const error = await t.commands.login(ASK).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(UNLOCK_ERROR);
    expect(server.calls).toEqual(['prelogin', 'login', 'logout']);
    // The token from the login answer, never one read from this PC's secret store.
    const [token] = server.logoutTokens;
    expect(server.logoutTokens).toHaveLength(1);
    expect(token).toBeDefined();
    expect(sessionsBefore.has(token ?? '')).toBe(false);
    expect([...server.sessions]).toEqual([...sessionsBefore]);
    expect(t.secrets.saved.size).toBe(0);
    expect(keys.handedOut).toHaveLength(2);
    expect(keys.allWiped()).toBe(true);
  });

  it('still gives the same error when that logout fails or times out', async () => {
    const failures = [
      new NetworkError('timeout', 'The server took too long to answer.'),
      new NetworkError('unreachable', 'fetch failed'),
      new ApiError(500, 'internal_error', 'Something went wrong'),
    ];
    for (const failure of failures) {
      const server = await lockedAccount();
      server.failLogout(failure);
      const keys = secretTrackingCrypto();
      const t = setup(['ahmed', STRONG], { server, crypto: keys.crypto });

      const error = await t.commands.login(ASK).catch((e: unknown) => e);
      expect((error as Error).message).toBe(UNLOCK_ERROR);
      expect((error as Error).cause).not.toBe(failure);
      expect(server.calls).toEqual(['prelogin', 'login', 'logout']);
      expect(t.secrets.saved.size).toBe(0);
      expect(keys.allWiped()).toBe(true);
      expect(t.lines.filter((line) => line.startsWith('warn:'))).toEqual([]);
    }
  });

  it('a normal login never logs out', async () => {
    const { server } = await registeredAhmed();
    const t = setup(['ahmed', STRONG], { server });
    await t.commands.login(ASK);
    expect(server.calls).toEqual(['register', 'prelogin', 'login']);
    expect(server.logoutTokens).toEqual([]);
  });
});

describe('from a script (--username, --password-stdin, --yes)', () => {
  const flags = (extra: Partial<{ yes: boolean; username: string }> = {}) => ({
    yes: true,
    passwordStdin: true,
    username: 'ahmed',
    ...extra,
  });

  it('registers without asking anything, and the password is not asked twice', async () => {
    const t = setup([], { stdin: STRONG });
    await t.commands.register(flags());
    expect(t.script.asked).toEqual([]);
    expect(t.server.users.has('ahmed')).toBe(true);
    expect(t.lines).toContain(`warn: ${NO_RECOVERY_WARNING}`);
  });

  it('a weak piped password stops register with the reason, creating nothing', async () => {
    const t = setup([], { stdin: 'password123456' });
    // zxcvbn's reason, as the CLI shows it.
    await expect(t.commands.register(flags())).rejects.toThrow(
      'This is similar to a commonly used password',
    );
    expect(t.server.calls).toEqual([]);
    expect(t.secrets.saved.size).toBe(0);
  });

  it('an empty standard input is refused', async () => {
    const t = setup([], { stdin: '' });
    await expect(t.commands.login(flags())).rejects.toThrow('no password on standard input');
  });

  it('an invalid --username is refused like a typed one', async () => {
    const t = setup([], { stdin: STRONG });
    await expect(t.commands.login(flags({ username: 'Ahmed Ali' }))).rejects.toThrow(
      'Username must be 3–32 lowercase letters',
    );
    expect(t.server.calls).toEqual([]);
  });

  it('logs in on another PC with the same data key', async () => {
    const server = fakeServer();
    const first = setup([], { server, stdin: STRONG });
    await first.commands.register(flags());
    const otherPc = setup([], { server, stdin: STRONG });
    await otherPc.commands.login(flags({ yes: false }));
    expect(otherPc.script.asked).toEqual([]);
    expect(otherPc.secrets.saved.get('data-key')).toBe(first.secrets.saved.get('data-key'));
  });

  it('--yes replaces a login already on this PC without asking', async () => {
    const t = setup([], { stdin: STRONG });
    await t.commands.register(flags());
    const again = setup([], { server: t.server, secrets: t.secrets, stdin: STRONG });
    await again.commands.login(flags());
    expect(again.script.asked).toEqual([]);
    expect(t.server.calls).toEqual(['register', 'prelogin', 'login', 'logout']);
  });

  it('without --yes, an existing login is still asked about', async () => {
    const t = setup([], { stdin: STRONG });
    await t.commands.register(flags());
    const again = setup([false], { server: t.server, secrets: t.secrets, stdin: STRONG });
    await again.commands.login(flags({ yes: false }));
    expect(again.script.asked).toEqual([
      'You are already logged in on this PC. Log out and continue?',
    ]);
  });

  it('asks for what the flags leave out', async () => {
    const t = setup(['ahmed'], { stdin: STRONG });
    await t.commands.register({ yes: true, passwordStdin: true });
    expect(t.script.asked).toEqual(['Choose a username']);
    expect(t.server.users.has('ahmed')).toBe(true);
  });
});

describe('logout', () => {
  it('ends the session on the server and forgets it here', async () => {
    const t = await registeredAhmed();
    const out = setup([], { server: t.server, secrets: t.secrets });
    await out.commands.logout();
    expect(t.server.sessions.size).toBe(0);
    expect(t.secrets.saved.size).toBe(0);
    expect(out.lines.at(-1)).toBe('success: Logged out. Your login was removed from this PC.');
  });

  it('still logs out this PC when the server cannot be reached', async () => {
    const t = await registeredAhmed();
    t.server.failLogout(new NetworkError('unreachable', 'Could not reach the server.'));
    const out = setup([], { server: t.server, secrets: t.secrets });
    await out.commands.logout();
    expect(t.secrets.saved.size).toBe(0);
    expect(out.lines.some((line) => line.startsWith('warn: Could not reach the server'))).toBe(
      true,
    );
  });

  it('names what the server said when it answered but did not end the session (UX-02)', async () => {
    const failures: [Error, string][] = [
      [
        new ApiError(429, 'rate_limited', 'Too many requests', { retryAfterSeconds: 60 }),
        'Too many attempts. Try again in 1 minute',
      ],
      [
        new ApiError(500, 'internal_error', 'boom'),
        'Something went wrong on the server. Try again later',
      ],
    ];
    for (const [failure, reason] of failures) {
      const t = await registeredAhmed();
      t.server.failLogout(failure);
      const out = setup([], { server: t.server, secrets: t.secrets });
      await out.commands.logout();
      expect(t.secrets.saved.size).toBe(0);
      expect(out.lines.filter((line) => line.startsWith('warn:'))).toEqual([
        `warn: The server did not end the session (${reason}), so only this PC was logged out. The session on the server ends by itself after 30 days unused.`,
      ]);
    }
  });

  it('quietly logs out when the server session had already expired', async () => {
    const t = await registeredAhmed();
    t.server.sessions.clear();
    const out = setup([], { server: t.server, secrets: t.secrets });
    await out.commands.logout();
    expect(t.secrets.saved.size).toBe(0);
    expect(out.lines.some((line) => line.startsWith('warn:'))).toBe(false);
  });

  it('says so when not logged in', async () => {
    const t = setup([]);
    await t.commands.logout();
    expect(t.server.calls).toEqual([]);
    expect(t.lines).toEqual(['info: You are not logged in on this PC.']);
  });
});

/**
 * Fast crypto that keeps every secret array it hands out: both derived keys, a new data key
 * (the only 32-byte random value) and an unlocked one.
 */
function secretTrackingCrypto(failDerive = false) {
  const base = fastCrypto();
  const handedOut: Uint8Array[] = [];
  const crypto: CryptoService = {
    ...base,
    deriveKeys: async (password, salt, params) => {
      if (failDerive) throw new Error('out of memory');
      const keys = await base.deriveKeys(password, salt, params);
      handedOut.push(keys.authKey, keys.passwordKey);
      return keys;
    },
    randomBytes: (length) => {
      const bytes = base.randomBytes(length);
      if (length === 32) handedOut.push(bytes);
      return bytes;
    },
    open: (sealed, key, associatedData) => {
      const opened = base.open(sealed, key, associatedData);
      handedOut.push(opened);
      return opened;
    },
  };
  const allWiped = () => handedOut.every((bytes) => bytes.every((byte) => byte === 0));
  return { crypto, handedOut, allWiped };
}

const failingSave = () => {
  const secrets = memorySecrets();
  secrets.store.setMany = () => Promise.reject(new Error('disk full'));
  return secrets;
};

describe('secret arrays are wiped on every path (BP-01)', () => {
  describe('register', () => {
    it('on success: both derived keys and the data key', async () => {
      const keys = secretTrackingCrypto();
      await setup(registerAnswers(), { crypto: keys.crypto }).commands.register(ASK);
      expect(keys.handedOut).toHaveLength(3);
      expect(keys.allWiped()).toBe(true);
    });

    it('on an error from the server, from saving the login or from deriving the keys', async () => {
      const { server } = await registeredAhmed();
      const taken = secretTrackingCrypto();
      await expect(
        setup(registerAnswers(), { server, crypto: taken.crypto }).commands.register(ASK),
      ).rejects.toMatchObject({ code: 'username_taken' });
      expect(taken.handedOut).toHaveLength(3);
      expect(taken.allWiped()).toBe(true);

      const notSaved = secretTrackingCrypto();
      await expect(
        setup(registerAnswers('other'), {
          crypto: notSaved.crypto,
          secrets: failingSave(),
        }).commands.register(ASK),
      ).rejects.toThrow('disk full');
      expect(notSaved.handedOut).toHaveLength(3);
      expect(notSaved.allWiped()).toBe(true);

      const notDerived = secretTrackingCrypto(true);
      await expect(
        setup(registerAnswers('third'), { crypto: notDerived.crypto }).commands.register(ASK),
      ).rejects.toThrow('out of memory');
      expect(notDerived.handedOut).toHaveLength(1);
      expect(notDerived.allWiped()).toBe(true);
    });

    it('on a cancelled question: no key is made before the last answer', async () => {
      const keys = secretTrackingCrypto();
      const t = setup(['ahmed', true, STRONG, new PromptCancelledError()], {
        crypto: keys.crypto,
      });
      await expect(t.commands.register(ASK)).rejects.toBeInstanceOf(PromptCancelledError);
      expect(keys.handedOut).toEqual([]);
      expect(t.server.calls).toEqual([]);
    });
  });

  describe('login', () => {
    it('on success: both derived keys and the unlocked data key', async () => {
      const { server } = await registeredAhmed();
      const keys = secretTrackingCrypto();
      await setup(['ahmed', STRONG], { server, crypto: keys.crypto }).commands.login(ASK);
      expect(keys.handedOut).toHaveLength(3);
      expect(keys.allWiped()).toBe(true);
    });

    it('on a wrong password, a data key that does not unlock, or a login not saved', async () => {
      const { server } = await registeredAhmed();
      const wrong = secretTrackingCrypto();
      await expect(
        setup(['ahmed', 'plum-garage-violin-99'], { server, crypto: wrong.crypto }).commands.login(
          ASK,
        ),
      ).rejects.toThrow('Wrong username or password');
      expect(wrong.handedOut).toHaveLength(2);
      expect(wrong.allWiped()).toBe(true);

      const user = damageWrappedKey(server);
      const locked = secretTrackingCrypto();
      await expect(
        setup(['ahmed', STRONG], { server, crypto: locked.crypto }).commands.login(ASK),
      ).rejects.toThrow('could not be unlocked');
      expect(locked.handedOut).toHaveLength(2);
      expect(locked.allWiped()).toBe(true);
      server.users.set('ahmed', user);

      const notSaved = secretTrackingCrypto();
      await expect(
        setup(['ahmed', STRONG], {
          server,
          crypto: notSaved.crypto,
          secrets: failingSave(),
        }).commands.login(ASK),
      ).rejects.toThrow('disk full');
      expect(notSaved.handedOut).toHaveLength(3);
      expect(notSaved.allWiped()).toBe(true);
    });

    it('on a cancelled question: no key is made', async () => {
      const keys = secretTrackingCrypto();
      const t = setup(['ahmed', new PromptCancelledError()], { crypto: keys.crypto });
      await expect(t.commands.login(ASK)).rejects.toBeInstanceOf(PromptCancelledError);
      expect(keys.handedOut).toEqual([]);
      expect(t.server.calls).toEqual([]);
    });
  });

  describe('account delete', () => {
    it('on success: both derived keys', async () => {
      const { server, secrets } = await registeredAhmed();
      const keys = secretTrackingCrypto();
      const t = setup(['ahmed', STRONG], { server, secrets, crypto: keys.crypto });
      await t.commands.accountDelete(ASK);
      expect(server.users.has('ahmed')).toBe(false);
      expect(keys.handedOut).toHaveLength(2);
      expect(keys.allWiped()).toBe(true);
    });

    it('on a wrong password', async () => {
      const { server, secrets } = await registeredAhmed();
      const keys = secretTrackingCrypto();
      const t = setup(['ahmed', 'plum-garage-violin-99'], {
        server,
        secrets,
        crypto: keys.crypto,
      });
      await expect(t.commands.accountDelete(ASK)).rejects.toThrow(
        'Wrong username or password. Nothing was deleted.',
      );
      expect(keys.handedOut).toHaveLength(2);
      expect(keys.allWiped()).toBe(true);
    });

    it('on a cancelled question: no key is made', async () => {
      const { server, secrets } = await registeredAhmed();
      const keys = secretTrackingCrypto();
      const t = setup(['ahmed', new PromptCancelledError()], {
        server,
        secrets,
        crypto: keys.crypto,
      });
      await expect(t.commands.accountDelete(ASK)).rejects.toBeInstanceOf(PromptCancelledError);
      expect(keys.handedOut).toEqual([]);
      expect(server.users.has('ahmed')).toBe(true);
    });
  });
});

describe('agentnomad account delete, logged in with a local state', () => {
  let state: LocalState;
  useTempDir('agentnomad-account-', (dir) => (state = localStateIn(dir)));

  function account(
    answers: unknown[],
    deleteAccount: () => Promise<void>,
    stdin?: string,
    saved = new Map<SecretName, string>(),
  ) {
    const script = scriptedPrompter(answers);
    const { reporter, lines } = recordingReporter();
    const secrets = memorySecretStore({ loggedIn: dataKey, saved });
    const sent: string[] = [];
    const api = fakeApi({
      auth: {
        prelogin: () =>
          Promise.resolve({
            kdfSalt: Buffer.alloc(KDF_SALT_BYTES, 1).toString('base64'),
            kdfParams: FAST_KDF_PARAMS,
          }),
        deleteAccount: (request) => {
          sent.push(request.authKey);
          return deleteAccount();
        },
      },
    });
    const handlers = createAuthCommands({
      prompter: script.prompter,
      reporter,
      api: () => api,
      secrets: () => Promise.resolve(secrets),
      crypto: () => Promise.resolve(realCrypto),
      passwordChecker: () => Promise.reject(new Error('not used')),
      deviceName: 'pc',
      localState: () => state,
      ...(stdin !== undefined && { readPasswordStdin: () => Promise.resolve(stdin) }),
    });
    return { run: handlers.accountDelete, asked: script.asked, lines, saved, sent };
  }

  it('asks for the username and password, deletes, and cleans up this PC', async () => {
    await state.setRevision('claude-code', 'global', 3);
    const t = account(['ahmed', STRONG], () => Promise.resolve());
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
    const t = account([], () => Promise.resolve(), STRONG);
    await t.run({ yes: true, passwordStdin: true, username: 'ahmed' });
    expect(t.asked).toEqual([]);
    expect(t.sent).toHaveLength(1);
    expect(t.saved.size).toBe(0);
  });

  it('from a script without --yes: refuses, deleting nothing', async () => {
    const t = account([], () => Promise.resolve(), STRONG);
    await expect(t.run({ yes: false, passwordStdin: true, username: 'ahmed' })).rejects.toThrow(
      'Nothing was deleted. Add --yes to confirm deleting the account.',
    );
    expect(t.sent).toEqual([]);
    expect(t.saved.has('session-token')).toBe(true);
  });

  it('a wrong password deletes nothing and keeps the login', async () => {
    const t = account(['ahmed', 'wrong'], () =>
      Promise.reject(new ApiError(401, 'unauthorized', WRONG_PASSWORD_MESSAGE)),
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
