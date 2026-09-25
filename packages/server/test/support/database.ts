import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

import type { Database } from '../../src/db/database.ts';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface TestDatabase {
  readonly db: Database;
  readonly client: PGlite;
  close(): Promise<void>;
}

/** A fresh in-memory Postgres with every migration applied. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const client = new PGlite();
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder });
  return { db, client, close: () => client.close() };
}
