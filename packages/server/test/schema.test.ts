import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import type { KdfParams } from '@agentnomad/contracts';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bundleBlobs, bundles, sessions, users } from '../src/db/schema.ts';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

const kdfParams: KdfParams = {
  algorithm: 'argon2id',
  version: 19,
  memoryKiB: 65536,
  passes: 3,
  parallelism: 1,
};

const bytes = (length: number, fill = 7) => new Uint8Array(length).fill(fill);

let client: PGlite;
let db: ReturnType<typeof drizzle>;

/** A fresh, empty Postgres with every migration applied: what a new Neon branch gets. */
beforeEach(async () => {
  client = new PGlite();
  db = drizzle({ client });
  await migrate(db, { migrationsFolder });
});

afterEach(async () => {
  await client.close();
});

async function rows<T>(query: string): Promise<T[]> {
  return (await client.query<T>(query)).rows;
}

async function insertUser(username = 'ahmed') {
  const [user] = await db
    .insert(users)
    .values({
      username,
      kdfSalt: bytes(16),
      kdfParams,
      authHash: 'hash',
      wrappedDataKey: bytes(72),
    })
    .returning();
  if (!user) throw new Error('insert returned nothing');
  return user;
}

describe('migrations', () => {
  it('create exactly the four tables', async () => {
    const tables = await rows<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      'bundle_blobs',
      'bundles',
      'sessions',
      'users',
    ]);
  });

  it('can run again on an up-to-date database without changing anything', async () => {
    await expect(migrate(db, { migrationsFolder })).resolves.toBeUndefined();
  });

  it('create the indexes the queries rely on', async () => {
    const indexes = await rows<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' order by indexname`,
    );
    expect(indexes.map((row) => row.indexname)).toEqual([
      'bundle_blobs_pkey',
      'bundles_pkey',
      'bundles_user_agent_scope_key',
      'bundles_user_updated_idx',
      'sessions_pkey',
      'sessions_token_hash_key',
      'sessions_user_id_idx',
      'users_pkey',
      'users_username_key',
    ]);
  });

  it('store ciphertext as EXTERNAL (out of the row, never compressed)', async () => {
    const [column] = await rows<{ attstorage: string }>(
      `select attstorage from pg_attribute
       where attrelid = 'bundle_blobs'::regclass and attname = 'ciphertext'`,
    );
    expect(column?.attstorage).toBe('e');
  });

  it('keep the encrypted bytes out of the bundles table, so list queries never load them', async () => {
    const columns = await rows<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'bundles'`,
    );
    expect(columns.map((row) => row.column_name)).not.toContain('ciphertext');
  });
});

describe('users', () => {
  it('round-trips bytes as Uint8Array and KDF settings as JSON', async () => {
    const created = await insertUser();
    const [found] = await db.select().from(users).where(eq(users.id, created.id));
    expect(found?.kdfSalt).toBeInstanceOf(Uint8Array);
    expect(found?.kdfSalt).toEqual(bytes(16));
    expect(found?.wrappedDataKey).toEqual(bytes(72));
    expect(found?.kdfParams).toEqual(kdfParams);
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  it('rejects a taken username', async () => {
    await insertUser('ahmed');
    await expect(insertUser('ahmed')).rejects.toThrow();
  });

  it.each([
    ['a salt of the wrong length', { kdfSalt: bytes(15) }],
    ['a wrapped data key of the wrong length', { wrappedDataKey: bytes(71) }],
  ])('rejects %s', async (_, override) => {
    await expect(
      db.insert(users).values({
        username: 'ahmed',
        kdfSalt: bytes(16),
        kdfParams,
        authHash: 'hash',
        wrappedDataKey: bytes(72),
        ...override,
      }),
    ).rejects.toThrow();
  });
});

describe('sessions', () => {
  it('rejects a duplicate token hash', async () => {
    const user = await insertUser();
    const session = {
      userId: user.id,
      tokenHash: 'same',
      deviceName: 'laptop',
      expiresAt: new Date(Date.now() + 60_000),
    };
    await db.insert(sessions).values(session);
    await expect(db.insert(sessions).values(session)).rejects.toThrow();
  });
});

describe('bundles and bundle_blobs', () => {
  const meta = (userId: string) => ({
    userId,
    agent: 'claude-code',
    scopeKey: 'global',
    nameEnc: null,
    contentHash: bytes(32),
    formatVersion: 1,
    revision: 1,
    sizeBytes: 100,
  });

  it('allow one saved setup per user, agent and scope', async () => {
    const user = await insertUser();
    await db.insert(bundles).values(meta(user.id));
    await expect(db.insert(bundles).values(meta(user.id))).rejects.toThrow();
    await db.insert(bundles).values({ ...meta(user.id), agent: 'codex' });
  });

  it('keep the old and new revision of the bytes side by side (safe upload order)', async () => {
    const user = await insertUser();
    const blob = { userId: user.id, agent: 'claude-code', scopeKey: 'global' };
    await db.insert(bundleBlobs).values({ ...blob, revision: 1, ciphertext: bytes(40, 1) });
    await db.insert(bundleBlobs).values({ ...blob, revision: 2, ciphertext: bytes(40, 2) });
    await expect(
      db.insert(bundleBlobs).values({ ...blob, revision: 2, ciphertext: bytes(40, 3) }),
    ).rejects.toThrow();
    const stored = await db.select().from(bundleBlobs).where(eq(bundleBlobs.userId, user.id));
    expect(stored.map((row) => row.revision).sort()).toEqual([1, 2]);
  });

  it.each([
    ['revision 0', { revision: 0 }],
    ['a content hash that is not 32 bytes', { contentHash: bytes(31) }],
    ['a size over the 5 MB cap', { sizeBytes: 5 * 1024 * 1024 + 1 }],
    ['an encrypted name over 512 bytes', { nameEnc: bytes(513) }],
  ])('reject %s', async (_, override) => {
    const user = await insertUser();
    await expect(db.insert(bundles).values({ ...meta(user.id), ...override })).rejects.toThrow();
  });

  it('are deleted with their user, along with sessions (account delete)', async () => {
    const user = await insertUser();
    await db.insert(bundles).values(meta(user.id));
    await db.insert(bundleBlobs).values({
      userId: user.id,
      agent: 'claude-code',
      scopeKey: 'global',
      revision: 1,
      ciphertext: bytes(40),
    });
    await db.insert(sessions).values({
      userId: user.id,
      tokenHash: 't',
      deviceName: 'laptop',
      expiresAt: new Date(Date.now() + 60_000),
    });

    await db.delete(users).where(eq(users.id, user.id));

    expect(await db.select().from(bundles)).toEqual([]);
    expect(await db.select().from(bundleBlobs)).toEqual([]);
    expect(await db.select().from(sessions)).toEqual([]);
  });
});
