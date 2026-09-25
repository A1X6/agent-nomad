import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

/**
 * Any Drizzle Postgres database: Neon (serverless driver) in production, PGlite in tests.
 * Repositories depend on this, never on a specific driver.
 */
export type Database = PgDatabase<PgQueryResultHKT>;

/** Postgres error code (e.g. `23503` foreign key violation), looking through Drizzle's wrapper. */
export function postgresErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

export const FOREIGN_KEY_VIOLATION = '23503';
