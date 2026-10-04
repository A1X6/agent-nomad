import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createServerKeys } from '../src/auth/server-keys.ts';
import { createPostgresRateLimiter } from '../src/rate-limit/postgres-rate-limiter.ts';
import type { RateLimiter, RateLimitRule } from '../src/rate-limit/rate-limiter.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';
import { bytes } from './support/fixtures.ts';

const rule: RateLimitRule = { name: 'test', limit: 3, windowSeconds: 60 };

let database: TestDatabase;
let limiter: RateLimiter;
let prune = false;
let alsoPruned = 0;
let pruneFails = false;
let logged: string[] = [];

beforeEach(async () => {
  database = await createTestDatabase();
  limiter = createPostgresRateLimiter({
    db: database.db,
    keys: await createServerKeys(bytes(32, 1)),
    shouldPrune: () => prune,
    alsoPrune: () => {
      alsoPruned++;
      return pruneFails ? Promise.reject(new Error('connection lost')) : Promise.resolve();
    },
    logError: (message) => logged.push(message),
  });
  prune = false;
  alsoPruned = 0;
  pruneFails = false;
  logged = [];
});

afterEach(async () => {
  await database.close();
});

async function hits(count: number, subject = '203.0.113.7') {
  const results = [];
  for (let index = 0; index < count; index++) results.push(await limiter.hit(rule, subject));
  return results;
}

describe('PostgresRateLimiter', () => {
  it('allows up to the limit, then refuses with the seconds left in the window', async () => {
    const results = await hits(4);
    expect(results.slice(0, 3).every((result) => result.allowed)).toBe(true);
    expect(results[3]?.allowed).toBe(false);
    expect(results[3]?.retryAfterSeconds).toBeGreaterThan(0);
    expect(results[3]?.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('counts each subject and each rule separately', async () => {
    await hits(3, 'one');
    expect((await limiter.hit(rule, 'two')).allowed).toBe(true);
    expect((await limiter.hit({ ...rule, name: 'other' }, 'one')).allowed).toBe(true);
    expect((await limiter.hit(rule, 'one')).allowed).toBe(false);
  });

  it('starts a fresh window once the old one has passed', async () => {
    await hits(4);
    await database.client.query(
      `update rate_limits set window_started_at = now() - interval '61 seconds'`,
    );
    expect((await limiter.hit(rule, '203.0.113.7')).allowed).toBe(true);
  });

  it('reset forgets the count', async () => {
    await hits(4);
    await limiter.reset(rule, '203.0.113.7');
    expect((await limiter.hit(rule, '203.0.113.7')).allowed).toBe(true);
  });

  it('never stores the readable IP or username', async () => {
    await hits(1, '203.0.113.7');
    await hits(1, 'ahmed');
    const { rows } = await database.client.query<{ key: string }>('select key from rate_limits');
    for (const { key } of rows) {
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(key).not.toContain('203.0.113.7');
      expect(key).not.toContain('ahmed');
    }
  });

  it('prunes counters older than a day when asked', async () => {
    await hits(1, 'old');
    await database.client.query(
      `update rate_limits set window_started_at = now() - interval '2 days'`,
    );
    prune = true;
    await hits(1, 'new');
    const { rows } = await database.client.query('select key from rate_limits');
    expect(rows).toHaveLength(1);
  });

  it('runs the other housekeeping only with a prune (DB-02)', async () => {
    await hits(2);
    expect(alsoPruned).toBe(0);
    prune = true;
    await hits(1);
    expect(alsoPruned).toBe(1);
  });

  it('still answers the hit when the housekeeping fails, and logs it (BUG-02)', async () => {
    await hits(2);
    prune = true;
    pruneFails = true;
    expect(await hits(1)).toEqual([{ allowed: true, retryAfterSeconds: 0 }]);
    expect(logged).toEqual(['Could not prune expired rate limits and sessions']);
    // The failed prune did not undo the count: the next hit is over the limit.
    expect((await hits(1))[0]?.allowed).toBe(false);
  });
});
