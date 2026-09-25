import { randomBytes } from 'node:crypto';

import { createAuthService, type AuthService } from '../../src/auth/auth-service.ts';
import { createServerKeys } from '../../src/auth/server-keys.ts';
import { createBundleService } from '../../src/bundles/bundle-service.ts';
import { createBundleRepository } from '../../src/db/bundle-repository.ts';
import { createSessionRepository } from '../../src/db/session-repository.ts';
import { createUserRepository } from '../../src/db/user-repository.ts';
import { createApp } from '../../src/http/app.ts';
import { createJsonLogger } from '../../src/logging/logger.ts';
import { createPostgresRateLimiter } from '../../src/rate-limit/postgres-rate-limiter.ts';
import { createPostgresBlobStore } from '../../src/storage/postgres-blob-store.ts';
import { createTestDatabase, type TestDatabase } from './database.ts';

export const TEST_SERVER_SECRET = new Uint8Array(32).fill(42);

/** Tests pick the visitor's IP with this header (a real host sets its own). */
export const TEST_IP_HEADER = 'x-test-client-ip';

export interface TestApp {
  readonly app: ReturnType<typeof createApp>;
  readonly auth: AuthService;
  readonly database: TestDatabase;
  /** Every log line the app wrote, parsed. */
  readonly logs: Record<string, unknown>[];
  /** Moves the app's clock (not the database's). */
  setNow(date: Date): void;
}

/** The full API on a fresh PGlite database, with a clock tests can move. */
export async function createTestApp(serverSecret = TEST_SERVER_SECRET): Promise<TestApp> {
  const database = await createTestDatabase();
  const keys = await createServerKeys(serverSecret);
  const limiter = createPostgresRateLimiter({ db: database.db, keys, shouldPrune: () => false });
  const logs: Record<string, unknown>[] = [];
  const logger = createJsonLogger((line) => logs.push(JSON.parse(line) as Record<string, unknown>));
  let now = new Date();
  const auth = createAuthService({
    users: createUserRepository(database.db),
    sessions: createSessionRepository(database.db),
    keys,
    limiter,
    now: () => now,
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
  });
  const bundles = createBundleService({
    bundles: createBundleRepository(database.db),
    blobs: createPostgresBlobStore(database.db),
    logError: (message, error) => {
      throw new Error(`Unexpected cleanup failure: ${message}`, { cause: error });
    },
  });
  return {
    app: createApp({
      auth,
      bundles,
      limiter,
      clientIp: (c) => c.req.header(TEST_IP_HEADER),
      logger,
    }),
    auth,
    database,
    logs,
    setNow: (date) => {
      now = date;
    },
  };
}

/** A JSON POST as the CLI sends it. */
export function postJson(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  };
}
