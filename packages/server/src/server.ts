import { fromBase64 } from '@agentnomad/contracts';
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';

import { createApi } from './api.ts';
import { createServerKeys } from './auth/server-keys.ts';
import { readServerEnv } from './db/env.ts';
import type { createApp } from './http/app.ts';
import type { ClientIp } from './http/rate-limit.ts';
import { createJsonLogger, describeError, type Logger } from './logging/logger.ts';

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
 * Neon's pooled URL in production; connections open lazily on the first query. An idle
 * connection that drops (Neon suspending, a network blip) emits `error` on the pool, which
 * Node would throw as an uncaught exception with no listener: it is logged instead, and the
 * pool opens a new connection on the next query (BUG-02).
 */
export function createDatabasePool(connectionString: string, logger: Logger): Pool {
  const pool = new Pool({ connectionString });
  pool.on('error', (error: unknown) => {
    logger.error('pool_error', describeError(error));
  });
  return pool;
}

/**
 * Builds the production API from environment settings: reads them, opens the Neon pool and
 * hands both to createApi. Settings are checked first, so a missing or bad DATABASE_URL or
 * SERVER_SECRET stops startup with a clear message (values are never printed).
 */
export async function createServerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: ServerOptions,
): Promise<Server> {
  const settings = readServerEnv(env);
  const logger = options.logger ?? createJsonLogger();

  const pool = createDatabasePool(settings.DATABASE_URL, logger);
  const { app } = createApi({
    db: drizzle({ client: pool }),
    keys: await createServerKeys(fromBase64(settings.SERVER_SECRET)),
    clientIp: options.clientIp,
    logger,
    now: () => new Date(),
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    shouldPrune: () => Math.random() < PRUNE_CHANCE,
    logError: (message, error) => {
      logger.error('cleanup_failed', { message, ...describeError(error) });
    },
  });

  return { app, close: () => pool.end() };
}
