import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  StorageLimitError,
  createBundleService,
  overLimit,
} from '../src/bundles/bundle-service.ts';
import { createBundleRepository } from '../src/db/bundle-repository.ts';
import type { BundleRepository } from '../src/db/repositories.ts';
import type { BlobStore } from '../src/storage/blob-store.ts';
import { createPostgresBlobStore } from '../src/storage/postgres-blob-store.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';
import { bytes, createUser } from './support/fixtures.ts';
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
    const user = await createUser(database.db);
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

describe('BundleService upload', () => {
  const key = (userId: string) => ({ userId, agent: 'claude-code', scopeKey: 'global' });
  const input = (userId: string, fill = 1) => ({
    key: key(userId),
    expectedRevision: 0,
    ciphertext: bytes(64, fill),
    contentHash: sha256(bytes(64, fill)),
    formatVersion: 1,
    nameEnc: null,
  });
  it('reads the usage and the current setup at the same time (DB-01)', async () => {
    const real = createBundleRepository(database.db);
    const events: string[] = [];
    const watched: BundleRepository = {
      ...real,
      async usage(userId) {
        events.push('usage-start');
        const used = await real.usage(userId);
        events.push('usage-end');
        return used;
      },
      async get(bundleKey) {
        events.push('get-start');
        const meta = await real.get(bundleKey);
        events.push('get-end');
        return meta;
      },
    };
    const service = createBundleService({
      bundles: watched,
      blobs: createPostgresBlobStore(database.db),
      logError: () => undefined,
    });
    const user = await createUser(database.db);

    await service.upload(input(user.id));

    expect(events.slice(0, 2).sort()).toEqual(['get-start', 'usage-start']);
  });

  // The exact words an installed 1.0.3 CLI shows; they must never change (ARCH-02).
  const SETUPS_MESSAGE =
    'An account keeps at most 100 saved setups. Delete some with `agentnomad delete` first.';
  const BYTES_MESSAGE =
    'An account keeps at most 50 MB of saved setups. Delete some with `agentnomad delete` or make this one smaller.';

  it.each([
    ['setups', SETUPS_MESSAGE],
    ['bytes', BYTES_MESSAGE],
  ] as const)(
    'turns an over-limit save (%s) into the same sentence as before',
    async (limit, message) => {
      const real = createBundleRepository(database.db);
      // Passes the early check, then loses the race inside the save.
      const racing: BundleRepository = {
        ...real,
        putMeta: () => Promise.resolve({ outcome: 'over-limit', limit }),
      };
      const service = createBundleService({
        bundles: racing,
        blobs: createPostgresBlobStore(database.db),
        logError: () => undefined,
      });
      const user = await createUser(database.db);
      const refused = service.upload(input(user.id));
      await expect(refused).rejects.toBeInstanceOf(StorageLimitError);
      await expect(refused).rejects.toThrow(message);
    },
  );

  it('the early check uses the same sentences', () => {
    expect(overLimit('setups')).toBe(SETUPS_MESSAGE);
    expect(overLimit('bytes')).toBe(BYTES_MESSAGE);
  });
});
