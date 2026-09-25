import { KDF_SALT_BYTES } from '@agentnomad/contracts';

import { fromHex, toHex, utf8 } from './encoding.ts';

/**
 * Secrets only the server holds, derived from SERVER_SECRET (never stored in the database).
 * Labels are part of the stored format: changing one breaks every login, so a new scheme is
 * added as v2 next to v1 (same rule as the client key format).
 */
const AUTH_HASH_LABEL = 'agentnomad/server/auth-key-hash/v1';
const FAKE_SALT_LABEL = 'agentnomad/server/prelogin-salt/v1';
/** Prefix of stored auth hashes, so a later scheme can be told apart. */
const AUTH_HASH_PREFIX = 'hmac-sha256-v1$';

export interface ServerKeys {
  /** What `users.auth_hash` stores for an auth key. */
  hashAuthKey(authKey: Uint8Array): Promise<string>;
  /** Constant-time check of an auth key against a stored hash. */
  verifyAuthKey(authKey: Uint8Array, storedHash: string): Promise<boolean>;
  /** Deterministic salt for a username with no account, so prelogin reveals nothing. */
  fakeSalt(username: string): Promise<Uint8Array>;
}

const HMAC = { name: 'HMAC', hash: 'SHA-256' } as const;

// Web Crypto types taken from the API itself, so no runtime-specific import is needed.
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type KeyUsages = Parameters<typeof crypto.subtle.importKey>[4];

function importHmacKey(raw: Uint8Array, usages: KeyUsages): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, HMAC, false, usages);
}

async function hmac(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

/**
 * Keys from the server secret. A separate subkey per purpose, so one use can never be
 * turned into another.
 */
export async function createServerKeys(serverSecret: Uint8Array): Promise<ServerKeys> {
  const master = await importHmacKey(serverSecret, ['sign']);
  const authHashKey = await importHmacKey(await hmac(master, utf8(AUTH_HASH_LABEL)), [
    'sign',
    'verify',
  ]);
  const fakeSaltKey = await importHmacKey(await hmac(master, utf8(FAKE_SALT_LABEL)), ['sign']);

  return {
    async hashAuthKey(authKey) {
      return AUTH_HASH_PREFIX + toHex(await hmac(authHashKey, authKey));
    },

    async verifyAuthKey(authKey, storedHash) {
      const known = storedHash.startsWith(AUTH_HASH_PREFIX);
      const expected = fromHex(storedHash.slice(AUTH_HASH_PREFIX.length));
      // subtle.verify compares in constant time. Run it even for an unknown format, so the
      // time taken does not depend on what is stored.
      const matches = await crypto.subtle.verify('HMAC', authHashKey, expected, authKey);
      return known && matches;
    },

    async fakeSalt(username) {
      return (await hmac(fakeSaltKey, utf8(username))).slice(0, KDF_SALT_BYTES);
    },
  };
}
