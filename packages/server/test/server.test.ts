import { describe, expect, it } from 'vitest';

import { createServerFromEnv } from '../src/server.ts';

describe('createServerFromEnv', () => {
  const secret = Buffer.alloc(32, 7).toString('base64');
  const url = 'postgresql://user:hunter2@ep-example.eu-central-1.aws.neon.tech/neondb';

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
