import { describe, expect, it } from 'vitest';

import { createDatabasePool, createServerFromEnv } from '../src/server.ts';
import { b64, bytes, memoryLogger } from './support/fixtures.ts';

const url = 'postgresql://user:hunter2@ep-example.eu-central-1.aws.neon.tech/neondb';

describe('createServerFromEnv', () => {
  const secret = b64(bytes(32, 7));

  it('refuses to start without valid settings, never printing their values', async () => {
    await expect(
      createServerFromEnv({ DATABASE_URL: url }, { clientIp: () => undefined }),
    ).rejects.toThrow(/SERVER_SECRET/);
    await expect(
      createServerFromEnv(
        { SERVER_SECRET: secret, DATABASE_URL: 'nope' },
        { clientIp: () => undefined },
      ),
    ).rejects.toThrow(/DATABASE_URL/);
    const refused = createServerFromEnv(
      { DATABASE_URL: 'mysql://u:hunter2@h/db', SERVER_SECRET: secret },
      { clientIp: () => undefined },
    );
    await expect(refused).rejects.toThrow(/DATABASE_URL/);
    const error: unknown = await refused.catch((caught: unknown) => caught);
    expect(String(error)).not.toContain('hunter2');
  });

  it('builds the whole API from valid settings (no database needed for /health)', async () => {
    const server = await createServerFromEnv(
      { DATABASE_URL: url, SERVER_SECRET: secret },
      { clientIp: () => undefined, logger: { info: () => undefined, error: () => undefined } },
    );
    const res = await server.app.request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    await server.close();
  });
});

describe('database pool errors (BUG-02)', () => {
  it('logs an error from an idle connection instead of crashing the process', async () => {
    const { logger, errors } = memoryLogger();
    const pool = createDatabasePool(url, logger);
    // With no listener, Node throws an emitted 'error'; with one, emit returns normally.
    expect(() => pool.emit('error', new Error('connection dropped'))).not.toThrow();
    expect(errors.map((entry) => entry.event)).toEqual(['pool_error']);
    expect(errors[0]?.fields).toMatchObject({ errorMessage: 'connection dropped' });
    expect(JSON.stringify(errors)).not.toContain('hunter2');
    await pool.end();
  });
});
