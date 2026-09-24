import { WRAPPED_DATA_KEY_BYTES, type KdfParams } from '@agentnomad/contracts';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  DATA_KEY_BYTES,
  DecryptionError,
  createSodiumCryptoService,
  openBundle,
  sealBundle,
  unwrapDataKey,
  wrapDataKey,
  type BundleContext,
  type CryptoService,
} from '../src/index.ts';

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

/** Lowest allowed cost, so the test suite stays fast. */
const params: KdfParams = {
  algorithm: 'argon2id',
  version: 19,
  memoryKiB: 19_456,
  passes: 2,
  parallelism: 1,
};
const salt = new Uint8Array(16).map((_, index) => index);

let crypto: CryptoService;
let key: Uint8Array;

beforeAll(async () => {
  crypto = await createSodiumCryptoService();
  key = crypto.randomBytes(DATA_KEY_BYTES);
});

/** Returns a copy of `data` with one bit flipped at `index`. */
function flipBit(data: Uint8Array, index: number): Uint8Array {
  const copy = data.slice();
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
}

describe('deriveKeys', () => {
  it('matches the fixed reference vector (changing it would lock every user out)', async () => {
    // Argon2id step cross-checked against Node's crypto.argon2Sync when this vector was made.
    const keys = await crypto.deriveKeys('correct horse battery staple', salt, params);
    expect(hex(keys.authKey)).toBe(
      'd95bd8f1fd834f2ed0aba5a0f1c6971f9e38141236e16f1983362124981aac65',
    );
    expect(hex(keys.passwordKey)).toBe(
      'c88cb24ea1e5d714e18a3a2ce4a3a889bdb2060139652b1e9db005631104d47a',
    );
  });

  it('gives different keys for a different password or salt', async () => {
    const base = await crypto.deriveKeys('password one', salt, params);
    const otherPassword = await crypto.deriveKeys('password two', salt, params);
    const otherSalt = await crypto.deriveKeys('password one', flipBit(salt, 0), params);
    expect(hex(otherPassword.authKey)).not.toBe(hex(base.authKey));
    expect(hex(otherSalt.authKey)).not.toBe(hex(base.authKey));
  });

  it('splits the master key into two different 32-byte keys', async () => {
    const keys = await crypto.deriveKeys('password', salt, params);
    expect(keys.authKey).toHaveLength(32);
    expect(keys.passwordKey).toHaveLength(32);
    expect(hex(keys.authKey)).not.toBe(hex(keys.passwordKey));
  });

  it('treats the same password typed on different OSes as equal (Unicode NFC)', async () => {
    const composed = await crypto.deriveKeys('café', salt, params); // é as one character
    const decomposed = await crypto.deriveKeys('café', salt, params); // e + accent
    expect(hex(decomposed.authKey)).toBe(hex(composed.authKey));
  });

  it('refuses settings outside the allowed range before doing any work', async () => {
    const huge: KdfParams = { ...params, memoryKiB: 4_194_304 }; // 4 GiB, above the 1 GiB limit
    await expect(crypto.deriveKeys('password', salt, huge)).rejects.toThrow();
  });

  it('refuses a salt that is not 16 bytes', async () => {
    await expect(crypto.deriveKeys('password', new Uint8Array(8), params)).rejects.toThrow(
      RangeError,
    );
  });
});

