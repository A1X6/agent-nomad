import {
  BUNDLE_FORMAT_VERSION,
  GLOBAL_SCOPE_KEY,
  WRAPPED_DATA_KEY_BYTES,
} from '@agentnomad/contracts';
import { describe, expect, it } from 'vitest';

import {
  AEAD_KEY_BYTES,
  DATA_KEY_BYTES,
  DecryptionError,
  openBundle,
  sealBundle,
  unwrapDataKey,
  wrapDataKey,
  type BundleContext,
} from '../src/index.ts';
import { crypto, dataKey as key, useDataKey } from './fixtures.ts';

useDataKey();

describe('data key wrapping', () => {
  it('wraps to exactly the size the API expects and unwraps again', () => {
    const dataKey = crypto.randomBytes(DATA_KEY_BYTES);
    const passwordKey = crypto.randomBytes(AEAD_KEY_BYTES);
    const wrapped = wrapDataKey(crypto, dataKey, passwordKey);
    expect(wrapped).toHaveLength(WRAPPED_DATA_KEY_BYTES);
    expect(unwrapDataKey(crypto, wrapped, passwordKey)).toEqual(dataKey);
  });

  it('cannot be unwrapped with the wrong password key', () => {
    const wrapped = wrapDataKey(
      crypto,
      crypto.randomBytes(DATA_KEY_BYTES),
      crypto.randomBytes(AEAD_KEY_BYTES),
    );
    expect(() => unwrapDataKey(crypto, wrapped, crypto.randomBytes(AEAD_KEY_BYTES))).toThrow(
      DecryptionError,
    );
  });

  it('cannot be opened as if it were a bundle', () => {
    const wrapped = wrapDataKey(crypto, crypto.randomBytes(DATA_KEY_BYTES), key);
    const context: BundleContext = {
      formatVersion: BUNDLE_FORMAT_VERSION,
      agent: 'claude-code',
      scopeKey: GLOBAL_SCOPE_KEY,
    };
    expect(() => openBundle(crypto, wrapped, key, context)).toThrow(DecryptionError);
  });
});

describe('bundle encryption is bound to its agent, scope and format', () => {
  const context: BundleContext = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    agent: 'claude-code',
    scopeKey: 'a'.repeat(64),
  };
  const plaintext = Uint8Array.of(10, 20, 30);

  it('round-trips with the same context', () => {
    const sealed = sealBundle(crypto, plaintext, key, context);
    expect(openBundle(crypto, sealed, key, context)).toEqual(plaintext);
  });

  it.each<[string, Partial<BundleContext>]>([
    ['moved to another scope', { scopeKey: GLOBAL_SCOPE_KEY }],
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
