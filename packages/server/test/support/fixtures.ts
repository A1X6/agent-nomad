import { createHash } from 'node:crypto';

import {
  DEFAULT_KDF_PARAMS,
  ErrorResponseSchema,
  KDF_SALT_BYTES,
  SessionResponseSchema,
  WRAPPED_DATA_KEY_BYTES,
  fromHex,
  type KdfParams,
} from '@agentnomad/contracts';
import { eq } from 'drizzle-orm';

import type { Database } from '../../src/db/database.ts';
import type {
  BundleKey,
  BundleMetaWrite,
  NewSession,
  NewUser,
  UserRecord,
} from '../../src/db/repositories.ts';
import { bundleBlobs, bundles, users } from '../../src/db/schema.ts';
import { createUserRepository } from '../../src/db/user-repository.ts';
import type { Logger } from '../../src/logging/logger.ts';
import { postJson, type TestApp } from './app.ts';

export const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64');
export const bytes = (length: number, fill = 7) => new Uint8Array(length).fill(fill);
/** SHA-256 in hex, as the CLI sends it in `x-an-content-sha256`. */
export const sha256Hex = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
/** The header that signs a request in with `token`. */
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
/** The project scope key numbered `index` (its hex, padded to 64 characters). */
export const scopeKeyOf = (index: number) => index.toString(16).padStart(64, '0');

/** The error code of an API error answer. */
export async function errorCode(res: Response): Promise<string> {
  return ErrorResponseSchema.parse(await res.json()).error.code;
}

/** A user as the repositories store it. */
export const newUser = (username: string): NewUser => ({
  username,
  kdfSalt: bytes(KDF_SALT_BYTES),
  kdfParams: DEFAULT_KDF_PARAMS,
  authHash: 'auth-hash',
  wrappedDataKey: bytes(WRAPPED_DATA_KEY_BYTES),
});

/** A session from a laptop that ends `expiresInMs` from now (a minute by default). */
export const newSession = (
  userId: string,
  tokenHash: string,
  expiresInMs = 60_000,
): NewSession => ({
  userId,
  tokenHash,
  deviceName: 'laptop',
  expiresAt: new Date(Date.now() + expiresInMs),
});

/** Stores a user straight in the database (production only registers with a session). */
export async function createUser(db: Database, username = 'ahmed'): Promise<UserRecord> {
  const [row] = await db.insert(users).values(newUser(username)).returning({ id: users.id });
  const user = row && (await createUserRepository(db).findById(row.id));
  if (!user) throw new Error('User insert returned no row');
  return user;
}

export interface RegisterOptions {
  /** Base64; each test picks the key its user logs in with. */
  readonly authKey?: string;
  readonly kdfParams?: KdfParams;
  /** Extra request headers, e.g. the test client IP. */
  readonly headers?: Record<string, string>;
}

/** The body of `POST /auth/register` as the CLI sends it. */
export const registration = (username = 'ahmed', options: RegisterOptions = {}) => ({
  username,
  kdfSalt: b64(bytes(KDF_SALT_BYTES, 1)),
  kdfParams: options.kdfParams ?? DEFAULT_KDF_PARAMS,
  authKey: options.authKey ?? b64(bytes(32, 1)),
  wrappedDataKey: b64(bytes(WRAPPED_DATA_KEY_BYTES, 3)),
  deviceName: 'laptop',
});

/** Registers through the API and returns its answer. */
export function registerUser(
  app: TestApp['app'],
  username = 'ahmed',
  options: RegisterOptions = {},
): Promise<Response> {
  return Promise.resolve(
    app.request('/auth/register', postJson(registration(username, options), options.headers)),
  );
}

/** Registers through the API and returns the new session token. */
export async function registerForToken(
  app: TestApp['app'],
  username = 'ahmed',
  options: RegisterOptions = {},
): Promise<string> {
  const res = await registerUser(app, username, options);
  return SessionResponseSchema.parse(await res.json()).sessionToken;
}