describe('seal and open', () => {
  const aad = bytes(9, 9);

  it('round-trips and adds a 24-byte nonce and a 16-byte tag', () => {
    const plaintext = bytes(1, 2, 3);
    const sealed = crypto.seal(plaintext, key, aad);
    expect(sealed).toHaveLength(24 + 3 + 16);
    expect(crypto.open(sealed, key, aad)).toEqual(plaintext);
  });

  it('uses a fresh nonce every time, so equal plaintexts look different', () => {
    const plaintext = bytes(1, 2, 3);
    expect(hex(crypto.seal(plaintext, key, aad))).not.toBe(hex(crypto.seal(plaintext, key, aad)));
  });

  describe('tamper checks: every change is rejected', () => {
    const sealed = () => crypto.seal(bytes(1, 2, 3, 4, 5), key, aad);

    it.each([
      ['a bit in the nonce', 0],
      ['a bit in the ciphertext', 25],
      ['a bit in the tag', 24 + 5 + 15],
    ])('%s', (_, index) => {
      expect(() => crypto.open(flipBit(sealed(), index), key, aad)).toThrow(DecryptionError);
    });

    it('a wrong key', () => {
      expect(() => crypto.open(sealed(), crypto.randomBytes(32), aad)).toThrow(DecryptionError);
    });

    it('different associated data', () => {
      expect(() => crypto.open(sealed(), key, bytes(9, 8))).toThrow(DecryptionError);
    });

    it('input too short to hold a nonce and tag', () => {
      expect(() => crypto.open(new Uint8Array(39), key, aad)).toThrow(DecryptionError);
    });

    it('a truncated message', () => {
      expect(() => crypto.open(sealed().slice(0, -1), key, aad)).toThrow(DecryptionError);
    });
  });

  it('refuses keys that are not 32 bytes', () => {
    expect(() => crypto.seal(bytes(1), new Uint8Array(31), aad)).toThrow(RangeError);
    expect(() => crypto.open(new Uint8Array(60), new Uint8Array(33), aad)).toThrow(RangeError);
  });
});

describe('data key wrapping', () => {
  it('wraps to exactly the size the API expects and unwraps again', () => {
    const dataKey = crypto.randomBytes(DATA_KEY_BYTES);
    const passwordKey = crypto.randomBytes(32);
    const wrapped = wrapDataKey(crypto, dataKey, passwordKey);
    expect(wrapped).toHaveLength(WRAPPED_DATA_KEY_BYTES);
    expect(unwrapDataKey(crypto, wrapped, passwordKey)).toEqual(dataKey);
  });

  it('cannot be unwrapped with the wrong password key', () => {
    const wrapped = wrapDataKey(crypto, crypto.randomBytes(32), crypto.randomBytes(32));
    expect(() => unwrapDataKey(crypto, wrapped, crypto.randomBytes(32))).toThrow(DecryptionError);
  });

  it('cannot be opened as if it were a bundle', () => {
    const wrapped = wrapDataKey(crypto, crypto.randomBytes(32), key);
    const context: BundleContext = { formatVersion: 1, agent: 'claude-code', scopeKey: 'global' };
    expect(() => openBundle(crypto, wrapped, key, context)).toThrow(DecryptionError);
  });
});

describe('bundle encryption is bound to its agent, scope and format', () => {
  const context: BundleContext = {
    formatVersion: 1,
    agent: 'claude-code',
    scopeKey: 'a'.repeat(64),
  };
  const plaintext = bytes(10, 20, 30);

  it('round-trips with the same context', () => {
    const sealed = sealBundle(crypto, plaintext, key, context);
    expect(openBundle(crypto, sealed, key, context)).toEqual(plaintext);
  });

  it.each<[string, Partial<BundleContext>]>([
    ['moved to another scope', { scopeKey: 'global' }],
    ['moved to another project', { scopeKey: 'b'.repeat(64) }],
    ['moved to another agent', { agent: 'codex' }],
    ['claimed as another format version', { formatVersion: 2 }],
  ])('fails to decrypt when %s', (_, change) => {
    const sealed = sealBundle(crypto, plaintext, key, context);
    expect(() => openBundle(crypto, sealed, key, { ...context, ...change })).toThrow(
      DecryptionError,
    );
  });
});

describe('hashes and randomness', () => {
  it('sha256 matches the standard test vector for "abc"', () => {
    expect(hex(crypto.sha256(bytes(0x61, 0x62, 0x63)))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('keyedHash is deterministic, 32 bytes, and depends on the key', () => {
    const message = bytes(1, 2, 3);
    const first = crypto.keyedHash(message, key);
    expect(first).toHaveLength(32);
    expect(hex(crypto.keyedHash(message, key))).toBe(hex(first));
    expect(hex(crypto.keyedHash(message, crypto.randomBytes(32)))).not.toBe(hex(first));
  });

  it('randomBytes returns the requested length and never repeats', () => {
    expect(crypto.randomBytes(16)).toHaveLength(16);
    expect(hex(crypto.randomBytes(32))).not.toBe(hex(crypto.randomBytes(32)));
  });
});
