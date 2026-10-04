import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach } from 'vitest';

import { createApi } from '../../src/api.ts';
import type { AuthService } from '../../src/auth/auth-service.ts';
import { createServerKeys } from '../../src/auth/server-keys.ts';
import type { createApp } from '../../src/http/app.ts';
import { createJsonLogger } from '../../src/logging/logger.ts';
import { createTestDatabase, type TestDatabase } from './database.ts';

const TEST_SERVER_SECRET = new Uint8Array(32).fill(42);

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
  const logs: Record<string, unknown>[] = [];
  let now = new Date();
  const { app, auth } = createApi({
    db: database.db,
    keys: await createServerKeys(serverSecret),
    clientIp: (c) => c.req.header(TEST_IP_HEADER),
    logger: createJsonLogger((line) => logs.push(JSON.parse(line) as Record<string, unknown>)),
    now: () => now,
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
    // No housekeeping at random moments: a test that wants it builds its own limiter.
    shouldPrune: () => false,
    shouldSweep: () => false,
    logError: (message, error) => {
      throw new Error(`Unexpected cleanup failure: ${message}`, { cause: error });
    },
  });
  return {
    app,
    auth,
    database,
    logs,
    setNow: (date) => {
      now = date;
    },
  };
}

/** A fresh test app before each test of the calling file, handed to `use`, closed after it. */
export function useTestApp(use: (t: TestApp) => void): void {
  let t: TestApp | undefined;
  beforeEach(async () => {
    t = await createTestApp();
    use(t);
  });
  afterEach(async () => {
    await t?.database.close();
  });
}

/** A JSON POST as the CLI sends it. */
export function postJson(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  };
}
