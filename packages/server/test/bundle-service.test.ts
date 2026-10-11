import { BUNDLE_FORMAT_VERSION, fromHex } from '@agentnomad/contracts';
import { describe, expect, it } from 'vitest';

import {
  BundleNotFoundError,
  StorageLimitError,
  createBundleService,
  overLimit,
} from '../src/bundles/bundle-service.ts';
import { createBundleRepository } from '../src/db/bundle-repository.ts';
import type { BundleRepository } from '../src/db/repositories.ts';
import type { BlobStore } from '../src/storage/blob-store.ts';
import { createPostgresBlobStore } from '../src/storage/postgres-blob-store.ts';
import { type TestDatabase, useTestDatabase } from './support/database.ts';
import { bytes, createUser, globalKey, sha256Hex } from './support/fixtures.ts';

let database: TestDatabase;
useTestDatabase((made) => {
  database = made;
});

/** An upload of 64 bytes filled with `fill` to the user's global setup. */
const input = (userId: string, fill = 1, expectedRevision = 0) => ({
  key: globalKey(userId),
  expectedRevision,
  ciphertext: bytes(64, fill),
  contentHash: fromHex(sha256Hex(bytes(64, fill))),
  formatVersion: BUNDLE_FORMAT_VERSION,
  nameEnc: null,
});

/** The bundle service on the test database; `parts` replace its repository, store or logger. */
const serviceWith = (parts: Partial<Parameters<typeof createBundleService>[0]>) =>
  createBundleService({
    bundles: createBundleRepository(database.db),
    blobs: createPostgresBlobStore(database.db),
    logError: () => undefined,
    ...parts,
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
    const service = serviceWith({ blobs: flaky, logError: (message) => logged.push(message) });
    const user = await createUser(database.db);
    const upload = (expectedRevision: number, fill: number) =>
      service.upload(input(user.id, fill, expectedRevision));

    await upload(0, 1);
    const second = await upload(1, 2);
    expect(second).toMatchObject({ outcome: 'stored', meta: { revision: 2 } });
    expect(logged).toHaveLength(1);
  });
});

describe('BundleService download', () => {
  /**
   * The real store, except that the first `get` waits for `release()`: a download is held
   * between reading its setup and reading the file while another request runs (BUG-03).
   */
  function heldStore() {
    const real = createPostgresBlobStore(database.db);
    let reached: () => void = () => undefined;
    let release: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const store: BlobStore = {
      ...real,
      async get(ref) {
        if (!held) {
          held = true;
          reached();
          await gate;
        }
        return real.get(ref);
      },
    };
    return { store, arrived, release };
  }

  it('returns the new copy when a save replaces the file during the download', async () => {
    const { store, arrived, release } = heldStore();
    const service = serviceWith({ blobs: store });
    const user = await createUser(database.db);
    await service.upload(input(user.id, 1));

    const download = service.download(globalKey(user.id));
    await arrived;
    // The save commits revision 2 and deletes the file the download is about to read.
    await service.upload(input(user.id, 2, 1));
    release();

    const { meta, ciphertext } = await download;
    expect(meta.revision).toBe(2);
    expect(ciphertext).toEqual(bytes(64, 2));
  });

  it('answers not found when a delete removes the setup during the download', async () => {
    const { store, arrived, release } = heldStore();
    const service = serviceWith({ blobs: store });
    const user = await createUser(database.db);
    await service.upload(input(user.id));

    const download = service.download(globalKey(user.id));
    await arrived;
    await service.delete(globalKey(user.id));
    release();

    await expect(download).rejects.toBeInstanceOf(BundleNotFoundError);
  });

  it('still fails loudly when the current file is missing for good', async () => {
    const real = createPostgresBlobStore(database.db);
    const service = serviceWith({ blobs: { ...real, get: () => Promise.resolve(null) } });
    const user = await createUser(database.db);
    await service.upload(input(user.id));

    await expect(service.download(globalKey(user.id))).rejects.toThrow(/is missing/);
  });
});

describe('BundleService upload', () => {
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
    const service = serviceWith({ bundles: watched });
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
      const service = serviceWith({ bundles: racing });
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
