import { eq, lt, sql } from 'drizzle-orm';

import type { ServerKeys } from '../auth/server-keys.ts';
import type { Database } from '../db/database.ts';
import { rateLimits } from '../db/schema.ts';
import type { RateLimiter, RateLimitRule, RateLimitStatus } from './rate-limiter.ts';

/** Longest window of any rule, plus margin: older rows can never matter again. */
const PRUNE_AFTER = sql.raw(`interval '1 day'`);

export interface PostgresRateLimiterDeps {
  readonly db: Database;
  readonly keys: Pick<ServerKeys, 'pseudonym'>;
  /** Whether this hit should also prune expired rows; about 1 in 100 in production. */
  readonly shouldPrune: () => boolean;
  /** Other housekeeping that runs with each prune (expired sessions, DB-02). */
  readonly alsoPrune?: () => Promise<void>;
  /** Reports a failed prune; the hit itself still counts and answers (BUG-02). */
  readonly logError: (message: string, error: unknown) => void;
}

const windowOf = (rule: RateLimitRule) => sql`make_interval(secs => ${rule.windowSeconds})`;

/** Seconds left in the window that started at `startedAt`, from the database clock. */
const secondsLeft = (rule: RateLimitRule) =>
  sql<number>`greatest(0, ceil(extract(epoch from (${rateLimits.windowStartedAt} + ${windowOf(rule)} - now()))))::int`;

/** Fixed-window counters in the `rate_limits` table, on the database clock. */
export function createPostgresRateLimiter(deps: PostgresRateLimiterDeps): RateLimiter {
  const { db, keys, shouldPrune, alsoPrune, logError } = deps;
  const keyFor = (rule: RateLimitRule, subject: string) =>
    keys.pseudonym(`${rule.name}:${subject}`);

  /** Housekeeping only: a failure must never fail the request that happened to run it. */
  async function pruneQuietly(): Promise<void> {
    try {
      await db
        .delete(rateLimits)
        .where(lt(rateLimits.windowStartedAt, sql`now() - ${PRUNE_AFTER}`));
      await alsoPrune?.();
    } catch (error) {
      logError('Could not prune expired rate limits and sessions', error);
    }
  }

  return {
    async hit(rule, subject): Promise<RateLimitStatus> {
      const key = await keyFor(rule, subject);
      const expired = sql`${rateLimits.windowStartedAt} <= now() - ${windowOf(rule)}`;
      // One atomic statement: start a window, or count within it, or restart an expired one.
      const [row] = await db
        .insert(rateLimits)
        .values({ key, windowStartedAt: sql`now()`, count: 1 })
        .onConflictDoUpdate({
          target: rateLimits.key,
          set: {
            count: sql`case when ${expired} then 1 else ${rateLimits.count} + 1 end`,
            windowStartedAt: sql`case when ${expired} then now() else ${rateLimits.windowStartedAt} end`,
          },
        })
        .returning({ count: rateLimits.count, retryAfter: secondsLeft(rule) });

      if (shouldPrune()) await pruneQuietly();
      const count = row?.count ?? 1;
      return count <= rule.limit
        ? { allowed: true, retryAfterSeconds: 0 }
        : { allowed: false, retryAfterSeconds: Math.max(1, row?.retryAfter ?? 1) };
    },

    async reset(rule, subject) {
      await db.delete(rateLimits).where(eq(rateLimits.key, await keyFor(rule, subject)));
    },
  };
}
