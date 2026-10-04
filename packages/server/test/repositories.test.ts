import { DEFAULT_KDF_PARAMS, MAX_BUNDLE_BYTES, USER_STORAGE_LIMITS } from '@agentnomad/contracts';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  InvalidCursorError,
  UsernameTakenError,
  createBundleRepository,
  createPostgresBlobStore,
  createSessionRepository,
  createUserRepository,
  sessions,
  storageLimitPassed,
  type BlobStore,
  type BundleKey,
  type BundleRepository,
  type SessionRepository,
  type UserRepository,
} from '../src/index.ts';
import { encodeBundleCursor } from '../src/db/bundle-cursor.ts';
import { type TestDatabase, useTestDatabase } from './support/database.ts';
import {
  bytes,
  createUser,
  globalKey,
  metaWrite,
  newSession,
  newUser,
  scopeKeyOf,
  seedSetups,
} from './support/fixtures.ts';

const hash = (fill: number) => bytes(32, fill);

let database: TestDatabase;
let userRepo: UserRepository;
let sessionRepo: SessionRepository;
let bundleRepo: BundleRepository;
let blobs: BlobStore;

useTestDatabase((made) => {
  database = made;
  userRepo = createUserRepository(database.db);
  sessionRepo = createSessionRepository(database.db);
  bundleRepo = createBundleRepository(database.db);
  blobs = createPostgresBlobStore(database.db);
});

