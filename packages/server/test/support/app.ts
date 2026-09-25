import { randomBytes } from 'node:crypto';

import { createAuthService, type AuthService } from '../../src/auth/auth-service.ts';
import { createServerKeys } from '../../src/auth/server-keys.ts';
import { createSessionRepository } from '../../src/db/session-repository.ts';
import { createUserRepository } from '../../src/db/user-repository.ts';
import { createApp } from '../../src/http/app.ts';
import { createTestDatabase, type TestDatabase } from './database.ts';

export const TEST_SERVER_SECRET = new Uint8Array(32).fill(42);

export interface TestApp {
  readonly app: ReturnType<typeof createApp>;
  readonly auth: AuthService;
  readonly database: TestDatabase;
  /** Moves the app's clock (not the database's). */
  setNow(date: Date): void;
}

/** The full API on a fresh PGlite database, with a clock tests can move. */
export async function createTestApp(serverSecret = TEST_SERVER_SECRET): Promise<TestApp> {
  const database = await createTestDatabase();
  let now = new Date();
  const auth = createAuthService({
    users: createUserRepository(database.db),
    sessions: createSessionRepository(database.db),
    keys: await createServerKeys(serverSecret),
    now: () => now,
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
  });
  return {
    app: createApp({ auth }),
    auth,
    database,
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
