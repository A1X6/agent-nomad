import { and, eq, gt, lt, lte, or, sql } from 'drizzle-orm';

import type { Database } from './database.ts';
import type { NewSession, SessionRecord, SessionRepository } from './repositories.ts';
import { sessions } from './schema.ts';

function toSessionRecord(row: typeof sessions.$inferSelect): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    deviceName: row.deviceName,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

/** Inserts a session; `db` may be a transaction (register writes the user with it). */
export async function insertSession(db: Database, session: NewSession): Promise<SessionRecord> {
  const [row] = await db
    .insert(sessions)
    .values({
      userId: session.userId,
      tokenHash: session.tokenHash,
      deviceName: session.deviceName,
      expiresAt: session.expiresAt,
    })
    .returning();
  if (!row) throw new Error('Session insert returned no row');
  return toSessionRecord(row);
}

/** Logins in Postgres (T14). Only token hashes are stored. */
export function createSessionRepository(db: Database): SessionRepository {
  return {
    create: (session) => insertSession(db, session),

    async findByTokenHash(tokenHash) {
      // The database clock decides expiry, so every server instance agrees.
      const [row] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, sql`now()`)))
        .limit(1);
      return row ? toSessionRecord(row) : null;
    },

    async touch(id) {
      await db
        .update(sessions)
        .set({ lastUsedAt: sql`now()` })
        .where(eq(sessions.id, id));
    },

    async delete(id) {
      await db.delete(sessions).where(eq(sessions.id, id));
    },

    async deleteStale(userId, idleTimeoutMs) {
      const idleSeconds = Math.floor(idleTimeoutMs / 1000);
      // Uses sessions_user_id_idx; only this user's rows are touched.
      await db
        .delete(sessions)
        .where(
          and(
            eq(sessions.userId, userId),
            or(
              lte(sessions.expiresAt, sql`now()`),
              lt(sessions.lastUsedAt, sql`now() - make_interval(secs => ${idleSeconds})`),
            ),
          ),
        );
    },

    async deleteExpired() {
      // Every user's, through sessions_expires_at_idx; runs with the rate limiter's prune.
      await db.delete(sessions).where(lte(sessions.expiresAt, sql`now()`));
    },
  };
}
