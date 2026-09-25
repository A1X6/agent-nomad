import { describe, expect, it } from 'vitest';

import { createServerKeys } from '../src/auth/server-keys.ts';

const secret = new Uint8Array(32).fill(1);
const authKey = new Uint8Array(32).fill(2);

describe('ServerKeys', () => {
  it('verifies an auth key against its own hash only', async () => {
    const keys = await createServerKeys(secret);
    const stored = await keys.hashAuthKey(authKey);
    expect(await keys.verifyAuthKey(authKey, stored)).toBe(true);
    expect(await keys.verifyAuthKey(new Uint8Array(32).fill(3), stored)).toBe(false);
  });

  it('rejects a changed, empty or unknown-format stored hash', async () => {
    const keys = await createServerKeys(secret);
    const stored = await keys.hashAuthKey(authKey);
    const flipped = stored.slice(0, -1) + (stored.endsWith('0') ? '1' : '0');
    expect(await keys.verifyAuthKey(authKey, flipped)).toBe(false);
    expect(await keys.verifyAuthKey(authKey, '')).toBe(false);
    expect(await keys.verifyAuthKey(authKey, stored.replace('v1', 'v9'))).toBe(false);
  });

  it('makes hashes useless without the server secret', async () => {
    const other = await createServerKeys(new Uint8Array(32).fill(9));
    const stored = await (await createServerKeys(secret)).hashAuthKey(authKey);
    expect(await other.verifyAuthKey(authKey, stored)).toBe(false);
  });

  it('gives a 16-byte fake salt that depends on the name and the secret', async () => {
    const keys = await createServerKeys(secret);
    const salt = await keys.fakeSalt('ghost');
    expect(salt).toHaveLength(16);
    expect(await keys.fakeSalt('ghost')).toEqual(salt);
    expect(await keys.fakeSalt('ghost2')).not.toEqual(salt);
    expect(
      await (await createServerKeys(new Uint8Array(32).fill(9))).fakeSalt('ghost'),
    ).not.toEqual(salt);
  });
});