export interface LoginOptions {
  readonly deviceName?: string;
  /** Extra request headers, e.g. the test client IP. */
  readonly headers?: Record<string, string>;
}

/** `POST /auth/login` as the CLI sends it; `authKey` is base64. */
export function loginRequest(
  app: TestApp['app'],
  username: string,
  authKey: string,
  options: LoginOptions = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(
      '/auth/login',
      postJson({ username, authKey, deviceName: options.deviceName ?? 'pc' }, options.headers),
    ),
  );
}

export interface PutSetupOptions {
  /** The revision the upload says is saved now (0 for a new setup). */
  readonly expected: number;
  readonly body: Uint8Array;
  /** The setup's path; the global setup by default. */
  readonly path?: string;
  readonly nameEnc?: Uint8Array;
  /** `x-an-content-sha256`; the body's real hash by default. */
  readonly hash?: string;
  readonly contentType?: string;
  /** A header to leave out, to test the answer when it is missing. */
  readonly omitHeader?: string;
}

/** `PUT /bundles/...` as the CLI sends it, signed in with `token`. */
export function putSetup(
  app: TestApp['app'],
  token: string,
  options: PutSetupOptions,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...bearer(token),
    'content-type': options.contentType ?? 'application/octet-stream',
    'x-an-expected-revision': String(options.expected),
    'x-an-content-sha256': options.hash ?? sha256Hex(options.body),
    'x-an-format-version': '1',
    ...(options.nameEnc && { 'x-an-name-enc': b64(options.nameEnc) }),
  };
  return Promise.resolve(
    app.request(options.path ?? '/bundles/claude-code/global', {
      method: 'PUT',
      body: options.body,
      headers: Object.fromEntries(
        Object.entries(headers).filter(([name]) => name !== options.omitHeader),
      ),
    }),
  );
}

/** `DELETE /account` with this body (normally `{ authKey }`), signed in when `token` is given. */
export function deleteAccountRequest(
  app: TestApp['app'],
  token: string | null,
  body: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request('/account', {
      method: 'DELETE',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        ...(token !== null && bearer(token)),
      },
    }),
  );
}

/**
 * Saves `count` project setups for the user in two statements instead of one request each
 * (QA-12), so the limit tests stay fast. Each holds 40 bytes; scope keys are the index in hex.
 */
export async function seedSetups(db: Database, username: string, count: number): Promise<void> {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
  if (!user) throw new Error(`No user ${username}`);
  const ciphertext = bytes(40, 1);
  const files = await db
    .insert(bundleBlobs)
    .values(Array.from({ length: count }, () => ({ userId: user.id, ciphertext })))
    .returning({ id: bundleBlobs.id });
  await db.insert(bundles).values(
    files.map((file, index) => ({
      userId: user.id,
      agent: 'claude-code',
      scopeKey: scopeKeyOf(index),
      nameEnc: bytes(40, 1),
      contentHash: fromHex(sha256Hex(ciphertext)),
      formatVersion: 1,
      revision: 1,
      sizeBytes: ciphertext.length,
      blobId: file.id,
    })),
  );
}

/** The key of a user's global setup. */
export const globalKey = (userId: string): BundleKey => ({
  userId,
  agent: 'claude-code',
  scopeKey: 'global',
});

/** A setup save as the bundle service hands it to `putMeta`. */
export function metaWrite(
  key: Partial<BundleKey> & { userId: string },
  expectedRevision: number,
  blobId: string,
  hashFill: number,
): BundleMetaWrite {
  return {
    key: { ...globalKey(key.userId), ...key },
    expectedRevision,
    nameEnc: null,
    contentHash: bytes(32, hashFill),
    formatVersion: 1,
    sizeBytes: 40,
    blobId,
  };
}

/** A Logger that keeps the errors it is given. */
export function memoryLogger() {
  const errors: { event: string; fields: Record<string, unknown> }[] = [];
  const logger: Logger = {
    info: () => undefined,
    error: (event, fields = {}) => errors.push({ event, fields }),
  };
  return { logger, errors };
}
