import { eq } from 'drizzle-orm';

import type { Database } from './database.ts';
import { UsernameTakenError, type UserRecord, type UserRepository } from './repositories.ts';
import { users } from './schema.ts';

function toUserRecord(row: typeof users.$inferSelect): UserRecord {
  return {
    id: row.id,
    username: row.username,
    kdfSalt: row.kdfSalt,
    kdfParams: row.kdfParams,
    authHash: row.authHash,
    wrappedDataKey: row.wrappedDataKey,
    createdAt: row.createdAt,
  };
}

/** Accounts in Postgres (T14). */
export function createUserRepository(db: Database): UserRepository {
  return {
    async findByUsername(username) {
      const [row] = await db.select().from(users).where(eq(users.username, username)).limit(1);
      return row ? toUserRecord(row) : null;
    },

    async findById(id) {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row ? toUserRecord(row) : null;
    },

    async create(user) {
      // ON CONFLICT DO NOTHING: a taken username returns no row instead of a driver error,
      // and two registrations racing for the same name cannot both succeed.
      const [row] = await db
        .insert(users)
        .values({
          username: user.username,
          kdfSalt: user.kdfSalt,
          kdfParams: user.kdfParams,
          authHash: user.authHash,
          wrappedDataKey: user.wrappedDataKey,
        })
        .onConflictDoNothing({ target: users.username })
        .returning();
      if (!row) throw new UsernameTakenError();
      return toUserRecord(row);
    },

    async delete(id) {
      // Sessions, setups and files go with the user (ON DELETE CASCADE).
      await db.delete(users).where(eq(users.id, id));
    },
  };
}
