import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeEach } from 'vitest';

import type { Database } from '../../src/db/database.ts';

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

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

/**
 * A fresh test database before each test of the calling file, handed to `use` (which may set
 * up more on it), and closed after the test.
 */
export function useTestDatabase(use: (database: TestDatabase) => void | Promise<void>): void {
  let database: TestDatabase | undefined;
  beforeEach(async () => {
    database = await createTestDatabase();
    await use(database);
  });
  afterEach(async () => {
    await database?.close();
  });
}
