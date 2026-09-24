import { describe, expect, it } from 'vitest';

import {
  HOME_PLACEHOLDER,
  type Aead,
  type CryptoService,
  type Digest,
  type MergeStrategy,
  type PlannedWrite,
} from '../src/index.ts';

/** A consumer that only needs encryption depends on `Aead`, not the whole CryptoService. */
function encryptTwice(aead: Aead, data: Uint8Array, key: Uint8Array): Uint8Array {
  const aad = new Uint8Array([1]);
  return aead.open(aead.seal(data, key, aad), key, aad);
}

/** Fake that "encrypts" by prefixing the associated data; enough to prove the shape. */
const fakeCrypto: CryptoService = {
  deriveKeys: () =>
    Promise.resolve({ authKey: new Uint8Array(32), passwordKey: new Uint8Array(32) }),
  seal: (plaintext, _key, aad) => new Uint8Array([...aad, ...plaintext]),
  open: (sealed, _key, aad) => sealed.slice(aad.length),
  keyedHash: (message) => message.slice(0, 1),
  sha256: () => new Uint8Array(32),
  randomBytes: (length) => new Uint8Array(length),
};

const overwrite: MergeStrategy = {
  name: 'overwrite',
  appliesTo: () => true,
  resolve: ({ path, existing, incoming }): readonly PlannedWrite[] => [
    { path: `${path}.bak`, content: existing },
    { path, content: incoming },
  ],
};

describe('core interfaces', () => {
  it('a full CryptoService can be passed where only Aead or Digest is needed', () => {
    const digest: Digest = fakeCrypto;
    expect(digest.sha256(new Uint8Array()).length).toBe(32);
    expect(encryptTwice(fakeCrypto, new Uint8Array([7]), new Uint8Array(32))).toEqual(
      new Uint8Array([7]),
    );
  });

  it('merge strategies return planned writes instead of touching the disk', () => {
    const writes = overwrite.resolve({
      path: 'settings.json',
      existing: new Uint8Array([1]),
      incoming: new Uint8Array([2]),
    });
    expect(writes.map((write) => write.path)).toEqual(['settings.json.bak', 'settings.json']);
  });

  it('uses {{HOME}} as the portable home placeholder', () => {
    expect(HOME_PLACEHOLDER).toBe('{{HOME}}');
  });
});