describe('UserRepository', () => {
  it('finds a user by username and by id', async () => {
    const created = await createUser(database.db, 'ahmed');
    expect(created.username).toBe('ahmed');
    expect(created.kdfSalt).toEqual(bytes(16));
    expect(created.kdfParams).toEqual(DEFAULT_KDF_PARAMS);
    expect(await userRepo.findByUsername('ahmed')).toEqual(created);
    expect(await userRepo.findById(created.id)).toEqual(created);
  });

  it('returns null for an unknown user', async () => {
    expect(await userRepo.findByUsername('nobody')).toBeNull();
    expect(await userRepo.findById('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('deletes a user with their sessions, setups and files', async () => {
    const user = await createUser(database.db, 'ahmed');
    const session = await sessionRepo.create(newSession(user.id, 'token'));
    const blob = await blobs.put(user.id, bytes(40));
    await bundleRepo.putMeta(metaWrite({ userId: user.id }, 0, blob.blobId, 1));

    await userRepo.delete(user.id);

    expect(await userRepo.findById(user.id)).toBeNull();
    expect(await sessionRepo.findByTokenHash(session.tokenHash)).toBeNull();
    expect(await bundleRepo.get(globalKey(user.id))).toBeNull();
    expect(await blobs.get(blob)).toBeNull();
  });
});

describe('UserRepository.createWithSession (DB-03)', () => {
  const firstSession = (deviceName = 'laptop') => ({
    tokenHash: 'first-token',
    deviceName,
    expiresAt: new Date(Date.now() + 60_000),
  });

  it('writes the user and the first session together', async () => {
    const { user, session } = await userRepo.createWithSession(newUser('ahmed'), firstSession());
    expect(await userRepo.findByUsername('ahmed')).toEqual(user);
    expect(await sessionRepo.findByTokenHash('first-token')).toEqual(session);
    expect(session.userId).toBe(user.id);
  });

  it('keeps no account when the session cannot be written', async () => {
    await database.client.query(
      `alter table sessions add constraint test_refuse check (device_name <> 'refused')`,
    );
    await expect(
      userRepo.createWithSession(newUser('ahmed'), firstSession('refused')),
    ).rejects.toThrow();
    expect(await userRepo.findByUsername('ahmed')).toBeNull();
    // So trying again works, instead of answering "username taken".
    await userRepo.createWithSession(newUser('ahmed'), firstSession());
    expect(await userRepo.findByUsername('ahmed')).not.toBeNull();
  });

  it('throws UsernameTakenError for a taken username and writes no session', async () => {
    await createUser(database.db, 'ahmed');
    await expect(
      userRepo.createWithSession(newUser('ahmed'), firstSession()),
    ).rejects.toBeInstanceOf(UsernameTakenError);
    expect(await sessionRepo.findByTokenHash('first-token')).toBeNull();
  });
});

describe('SessionRepository', () => {
  const make = (userId: string, tokenHash: string, expiresInMs: number) =>
    sessionRepo.create(newSession(userId, tokenHash, expiresInMs));

  it('finds a live session by its token hash and forgets it after delete', async () => {
    const user = await createUser(database.db, 'ahmed');
    const session = await sessionRepo.create(newSession(user.id, 'token'));
    expect(await sessionRepo.findByTokenHash('token')).toEqual(session);
    await sessionRepo.delete(session.id);
    expect(await sessionRepo.findByTokenHash('token')).toBeNull();
  });

  it("deletes only this user's expired and idle sessions", async () => {
    const user = await createUser(database.db, 'ahmed');
    const other = await createUser(database.db, 'other');
    const day = 24 * 60 * 60 * 1000;
    await make(user.id, 'live', day);
    await make(user.id, 'expired', -1000);
    const idle = await make(user.id, 'idle', 60 * day);
    await make(other.id, 'other-expired', -1000);
    await database.db
      .update(sessions)
      .set({ lastUsedAt: new Date(Date.now() - 31 * day) })
      .where(eq(sessions.id, idle.id));

    await sessionRepo.deleteStale(user.id, 30 * day);

    const left = await database.db.select({ tokenHash: sessions.tokenHash }).from(sessions);
    expect(left.map((row) => row.tokenHash).sort()).toEqual(['live', 'other-expired']);
  });

  it("deletes every user's expired sessions, and nothing else (DB-02)", async () => {
    const one = await createUser(database.db, 'one');
    const two = await createUser(database.db, 'two');
    await make(one.id, 'one-live', 60_000);
    await make(one.id, 'one-expired', -1000);
    await make(two.id, 'two-expired', -1000);
    await make(two.id, 'two-live', 60_000);

    await sessionRepo.deleteExpired();

    const left = await database.db.select({ tokenHash: sessions.tokenHash }).from(sessions);
    expect(left.map((row) => row.tokenHash).sort()).toEqual(['one-live', 'two-live']);
  });

  it('ignores an expired session', async () => {
    const user = await createUser(database.db, 'ahmed');
    await sessionRepo.create(newSession(user.id, 'old', -1000));
    expect(await sessionRepo.findByTokenHash('old')).toBeNull();
  });
});

describe('BundleRepository.putMeta', () => {
  it('saves a first revision and points it at the uploaded file', async () => {
    const user = await createUser(database.db, 'ahmed');
    const blob = await blobs.put(user.id, bytes(40));
    const result = await bundleRepo.putMeta(metaWrite({ userId: user.id }, 0, blob.blobId, 1));
    expect(result).toMatchObject({ outcome: 'saved', replacedBlobId: null });
    expect(result.outcome === 'saved' && result.meta).toMatchObject({
      revision: 1,
      blobId: blob.blobId,
      contentHash: hash(1),
    });
  });

  it('saves the next revision and reports the file it replaced', async () => {
    const user = await createUser(database.db, 'ahmed');
    const first = await blobs.put(user.id, bytes(40, 1));
    await bundleRepo.putMeta(metaWrite({ userId: user.id }, 0, first.blobId, 1));
    const second = await blobs.put(user.id, bytes(40, 2));
    const result = await bundleRepo.putMeta(metaWrite({ userId: user.id }, 1, second.blobId, 2));
    expect(result).toMatchObject({ outcome: 'saved', replacedBlobId: first.blobId });
    expect((await bundleRepo.get(globalKey(user.id)))?.revision).toBe(2);
  });

  it('refuses a save based on an old revision (conflict)', async () => {
    const user = await createUser(database.db, 'ahmed');
    const first = await blobs.put(user.id, bytes(40, 1));
    await bundleRepo.putMeta(metaWrite({ userId: user.id }, 0, first.blobId, 1));
    const second = await blobs.put(user.id, bytes(40, 2));
    await bundleRepo.putMeta(metaWrite({ userId: user.id }, 1, second.blobId, 2));

    const stale = await blobs.put(user.id, bytes(40, 3));
    const result = await bundleRepo.putMeta(metaWrite({ userId: user.id }, 1, stale.blobId, 3));
    expect(result).toEqual({ outcome: 'conflict', currentRevision: 2 });
    expect((await bundleRepo.get(globalKey(user.id)))?.blobId).toBe(second.blobId);
  });

  it('refuses a "must not exist yet" save when the setup exists, and vice versa', async () => {
    const user = await createUser(database.db, 'ahmed');
    const missing = await blobs.put(user.id, bytes(40));
    expect(await bundleRepo.putMeta(metaWrite({ userId: user.id }, 3, missing.blobId, 1))).toEqual({
      outcome: 'conflict',
      currentRevision: 0,
    });

    await bundleRepo.putMeta(metaWrite({ userId: user.id }, 0, missing.blobId, 1));
    const again = await blobs.put(user.id, bytes(40, 2));
    expect(await bundleRepo.putMeta(metaWrite({ userId: user.id }, 0, again.blobId, 2))).toEqual({
      outcome: 'conflict',
      currentRevision: 1,
    });
  });

  it('treats a retry of a save that already went through as unchanged', async () => {
    const user = await createUser(database.db, 'ahmed');
    const upload = await blobs.put(user.id, bytes(40));
    await bundleRepo.putMeta(metaWrite({ userId: user.id }, 0, upload.blobId, 1));

    // The response was lost; the CLI sends the same bytes again (a new file id).
    const retry = await blobs.put(user.id, bytes(40));
    const result = await bundleRepo.putMeta(metaWrite({ userId: user.id }, 0, retry.blobId, 1));
    expect(result).toMatchObject({ outcome: 'unchanged', meta: { revision: 1 } });
    expect((await bundleRepo.get(globalKey(user.id)))?.blobId).toBe(upload.blobId);
  });

  it('treats an identical push of the current revision as unchanged (QA-06)', async () => {
    const user = await createUser(database.db, 'ahmed');
    const upload = await blobs.put(user.id, bytes(40));
    await bundleRepo.putMeta(metaWrite({ userId: user.id }, 0, upload.blobId, 1));

    // Pushed again with nothing changed: same bytes, and the client saw revision 1.
    const again = await blobs.put(user.id, bytes(40));
    const result = await bundleRepo.putMeta(metaWrite({ userId: user.id }, 1, again.blobId, 1));
    expect(result).toMatchObject({ outcome: 'unchanged', meta: { revision: 1 } });
    expect(await bundleRepo.get(globalKey(user.id))).toMatchObject({
      revision: 1,
      blobId: upload.blobId,
    });
  });

  it('keeps separate setups per agent and scope', async () => {
    const user = await createUser(database.db, 'ahmed');
    const global = await blobs.put(user.id, bytes(40));
    const project = await blobs.put(user.id, bytes(40));
    const projectKey = { userId: user.id, scopeKey: 'a'.repeat(64) };
    await bundleRepo.putMeta(metaWrite({ userId: user.id }, 0, global.blobId, 1));
    const result = await bundleRepo.putMeta(metaWrite(projectKey, 0, project.blobId, 2));
    expect(result.outcome).toBe('saved');
  });

  it('never loses the saved file when two PCs push at the same moment', async () => {
    const user = await createUser(database.db, 'ahmed');
    const start = await blobs.put(user.id, bytes(40, 1));
    await bundleRepo.putMeta(metaWrite({ userId: user.id }, 0, start.blobId, 1));

    // Both PCs saw revision 1 and upload before either revision check runs.
    const fromA = await blobs.put(user.id, bytes(40, 0xa));
    const fromB = await blobs.put(user.id, bytes(40, 0xb));

    const resultA = await bundleRepo.putMeta(metaWrite({ userId: user.id }, 1, fromA.blobId, 0xa));
    const resultB = await bundleRepo.putMeta(metaWrite({ userId: user.id }, 1, fromB.blobId, 0xb));
    expect(resultA).toMatchObject({ outcome: 'saved', replacedBlobId: start.blobId });
    expect(resultB).toEqual({ outcome: 'conflict', currentRevision: 2 });

    // Each follows the upload order: A deletes the file it replaced, B deletes its own.
    if (resultA.outcome === 'saved' && resultA.replacedBlobId) {
      await blobs.delete({ userId: user.id, blobId: resultA.replacedBlobId });
    }
    await blobs.delete(fromB);

    const current = await bundleRepo.get(globalKey(user.id));
    expect(current?.blobId).toBe(fromA.blobId);
    expect(await blobs.get({ userId: user.id, blobId: fromA.blobId })).toEqual(bytes(40, 0xa));
    expect(await blobs.get(start)).toBeNull();
    expect(await blobs.get(fromB)).toBeNull();
  });
});

describe('storageLimitPassed (DUP-06)', () => {
  const { maxSetups, maxBytes } = USER_STORAGE_LIMITS;

  it('refuses a new setup past the count, never a new revision of one', () => {
    const full = { setups: maxSetups, bytes: 0 };
    expect(storageLimitPassed({ setups: maxSetups - 1, bytes: 0 }, null, 40)).toBeNull();
    expect(storageLimitPassed(full, null, 40)).toBe('setups');
    expect(storageLimitPassed(full, 40, 80)).toBeNull();
  });

  it('refuses growing past the bytes, never a save that does not grow', () => {
    expect(storageLimitPassed({ setups: 1, bytes: maxBytes - 40 }, null, 40)).toBeNull();
    expect(storageLimitPassed({ setups: 1, bytes: maxBytes - 40 }, null, 41)).toBe('bytes');
    expect(storageLimitPassed({ setups: 1, bytes: maxBytes - 40 }, 40, 81)).toBe('bytes');
    // Already over (say the limit was lowered): the same size or smaller still saves.
    expect(storageLimitPassed({ setups: 1, bytes: maxBytes + 1 }, 40, 40)).toBeNull();
    expect(storageLimitPassed({ setups: 1, bytes: maxBytes + 1 }, 40, 39)).toBeNull();
  });
});

describe('storage limits per account (T47)', () => {
  it(`refuses a new setup past ${String(USER_STORAGE_LIMITS.maxSetups)}, never an update`, async () => {
    const user = await createUser(database.db, 'ahmed');
    await seedSetups(database.db, 'ahmed', USER_STORAGE_LIMITS.maxSetups);
    const one = await blobs.put(user.id, bytes(40));
    expect(
      await bundleRepo.putMeta(
        metaWrite({ userId: user.id, scopeKey: scopeKeyOf(999) }, 0, one.blobId, 1),
      ),
    ).toEqual({ outcome: 'over-limit', limit: 'setups' });
    // A new revision of an existing setup still saves.
    const update = await blobs.put(user.id, bytes(40, 2));
    expect(
      await bundleRepo.putMeta(
        metaWrite({ userId: user.id, scopeKey: scopeKeyOf(0) }, 1, update.blobId, 2),
      ),
    ).toMatchObject({ outcome: 'saved' });
    expect(await bundleRepo.usage(user.id)).toEqual({
      setups: USER_STORAGE_LIMITS.maxSetups,
      bytes: 40 * USER_STORAGE_LIMITS.maxSetups,
    });
  });

  it('refuses growing past the byte limit, but never a save that does not grow', async () => {
    const user = await createUser(database.db, 'ahmed');
    const big = (key: Partial<BundleKey>, revision: number, blobId: string, size: number) => ({
      ...metaWrite({ userId: user.id, ...key }, revision, blobId, revision + 1),
      sizeBytes: size,
    });
    // Each setup is at most 5 MB, so the limit is reached with full ones.
    const full = Math.floor(USER_STORAGE_LIMITS.maxBytes / MAX_BUNDLE_BYTES);
    for (let index = 0; index < full; index++) {
      const blob = await blobs.put(user.id, bytes(40));
      await bundleRepo.putMeta(
        big({ scopeKey: scopeKeyOf(index) }, 0, blob.blobId, MAX_BUNDLE_BYTES),
      );
    }
    const extra = await blobs.put(user.id, bytes(40));
    expect(
      await bundleRepo.putMeta(big({ scopeKey: scopeKeyOf(999) }, 0, extra.blobId, 40)),
    ).toEqual({ outcome: 'over-limit', limit: 'bytes' });
    // The same size again, or smaller: always saved, so nobody gets stuck at the limit.
    const same = await blobs.put(user.id, bytes(40));
    expect(
      await bundleRepo.putMeta(big({ scopeKey: scopeKeyOf(0) }, 1, same.blobId, MAX_BUNDLE_BYTES)),
    ).toMatchObject({ outcome: 'saved' });
    const smaller = await blobs.put(user.id, bytes(40));
    expect(
      await bundleRepo.putMeta(big({ scopeKey: scopeKeyOf(1) }, 1, smaller.blobId, 40)),
    ).toMatchObject({
      outcome: 'saved',
    });
  });
});

describe('BundleRepository.list', () => {
  async function saveSetups(userId: string, count: number) {
    for (let index = 0; index < count; index++) {
      const blob = await blobs.put(userId, bytes(40));
      await bundleRepo.putMeta(
        metaWrite({ userId, scopeKey: scopeKeyOf(index) }, 0, blob.blobId, 1),
      );
    }
  }

  it('lists newest first, one page at a time, with no gaps or repeats', async () => {
    const user = await createUser(database.db, 'ahmed');
    await saveSetups(user.id, 7);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await bundleRepo.list(user.id, { limit: 3, ...(cursor && { cursor }) });
      seen.push(...page.items.map((item) => item.scopeKey));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    const all = await bundleRepo.list(user.id, { limit: 100 });
    expect(all.items.map((item) => item.scopeKey)).toEqual(seen);
    const times = all.items.map((item) => item.updatedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(all.nextCursor).toBeNull();
  });

  it('pages correctly when several setups share the exact same time', async () => {
    const user = await createUser(database.db, 'ahmed');
    await saveSetups(user.id, 5);
    await database.client.query(`update bundles set updated_at = '2026-09-25 10:00:00.123456+00'`);

    const first = await bundleRepo.list(user.id, { limit: 2 });
    const second = await bundleRepo.list(user.id, { limit: 2, cursor: first.nextCursor ?? '' });
    const third = await bundleRepo.list(user.id, { limit: 2, cursor: second.nextCursor ?? '' });
    const keys = [...first.items, ...second.items, ...third.items].map((item) => item.scopeKey);
    expect(new Set(keys).size).toBe(5);
    expect(third.nextCursor).toBeNull();
  });

  it("lists only the user's own setups", async () => {
    const owner = await createUser(database.db, 'owner');
    const other = await createUser(database.db, 'other');
    await saveSetups(owner.id, 2);
    expect((await bundleRepo.list(other.id, { limit: 10 })).items).toEqual([]);
  });

  it.each(['not-a-cursor', 'not+a/cursor', 'W10', Buffer.from('["x","y"]').toString('base64url')])(
    'throws InvalidCursorError for cursor %j',
    async (cursor) => {
      const user = await createUser(database.db, 'ahmed');
      await expect(bundleRepo.list(user.id, { limit: 3, cursor })).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
    },
  );

  // Well-formed, but not a real moment: Postgres would fail the timestamptz cast (BUG-07).
  it.each([
    '2026-13-45 99:99:99+00',
    '2026-02-30 10:00:00+00',
    '2027-02-29 10:00:00+00',
    '2026-09-25 24:00:00+00',
    '2026-09-25 10:60:00+00',
    '2026-09-25 10:00:60+00',
    '0000-01-01 10:00:00+00',
    '2026-09-25 10:00:00+16',
    '2026-09-25 10:00:00+05:60',
  ])('throws InvalidCursorError for the impossible time %j', async (updatedAt) => {
    const user = await createUser(database.db, 'ahmed');
    const cursor = encodeBundleCursor({ updatedAt, id: '00000000-0000-4000-8000-000000000000' });
    await expect(bundleRepo.list(user.id, { limit: 3, cursor })).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
  });

  it.each(['2028-02-29 23:59:59.999999+00', '2026-09-25 00:00:00-03:30', '2026-12-31 10:00:00+14'])(
    'accepts the real time %j',
    async (updatedAt) => {
      const user = await createUser(database.db, 'ahmed');
      const cursor = encodeBundleCursor({ updatedAt, id: '00000000-0000-4000-8000-000000000000' });
      expect(await bundleRepo.list(user.id, { limit: 3, cursor })).toEqual({
        items: [],
        nextCursor: null,
      });
    },
  );
});

describe('BundleRepository.delete', () => {
  it('returns what it removed, so the file can be deleted next', async () => {
    const user = await createUser(database.db, 'ahmed');
    const blob = await blobs.put(user.id, bytes(40));
    await bundleRepo.putMeta(metaWrite({ userId: user.id }, 0, blob.blobId, 1));

    const removed = await bundleRepo.delete(globalKey(user.id));
    expect(removed?.blobId).toBe(blob.blobId);
    await blobs.delete(blob);
    expect(await blobs.get(blob)).toBeNull();
    expect(await bundleRepo.delete(globalKey(user.id))).toBeNull();
  });
});
