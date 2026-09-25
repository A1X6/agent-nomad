import { describe, expect, it } from 'vitest';

import { readDatabaseEnv } from '../src/db/env.ts';

describe('readDatabaseEnv', () => {
  it.each([
    'postgresql://user:secret@ep-example.eu-central-1.aws.neon.tech/neondb?sslmode=require',
    'postgres://user:secret@localhost:5432/agentnomad',
  ])('accepts %s', (url) => {
    expect(readDatabaseEnv({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('fails clearly when DATABASE_URL is missing', () => {
    expect(() => readDatabaseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a URL that is not a Postgres connection string', () => {
    expect(() => readDatabaseEnv({ DATABASE_URL: 'https://example.com' })).toThrow(/DATABASE_URL/);
  });

  it('never puts the password in the error message', () => {
    try {
      readDatabaseEnv({ DATABASE_URL: 'mysql://user:hunter2@host/db' });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('hunter2');
    }
  });
});
