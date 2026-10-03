import { createHash } from 'node:crypto';

import {
  DEFAULT_KDF_PARAMS,
  KDF_SALT_BYTES,
  SessionResponseSchema,
  WRAPPED_DATA_KEY_BYTES,
  type KdfParams,
} from '@agentnomad/contracts';
import { eq } from 'drizzle-orm';

import type { Database } from '../../src/db/database.ts';
import type { NewUser, UserRecord } from '../../src/db/repositories.ts';
import { bundleBlobs, bundles, users } from '../../src/db/schema.ts';
import { createUserRepository } from '../../src/db/user-repository.ts';
import { postJson, type TestApp } from './app.ts';

export const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64');
export const bytes = (length: number, fill = 7) => new Uint8Array(length).fill(fill);

/** A user as the repositories store it. */
export const newUser = (username: string): NewUser => ({
  username,
  kdfSalt: bytes(KDF_SALT_BYTES),
  kdfParams: DEFAULT_KDF_PARAMS,
  authHash: 'auth-hash',
  wrappedDataKey: bytes(WRAPPED_DATA_KEY_BYTES),
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
      scopeKey: index.toString(16).padStart(64, '0'),
      nameEnc: bytes(40, 1),
      contentHash: new Uint8Array(createHash('sha256').update(ciphertext).digest()),
      formatVersion: 1,
      revision: 1,
      sizeBytes: ciphertext.length,
      blobId: file.id,
    })),
  );
}
