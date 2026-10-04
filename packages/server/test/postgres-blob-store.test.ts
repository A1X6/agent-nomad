import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  BlobInUseError,
  createBundleRepository,
  createPostgresBlobStore,
  type BlobStore,
  type BundleRepository,
} from '../src/index.ts';
import { type TestDatabase, useTestDatabase } from './support/database.ts';
import { bytes, createUser, metaWrite } from './support/fixtures.ts';

let database: TestDatabase;
let bundleRepo: BundleRepository;
let blobs: BlobStore;

useTestDatabase((made) => {
  database = made;
  bundleRepo = createBundleRepository(database.db);
  blobs = createPostgresBlobStore(database.db);
});

describe('BlobStore (Postgres)', () => {
  it('stores bytes under a new id each time and reads them back', async () => {
    const user = await createUser(database.db, 'ahmed');
    const first = await blobs.put(user.id, bytes(40, 1));
    const second = await blobs.put(user.id, bytes(40, 1));
    expect(first.blobId).not.toBe(second.blobId);
    const read = await blobs.get(first);
    expect(read).toBeInstanceOf(Uint8Array);
    expect(read).toEqual(bytes(40, 1));
  });

  it("never returns another user's file", async () => {
    const owner = await createUser(database.db, 'owner');
    const other = await createUser(database.db, 'other');
    const blob = await blobs.put(owner.id, bytes(40));
    expect(await blobs.get({ userId: other.id, blobId: blob.blobId })).toBeNull();
    await blobs.delete({ userId: other.id, blobId: blob.blobId });
    expect(await blobs.get(blob)).toEqual(bytes(40));
  });

  it('does nothing when deleting a file that is already gone', async () => {
    const user = await createUser(database.db, 'ahmed');
    const blob = await blobs.put(user.id, bytes(40));
    await blobs.delete(blob);
    await expect(blobs.delete(blob)).resolves.toBeUndefined();
  });

  it('throws BlobInUseError instead of deleting the current file of a setup', async () => {
    const user = await createUser(database.db, 'ahmed');
    const blob = await blobs.put(user.id, bytes(40));
    await bundleRepo.putMeta(metaWrite({ userId: user.id }, 0, blob.blobId, 1));
    await expect(blobs.delete(blob)).rejects.toBeInstanceOf(BlobInUseError);
    expect(await blobs.get(blob)).toEqual(bytes(40));
  });
});

describe('BlobStore.deleteOrphans (T47)', () => {
  it('deletes old files no setup points to, and nothing else', async () => {
    const user = await createUser(database.db, 'ahmed');
    const current = await blobs.put(user.id, bytes(40, 1));
    await bundleRepo.putMeta(metaWrite({ userId: user.id }, 0, current.blobId, 1));
    const orphan = await blobs.put(user.id, bytes(40, 2));
    const fresh = await blobs.put(user.id, bytes(40, 3));
    await database.db.execute(
      sql`update bundle_blobs set created_at = now() - interval '2 hours' where id in (${current.blobId}, ${orphan.blobId})`,
    );
    expect(await blobs.deleteOrphans?.(60 * 60)).toBe(1);
    expect(await blobs.get(orphan)).toBeNull();
    expect(await blobs.get(current)).not.toBeNull();
    expect(await blobs.get(fresh)).not.toBeNull();
  });
});
