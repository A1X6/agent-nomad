import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBundleService } from '../src/bundles/bundle-service.ts';
import { createBundleRepository } from '../src/db/bundle-repository.ts';
import { createUserRepository } from '../src/db/user-repository.ts';
import type { BlobStore } from '../src/storage/blob-store.ts';
import { createPostgresBlobStore } from '../src/storage/postgres-blob-store.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);
const sha256 = (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest());

let database: TestDatabase;

beforeEach(async () => {
  database = await createTestDatabase();
});

afterEach(async () => {
  await database.close();
});

describe('BundleService cleanup', () => {
  it('still succeeds when deleting the replaced file fails, and reports it', async () => {
    const real = createPostgresBlobStore(database.db);
    const flaky: BlobStore = {
      put: (userId, data) => real.put(userId, data),
      get: (ref) => real.get(ref),
      delete: () => Promise.reject(new Error('storage down')),
    };
    const logged: string[] = [];
    const service = createBundleService({
      bundles: createBundleRepository(database.db),
      blobs: flaky,
      logError: (message) => logged.push(message),
    });
    const user = await createUserRepository(database.db).create({
      username: 'ahmed',
      kdfSalt: bytes(16, 1),
      kdfParams: {
        algorithm: 'argon2id',
        version: 19,
        memoryKiB: 65536,
        passes: 3,
        parallelism: 1,
      },
      authHash: 'x',
      wrappedDataKey: bytes(72, 1),
    });
    const upload = (expectedRevision: number, fill: number) =>
      service.upload({
        key: { userId: user.id, agent: 'claude-code', scopeKey: 'global' },
        expectedRevision,
        ciphertext: bytes(64, fill),
        contentHash: sha256(bytes(64, fill)),
        formatVersion: 1,
        nameEnc: null,
      });

    await upload(0, 1);
    const second = await upload(1, 2);
    expect(second).toMatchObject({ outcome: 'stored', meta: { revision: 2 } });
    expect(logged).toHaveLength(1);
  });
});
