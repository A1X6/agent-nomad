import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { serve } from '@hono/node-server';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

import {
  createApp,
  createAuthService,
  createBundleRepository,
  createBundleService,
  createJsonLogger,
  createPostgresBlobStore,
  createPostgresRateLimiter,
  createServerKeys,
  createSessionRepository,
  createUserRepository,
} from '@agentnomad/server';

const migrationsFolder = fileURLToPath(new URL('../../server/drizzle', import.meta.url));

/**
 * The same on every machine of a chain, so a database saved on one OS still accepts the
 * logins on the next. Only ever used by this throwaway local server.
 */
const E2E_SERVER_SECRET = new Uint8Array(32).fill(7);

export interface LocalServer {
  /** `http://127.0.0.1:<port>`, for `AGENTNOMAD_API_URL`. */
  readonly url: string;
  /** Rows in a table, e.g. to check account delete left nothing behind. */
  count(table: 'users' | 'sessions' | 'bundles' | 'bundle_blobs'): Promise<number>;
  /** The whole database as a gzipped tarball, for the next machine of the chain. */
  dump(): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * The real API code (T13–T18) on an in-memory Postgres (PGlite), listening on a free local
 * port: empty, or loaded from a dump another machine saved. Nothing reaches the hosted API.
 */
export async function startLocalServer(load?: Uint8Array): Promise<LocalServer> {
  const client = new PGlite(load ? { loadDataDir: new Blob([new Uint8Array(load)]) } : {});
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder });

  const keys = await createServerKeys(E2E_SERVER_SECRET);
  const limiter = createPostgresRateLimiter({ db, keys, shouldPrune: () => false });
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
        throw new Error(`Unexpected cleanup failure: ${message}`, { cause: error });
      },
    }),
    limiter,
    // Every request comes from this machine.
    clientIp: () => '127.0.0.1',
    logger: createJsonLogger(() => undefined),
  });

  const { http, port } = await new Promise<{ http: ReturnType<typeof serve>; port: number }>(
    (resolve) => {
      const http = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
        resolve({ http, port: info.port });
      });
    },
  );

  return {
    url: `http://127.0.0.1:${String(port)}`,
    count: async (table) => {
      const result = await client.query<{ n: number }>(`select count(*)::int as n from ${table}`);
      return result.rows[0]?.n ?? 0;
    },
    dump: async () => new Uint8Array(await (await client.dumpDataDir('gzip')).arrayBuffer()),
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        http.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await client.close();
    },
  };
}
