import { and, eq, gt, sql } from 'drizzle-orm';

import type { Database } from './database.ts';
import type { SessionRecord, SessionRepository } from './repositories.ts';
import { sessions } from './schema.ts';

function toSessionRecord(row: typeof sessions.$inferSelect): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    deviceName: row.deviceName,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/** Logins in Postgres (T14). Only token hashes are stored. */
export function createSessionRepository(db: Database): SessionRepository {
  return {
    async create(session) {
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
    },

    async findByTokenHash(tokenHash) {
      // The database clock decides expiry, so every server instance agrees.
      const [row] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, sql`now()`)))
        .limit(1);
      return row ? toSessionRecord(row) : null;
    },

    async delete(id) {
      await db.delete(sessions).where(eq(sessions.id, id));
    },
  };
}
