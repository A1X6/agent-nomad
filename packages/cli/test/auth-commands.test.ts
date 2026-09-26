import {
  DEFAULT_KDF_PARAMS,
  type KdfParams,
  type LoginRequest,
  type RegisterRequest,
} from '@agentnomad/contracts';
import { createSodiumCryptoService, type CryptoService } from '@agentnomad/core';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  ApiError,
  createAuthCommands,
  createPasswordChecker,
  describeError,
  describeWait,
  deviceNameOf,
  FILE_BACKEND_NOTE,
  loadZxcvbnChecker,
  NetworkError,
  NO_RECOVERY_WARNING,
  SessionExpiredError,
  withSession,
  type ApiClient,
  type PasswordChecker,
  type Prompter,
  type Reporter,
  type SecretName,
  type SecretStore,
} from '../src/index.ts';

const STRONG = 'plum-garage-violin-47';
/** Answered by typing: no flags. */
const ASK = { yes: false, passwordStdin: false };

let realCrypto: CryptoService;
let zxcvbn: PasswordChecker;
beforeAll(async () => {
  realCrypto = await createSodiumCryptoService();
  zxcvbn = await loadZxcvbnChecker();
});

/** Real crypto with the cheapest allowed Argon2id settings, so tests stay fast. */
const fastCrypto = (): CryptoService => ({
  ...realCrypto,
  deriveKeys: (password, salt) =>
    realCrypto.deriveKeys(password, salt, {
      ...DEFAULT_KDF_PARAMS,
      memoryKiB: 19_456,
      passes: 2,
    } satisfies KdfParams),
});

function memorySecrets(backend: SecretStore['backend'] = 'keychain') {
  const saved = new Map<SecretName, string>();
  const store: SecretStore = {
    backend,
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
  return { store, saved };
}

/** Answers questions from a script. A validator's complaint is recorded and the next answer used. */
function scriptedPrompter(answers: (string | boolean)[]) {
  const asked: string[] = [];
  const rejected: string[] = [];
  const next = (message: string, validate?: (value: string) => string | undefined) => {
    for (;;) {
      asked.push(message);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`No answer scripted for "${message}"`);
      const problem = typeof answer === 'string' ? validate?.(answer) : undefined;
      if (problem === undefined) return answer;
      rejected.push(problem);
    }
  };
  const prompter: Prompter = {
    select: () => Promise.reject(new Error('not used')),
    multiselect: () => Promise.reject(new Error('not used')),
    text: (message, options) => Promise.resolve(next(message, options?.validate) as string),
    password: (message, options) => Promise.resolve(next(message, options?.validate) as string),
    confirm: (message) => Promise.resolve(next(message) as boolean),
  };
  return { prompter, asked, rejected, left: answers };
}

function recordingReporter() {
  const lines: string[] = [];
  const reporter: Reporter = {
    info: (m) => lines.push(`info: ${m}`),
    success: (m) => lines.push(`success: ${m}`),
    warn: (m) => lines.push(`warn: ${m}`),
    error: (m) => lines.push(`error: ${m}`),
    spinner: () => ({
      start: (m) => lines.push(`spin: ${m}`),
      stop: (m) => lines.push(`done: ${m ?? ''}`),
    }),
  };
  return { reporter, lines };
}

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

  const api: ApiClient = {
    auth: {
      prelogin: ({ username }) => {
        calls.push('prelogin');
        const user = users.get(username);
        return Promise.resolve({
          kdfSalt: user?.kdfSalt ?? Buffer.alloc(16, 7).toString('base64'),
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
      logout: () => {
        calls.push('logout');
        if (logoutFailure) return Promise.reject(logoutFailure);
        if (currentToken === null || !sessions.delete(currentToken)) {
          return Promise.reject(new ApiError(401, 'unauthorized', 'Session expired'));
        }
        return Promise.resolve();
      },
      deleteAccount: () => Promise.reject(new Error('not used')),
    },
    bundles: {
      list: () => Promise.reject(new Error('not used')),
      get: () => Promise.reject(new Error('not used')),
      put: () => Promise.reject(new Error('not used')),
      delete: () => Promise.reject(new Error('not used')),
    },
  };
  return {
    api,
    users,
    sessions,
    calls,
    useToken: (token: string | null) => (currentToken = token),
    failLogout: (error: Error) => (logoutFailure = error),
  };
}

function setup(
  answers: (string | boolean)[],
  options: {
    server?: ReturnType<typeof fakeServer>;
    secrets?: ReturnType<typeof memorySecrets>;
    /** What `--password-stdin` reads. */
    stdin?: string;
  } = {},
) {
  const server = options.server ?? fakeServer();
  const secrets = options.secrets ?? memorySecrets();
  const script = scriptedPrompter(answers);
  const { reporter, lines } = recordingReporter();
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
    crypto: () => Promise.resolve(fastCrypto()),
    passwordChecker: () => Promise.resolve(zxcvbn),
    deviceName: 'laptop',
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
    const server = fakeServer();
    await setup(registerAnswers(), { server }).commands.register(ASK);
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
    const t = setup(registerAnswers());
    await t.commands.register(ASK);
    const before = new Map(t.secrets.saved);

    const again = setup([false], { server: t.server, secrets: t.secrets });
    await again.commands.login(ASK);
    expect(t.secrets.saved).toEqual(before);
    expect(again.lines.at(-1)).toBe('info: Nothing changed.');
  });

  it('logs out first when the user says yes', async () => {
    const t = setup(registerAnswers());
    await t.commands.register(ASK);
    const again = setup([true, ...registerAnswers('second')], {
      server: t.server,
      secrets: t.secrets,
    });
    await again.commands.register(ASK);
    expect(t.server.calls).toEqual(['register', 'logout', 'register']);
    expect(t.server.sessions.size).toBe(1);
  });
});

