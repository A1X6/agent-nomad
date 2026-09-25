import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';

import { createAuthService } from './auth/auth-service.ts';
import { createServerKeys } from './auth/server-keys.ts';
import { createBundleService } from './bundles/bundle-service.ts';
import { createBundleRepository } from './db/bundle-repository.ts';
import { readServerEnv } from './db/env.ts';
import { createSessionRepository } from './db/session-repository.ts';
import { createUserRepository } from './db/user-repository.ts';
import { fromBase64 } from './encoding.ts';
import { createApp } from './http/app.ts';
import type { ClientIp } from './http/rate-limit.ts';
import { createJsonLogger, describeError, type Logger } from './logging/logger.ts';
import { createPostgresRateLimiter } from './rate-limit/postgres-rate-limiter.ts';
import { createPostgresBlobStore } from './storage/postgres-blob-store.ts';

export interface ServerOptions {
  /** How to read the visitor's IP on this host (T19). */
  readonly clientIp: ClientIp;
  readonly logger?: Logger;
}

export interface Server {
  readonly app: ReturnType<typeof createApp>;
  /** Closes database connections (for graceful shutdown). */
  close(): Promise<void>;
}

/** Share of rate-limit hits that also prune expired counters. */
const PRUNE_CHANCE = 0.01;

/**
 * The composition root: builds the whole API from environment settings. Settings are
 * checked first, so a missing or bad DATABASE_URL or SERVER_SECRET stops startup with a
 * clear message (values are never printed).
 */
export async function createServerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: ServerOptions,
): Promise<Server> {
  const settings = readServerEnv(env);
  const logger = options.logger ?? createJsonLogger();

  // Neon's pooled URL in production; connections open lazily on the first query.
  const pool = new Pool({ connectionString: settings.DATABASE_URL });
  const db = drizzle({ client: pool });
  const keys = await createServerKeys(fromBase64(settings.SERVER_SECRET));
  const limiter = createPostgresRateLimiter({
    db,
    keys,
    shouldPrune: () => Math.random() < PRUNE_CHANCE,
  });

  const app = createApp({
    auth: createAuthService({
      users: createUserRepository(db),
      sessions: createSessionRepository(db),
      keys,
      limiter,
      now: () => new Date(),
      randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    }),
    bundles: createBundleService({
      bundles: createBundleRepository(db),
      blobs: createPostgresBlobStore(db),
      logError: (message, error) => {
        logger.error('cleanup_failed', { message, ...describeError(error) });
      },
    }),
    limiter,
    clientIp: options.clientIp,
    logger,
  });

  return { app, close: () => pool.end() };
}
