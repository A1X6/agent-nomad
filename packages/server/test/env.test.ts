import { describe, expect, it } from 'vitest';

import { readDatabaseEnv, readServerEnv } from '../src/db/env.ts';

const DATABASE_URL = 'postgresql://user:secret@ep-example.eu-central-1.aws.neon.tech/neondb';

describe('readServerEnv', () => {
  it('accepts a 32-byte base64 SERVER_SECRET', () => {
    const SERVER_SECRET = Buffer.alloc(32, 1).toString('base64');
    expect(readServerEnv({ DATABASE_URL, SERVER_SECRET }).SERVER_SECRET).toBe(SERVER_SECRET);
  });

  it.each([
    ['missing', undefined],
    ['too short', Buffer.alloc(16, 1).toString('base64')],
    ['not base64', 'this is not base64!'],
  ])('rejects a SERVER_SECRET that is %s, without printing it', (_, SERVER_SECRET) => {
    expect(() => readServerEnv({ DATABASE_URL, SERVER_SECRET })).toThrow(/SERVER_SECRET/);
    try {
      readServerEnv({ DATABASE_URL, SERVER_SECRET });
    } catch (error) {
      if (SERVER_SECRET) expect(String(error)).not.toContain(SERVER_SECRET);
    }
  });
});

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