describe('login', () => {
  it('unlocks the same data key on another PC with the same password', async () => {
    const server = fakeServer();
    const first = setup(registerAnswers(), { server });
    await first.commands.register(ASK);

    const otherPc = setup(['ahmed', STRONG], { server });
    await otherPc.commands.login(ASK);
    expect(otherPc.secrets.saved.get('data-key')).toBe(first.secrets.saved.get('data-key'));
    expect(otherPc.secrets.saved.get('session-token')).not.toBe(
      first.secrets.saved.get('session-token'),
    );
    expect(otherPc.lines.at(-1)).toBe('success: Logged in as "ahmed".');
    expect(server.calls.slice(-2)).toEqual(['prelogin', 'login']);
  });

  it('a wrong password saves nothing', async () => {
    const server = fakeServer();
    await setup(registerAnswers(), { server }).commands.register(ASK);
    const t = setup(['ahmed', 'plum-garage-violin-99'], { server });
    await expect(t.commands.login(ASK)).rejects.toThrow('Wrong username or password');
    expect(t.secrets.saved.size).toBe(0);
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
    await expect(t.commands.register(flags())).rejects.toThrow();
    expect(t.server.calls).toEqual([]);
    expect(t.secrets.saved.size).toBe(0);
  });

  it('an empty standard input is refused', async () => {
    const t = setup([], { stdin: '' });
    await expect(t.commands.login(flags())).rejects.toThrow('no password on standard input');
  });

  it('an invalid --username is refused like a typed one', async () => {
    const t = setup([], { stdin: STRONG });
    await expect(t.commands.login(flags({ username: 'Ahmed Ali' }))).rejects.toThrow();
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
    expect(t.server.calls).toEqual(['register', 'logout', 'prelogin', 'login']);
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
    const t = setup(registerAnswers());
    await t.commands.register(ASK);
    const out = setup([], { server: t.server, secrets: t.secrets });
    await out.commands.logout();
    expect(t.server.sessions.size).toBe(0);
    expect(t.secrets.saved.size).toBe(0);
    expect(out.lines.at(-1)).toBe('success: Logged out. Your login was removed from this PC.');
  });

  it('still logs out this PC when the server cannot be reached', async () => {
    const t = setup(registerAnswers());
    await t.commands.register(ASK);
    t.server.failLogout(new NetworkError('unreachable', 'Could not reach the server.'));
    const out = setup([], { server: t.server, secrets: t.secrets });
    await out.commands.logout();
    expect(t.secrets.saved.size).toBe(0);
    expect(out.lines.some((line) => line.startsWith('warn: Could not reach the server'))).toBe(
      true,
    );
  });

  it('quietly logs out when the server session had already expired', async () => {
    const t = setup(registerAnswers());
    await t.commands.register(ASK);
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

describe('password policy', () => {
  it.each([
    'password123456',
    'qwertyuiop12',
    'ahmed1234567890',
    'Summer2026!!!',
    'aaaaaaaaaaaaaaaa',
    'agentnomad2026!',
    'short1!',
  ])('rejects %s', (password) => {
    expect(zxcvbn(password, ['ahmed'])).toBeDefined();
  });

  it.each([STRONG, 'correct horse battery staple', 'purple monkey dishwasher', 'k9$Lm2#vQ8!pZr'])(
    'accepts %s',
    (password) => {
      expect(zxcvbn(password, ['ahmed'])).toBeUndefined();
    },
  );

  it('counts characters, not bytes, and caps the length', () => {
    const accept = createPasswordChecker(() => ({ score: 4, warning: null, suggestions: [] }));
    expect(accept('ééééééééééé', [])).toContain('at least 12');
    expect(accept('éééééééééééé', [])).toBeUndefined();
    expect(accept('x'.repeat(257), [])).toContain('at most 256');
  });
});

describe('sessions and messages', () => {
  it('an expired session clears the login and says to log in again', async () => {
    const { store, saved } = memorySecrets();
    saved.set('session-token', 'x').set('data-key', 'y');
    await expect(
      withSession(store, () => Promise.reject(new ApiError(401, 'unauthorized', 'expired'))),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    expect(saved.size).toBe(0);
  });

  it('other errors leave the login alone', async () => {
    const { store, saved } = memorySecrets();
    saved.set('session-token', 'x');
    await expect(
      withSession(store, () => Promise.reject(new ApiError(404, 'not_found', 'gone'))),
    ).rejects.toBeInstanceOf(ApiError);
    expect(saved.size).toBe(1);
  });

  it('rate limits say when to try again', () => {
    const limited = (seconds?: number) =>
      new ApiError(429, 'rate_limited', 'Too many requests', {
        ...(seconds !== undefined && { retryAfterSeconds: seconds }),
      });
    expect(describeError(limited(240))).toBe('Too many attempts. Try again in 4 minutes.');
    expect(describeError(limited(61))).toBe('Too many attempts. Try again in 2 minutes.');
    expect(describeError(limited(1))).toBe('Too many attempts. Try again in 1 second.');
    expect(describeError(limited())).toBe('Too many attempts. Wait a while and try again.');
    expect(describeWait(60)).toBe('1 minute');
  });

  it('device names are one short line', () => {
    expect(deviceNameOf('LAPTOP-01')).toBe('LAPTOP-01');
    expect(deviceNameOf('a\nb')).toBe('ab');
    expect(deviceNameOf('x'.repeat(100))).toHaveLength(64);
    expect(deviceNameOf('  ')).toBe('unknown device');
  });
});
