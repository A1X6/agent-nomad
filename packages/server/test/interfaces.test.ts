import { describe, expect, it } from 'vitest';

import type { BlobRef, BlobStore, PutMetaResult } from '../src/index.ts';

/** In-memory BlobStore, the kind of fake later route tests will use. */
function memoryBlobStore(): BlobStore {
  const blobs = new Map<string, Uint8Array>();
  const id = (ref: BlobRef) => `${ref.userId}/${ref.agent}/${ref.scopeKey}/${String(ref.revision)}`;
  return {
    put: (ref, bytes) => {
      blobs.set(id(ref), bytes);
      return Promise.resolve();
    },
    get: (ref) => Promise.resolve(blobs.get(id(ref)) ?? null),
    delete: (ref) => {
      blobs.delete(id(ref));
      return Promise.resolve();
    },
  };
}

/** What a PUT route does with each repository outcome. */
function statusFor(result: PutMetaResult): number {
  switch (result.outcome) {
    case 'saved':
    case 'unchanged':
      return 200;
    case 'conflict':
      return 409;
  }
}

describe('server interfaces', () => {
  it('a BlobStore keeps each revision separately', async () => {
    const store = memoryBlobStore();
    const ref: BlobRef = { userId: 'u1', agent: 'claude-code', scopeKey: 'global', revision: 1 };
    await store.put(ref, new Uint8Array([1, 2, 3]));
    expect(await store.get(ref)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await store.get({ ...ref, revision: 2 })).toBeNull();
    await store.delete(ref);
    expect(await store.get(ref)).toBeNull();
  });

  it('every repository put outcome maps to an HTTP status', () => {
    expect(statusFor({ outcome: 'conflict', currentRevision: 4 })).toBe(409);
  });
});
