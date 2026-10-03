import { createAuthService } from './auth/auth-service.ts';
import type { ServerKeys } from './auth/server-keys.ts';
import { createBundleService } from './bundles/bundle-service.ts';
import { createBundleRepository } from './db/bundle-repository.ts';
import type { Database } from './db/database.ts';
import { createSessionRepository } from './db/session-repository.ts';
import { createUserRepository } from './db/user-repository.ts';
import { createApp } from './http/app.ts';
import type { ClientIp } from './http/rate-limit.ts';
import type { Logger } from './logging/logger.ts';
import { createPostgresRateLimiter } from './rate-limit/postgres-rate-limiter.ts';
import { createPostgresBlobStore } from './storage/postgres-blob-store.ts';

export interface ApiDeps {
  /** Neon in production, PGlite in tests and the e2e local server. */
  readonly db: Database;
  readonly keys: ServerKeys;
  /** How to read the visitor's IP on this host (T19). */
  readonly clientIp: ClientIp;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly randomBytes: (length: number) => Uint8Array;
  /** Whether a rate-limit hit also prunes expired counters and sessions. */
  readonly shouldPrune: () => boolean;
  /** Whether a save also sweeps unused bundle files; about one in 50 when left out. */
  readonly shouldSweep?: () => boolean;
  /** Reports housekeeping failures; the request itself still succeeds. */
  readonly logError: (message: string, error: unknown) => void;
}

/**
 * The whole API wired from one database (DUP-02): the only place services, limiter and app
 * are put together, used by production, the server tests and the e2e local server.
 */
export function createApi(deps: ApiDeps) {
  const { db, keys, logError } = deps;
  const sessions = createSessionRepository(db);
  const limiter = createPostgresRateLimiter({
    db,
    keys,
    shouldPrune: deps.shouldPrune,
    // Sessions of users who never log in again are removed here (DB-02).
    alsoPrune: () => sessions.deleteExpired(),
    logError,
  });
  const auth = createAuthService({
    users: createUserRepository(db),
    sessions,
    keys,
    limiter,
    now: deps.now,
    randomBytes: deps.randomBytes,
  });
  const app = createApp({
    auth,
    bundles: createBundleService({
      bundles: createBundleRepository(db),
      blobs: createPostgresBlobStore(db),
      logError,
      ...(deps.shouldSweep && { shouldSweep: deps.shouldSweep }),
    }),
    limiter,
    clientIp: deps.clientIp,
    logger: deps.logger,
  });
  return { app, auth };
}
