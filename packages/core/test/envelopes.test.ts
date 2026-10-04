import { WRAPPED_DATA_KEY_BYTES } from '@agentnomad/contracts';
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

let crypto: CryptoService;
let key: Uint8Array;

beforeAll(async () => {
  crypto = await createSodiumCryptoService();
  key = crypto.randomBytes(DATA_KEY_BYTES);
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
  const plaintext = Uint8Array.of(10, 20, 30);

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
