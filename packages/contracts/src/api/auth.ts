import * as z from 'zod';

import { base64OfLength, ShortTextSchema, TimestampSchema } from '../primitives.ts';
import { AUTH_KEY_BYTES, KDF_SALT_BYTES, WRAPPED_DATA_KEY_BYTES } from './common.ts';

/** Account name: 3–32 lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit. */
export const UsernameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{2,31}$/,
    'Username must be 3–32 lowercase letters, digits, dots, dashes or underscores',
  );

/**
 * Argon2id settings stored per user so they can be raised later. Parallelism is fixed at 1
 * so any Argon2id implementation reproduces the same key (T04). The upper bounds stop a
 * malicious server from making the CLI allocate huge amounts of memory at prelogin.
 */
export const KdfParamsSchema = z.strictObject({
  algorithm: z.literal('argon2id'),
  /** Argon2 version 1.3 (0x13). */
  version: z.literal(19),
  /** Memory cost in KiB: 19 MiB to 1 GiB. With `passes` >= 2 this meets the OWASP minimum. */
  memoryKiB: z.int().min(19_456).max(1_048_576),
  passes: z.int().min(2).max(10),
  parallelism: z.literal(1),
});

/**
 * Argon2id settings for new accounts: 64 MiB, 3 passes (the T04 benchmark). The server also
 * returns these for unknown usernames at prelogin, so a fake answer looks like a real one.
 */
export const DEFAULT_KDF_PARAMS = {
  algorithm: 'argon2id',
  version: 19,
  memoryKiB: 65_536,
  passes: 3,
  parallelism: 1,
} as const satisfies z.input<typeof KdfParamsSchema>;

const KdfSaltSchema = base64OfLength(KDF_SALT_BYTES);
const AuthKeySchema = base64OfLength(AUTH_KEY_BYTES);
const WrappedDataKeySchema = base64OfLength(WRAPPED_DATA_KEY_BYTES);

/** Opaque session token: 32 random bytes, base64url without padding. */
export const SessionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid session token');

/** POST /auth/prelogin. Unknown usernames get a deterministic fake salt (never an error). */
export const PreloginRequestSchema = z.strictObject({ username: UsernameSchema });
export const PreloginResponseSchema = z.strictObject({
  kdfSalt: KdfSaltSchema,
  kdfParams: KdfParamsSchema,
});

/** POST /auth/register. The server hashes `authKey` again before storing it. */
export const RegisterRequestSchema = z.strictObject({
  username: UsernameSchema,
  kdfSalt: KdfSaltSchema,
  kdfParams: KdfParamsSchema,
  authKey: AuthKeySchema,
  wrappedDataKey: WrappedDataKeySchema,
  deviceName: ShortTextSchema,
});

/** Returned by register (the client already holds its data key) and as part of login. */
export const SessionResponseSchema = z.strictObject({
  sessionToken: SessionTokenSchema,
  expiresAt: TimestampSchema,
});

/** POST /auth/login. */
export const LoginRequestSchema = z.strictObject({
  username: UsernameSchema,
  authKey: AuthKeySchema,
  deviceName: ShortTextSchema,
});
export const LoginResponseSchema = SessionResponseSchema.extend({
  wrappedDataKey: WrappedDataKeySchema,
});

/**
 * DELETE /account. Needs the auth key as well as the session, so a stolen session token
 * alone cannot delete the account.
 */
export const DeleteAccountRequestSchema = z.strictObject({ authKey: AuthKeySchema });

export type Username = z.infer<typeof UsernameSchema>;
export type KdfParams = z.infer<typeof KdfParamsSchema>;
export type PreloginRequest = z.infer<typeof PreloginRequestSchema>;
export type PreloginResponse = z.infer<typeof PreloginResponseSchema>;
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>;
