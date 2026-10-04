import {
  ErrorResponseSchema,
  GetBundleResponseHeadersSchema,
  ListBundlesResponseSchema,
  MAX_BUNDLE_BYTES,
  PutBundleResponseSchema,
  USER_STORAGE_LIMITS,
} from '@agentnomad/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RATE_LIMITS } from '../src/rate-limit/rate-limiter.ts';
import { createTestApp, type TestApp } from './support/app.ts';
import {
  b64,
  bearer,
  bytes,
  errorCode,
  putSetup,
  registerForToken,
  scopeKeyOf,
  type PutSetupOptions,
  seedSetups,
  sha256Hex,
} from './support/fixtures.ts';

const PROJECT = 'a'.repeat(64);
const GLOBAL_PATH = '/bundles/claude-code/global';
const PROJECT_PATH = `/bundles/claude-code/${PROJECT}`;

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
});

afterEach(async () => {
  await t.database.close();
});

const register = (username = 'ahmed') => registerForToken(t.app, username);

const put = (token: string, options: PutSetupOptions) => putSetup(t.app, token, options);

const as = (token: string, method = 'GET') => ({
  method,
  headers: bearer(token),
});

async function error(res: Response) {
  return ErrorResponseSchema.parse(await res.json()).error;
}

async function fileCount(): Promise<number> {
  const { rows } = await t.database.client.query<{ n: number }>(
    'select count(*)::int as n from bundle_blobs',
  );
  return rows[0]?.n ?? -1;
}

describe('access', () => {
  it.each([
    ['GET', '/bundles'],
    ['GET', GLOBAL_PATH],
    ['PUT', GLOBAL_PATH],
    ['DELETE', GLOBAL_PATH],
  ])('%s %s needs a session', async (method, path) => {
    const res = await t.app.request(path, { method });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('unauthorized');
  });

  it("never shows, returns or deletes another user's setup", async () => {
    const owner = await register('owner');
    const other = await register('other');
    expect((await put(owner, { expected: 0, body: bytes(64, 1) })).status).toBe(200);

    expect((await t.app.request(GLOBAL_PATH, as(other))).status).toBe(404);
    expect((await t.app.request(GLOBAL_PATH, as(other, 'DELETE'))).status).toBe(404);
    const list = ListBundlesResponseSchema.parse(
      await (await t.app.request('/bundles', as(other))).json(),
    );
    expect(list.items).toEqual([]);
    expect((await t.app.request(GLOBAL_PATH, as(owner))).status).toBe(200);
  });
});

describe('PUT then GET', () => {
  it('saves raw bytes and returns them byte for byte with their headers', async () => {
    const token = await register();
    const body = bytes(1000, 7);
    const res = await put(token, { expected: 0, body });
    expect(res.status).toBe(200);
    expect(PutBundleResponseSchema.parse(await res.json()).revision).toBe(1);

    const got = await t.app.request(GLOBAL_PATH, as(token));
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('application/octet-stream');
    const headers = GetBundleResponseHeadersSchema.parse(Object.fromEntries(got.headers));
    expect(headers['x-an-revision']).toBe(1);
    expect(headers['x-an-content-sha256']).toBe(sha256Hex(body));
    expect(headers['x-an-format-version']).toBe(1);
    expect(headers['x-an-name-enc']).toBeUndefined();
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(body);
  });

  it('returns 404 for a setup that was never saved', async () => {
    const token = await register();
    const res = await t.app.request(GLOBAL_PATH, as(token));
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
  });

  it('keeps project names encrypted and returns them with the bytes', async () => {
    const token = await register();
    const nameEnc = bytes(60, 9);
    const res = await put(token, { expected: 0, body: bytes(64, 1), path: PROJECT_PATH, nameEnc });
    expect(res.status).toBe(200);
    const got = await t.app.request(PROJECT_PATH, as(token));
    expect(got.headers.get('x-an-name-enc')).toBe(b64(nameEnc));
  });
});

describe('PUT revision rules', () => {
  it('saves the next revision and deletes the file it replaced', async () => {
    const token = await register();
    await put(token, { expected: 0, body: bytes(64, 1) });
    const res = await put(token, { expected: 1, body: bytes(64, 2) });
    expect(PutBundleResponseSchema.parse(await res.json()).revision).toBe(2);
    expect(await fileCount()).toBe(1);
    const got = await t.app.request(GLOBAL_PATH, as(token));
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes(64, 2));
  });

  it('refuses a push from an old revision with 409 and the current revision', async () => {
    const token = await register();
    await put(token, { expected: 0, body: bytes(64, 1) });
    await put(token, { expected: 1, body: bytes(64, 2) });

    const stale = await put(token, { expected: 1, body: bytes(64, 3) });
    expect(stale.status).toBe(409);
    expect(await error(stale)).toMatchObject({ code: 'revision_conflict', currentRevision: 2 });
    expect(await fileCount()).toBe(1);
    const got = await t.app.request(GLOBAL_PATH, as(token));
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes(64, 2));
  });

  it('answers a repeated PUT with the same bytes as success, without a new revision', async () => {
    const token = await register();
    const first = await put(token, { expected: 0, body: bytes(64, 1) });
    const retry = await put(token, { expected: 0, body: bytes(64, 1) });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    expect(await fileCount()).toBe(1);
  });

  it('reports 409 without a revision when the setup was deleted meanwhile', async () => {
    const token = await register();
    const res = await put(token, { expected: 3, body: bytes(64, 1) });
    expect(res.status).toBe(409);
    const body = await error(res);
    expect(body.code).toBe('revision_conflict');
    expect(body.currentRevision).toBeUndefined();
    expect(await fileCount()).toBe(0);
  });
});

describe('PUT checks', () => {
  it('refuses bytes that do not match their content hash, keeping nothing', async () => {
    const token = await register();
    const res = await put(token, { expected: 0, body: bytes(64, 1), hash: 'b'.repeat(64) });
    expect(res.status).toBe(400);
    expect(await fileCount()).toBe(0);
  });

  it('accepts exactly 5 MB and refuses one byte more with 413', async () => {
    const token = await register();
    const max = await put(token, { expected: 0, body: bytes(MAX_BUNDLE_BYTES, 1) });
    expect(max.status).toBe(200);
    const over = await put(token, { expected: 1, body: bytes(MAX_BUNDLE_BYTES + 1, 2) });
    expect(over.status).toBe(413);
    expect(await errorCode(over)).toBe('payload_too_large');
  });

  it.each([
    ['a body too small to be encrypted', { body: bytes(39, 1) }],
    ['a JSON content type', { body: bytes(64, 1), contentType: 'application/json' }],
    ['a missing revision header', { body: bytes(64, 1), omitHeader: 'x-an-expected-revision' }],
    ['a project name on the global setup', { body: bytes(64, 1), nameEnc: bytes(40, 1) }],
    ['a project setup without its name', { body: bytes(64, 1), path: PROJECT_PATH }],
    ['an invalid agent', { body: bytes(64, 1), path: '/bundles/Claude/global' }],
    ['an invalid scope key', { body: bytes(64, 1), path: '/bundles/claude-code/my-project' }],
  ])('refuses %s with 400', async (_, options) => {
    const token = await register();
    const res = await put(token, { expected: 0, ...options });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('bad_request');
    expect(await fileCount()).toBe(0);
  });
});

describe('GET /bundles', () => {
  it('checks the session once (DB-01)', async () => {
    const token = await register();
    const authenticate = vi.spyOn(t.auth, 'authenticate');
    expect((await t.app.request('/bundles', as(token))).status).toBe(200);
    expect(authenticate).toHaveBeenCalledTimes(1);
    authenticate.mockClear();
    expect((await t.app.request(GLOBAL_PATH, as(token))).status).toBe(404);
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it('lists metadata only, newest first, page by page', async () => {
    const token = await register();
    for (let index = 0; index < 5; index++) {
      const scopeKey = scopeKeyOf(index);
      await put(token, {
        expected: 0,
        body: bytes(64, index),
        path: `/bundles/claude-code/${scopeKey}`,
        nameEnc: bytes(40, index),
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const page = ListBundlesResponseSchema.parse(
        await (await t.app.request(`/bundles${query}`, as(token))).json(),
      );
      seen.push(...page.items.map((item) => item.scopeKey));
      expect(page.items.every((item) => item.nameEnc !== null && item.sizeBytes === 64)).toBe(true);
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(5);
  });

  // A well-formed cursor with an impossible time is refused like any bad cursor (BUG-07).
  const impossibleTime = Buffer.from(
    JSON.stringify(['2026-13-45 99:99:99+00', '00000000-0000-4000-8000-000000000000']),
  ).toString('base64url');

  it.each(['?cursor=bad-cursor', `?cursor=${impossibleTime}`, '?limit=0', '?limit=101'])(
    'refuses %s with 400',
    async (query) => {
      const token = await register();
      const res = await t.app.request(`/bundles${query}`, as(token));
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('bad_request');
    },
  );
});

describe('DELETE', () => {
  it('removes the setup and its file; a second delete is 404', async () => {
    const token = await register();
    await put(token, { expected: 0, body: bytes(64, 1) });
    expect((await t.app.request(GLOBAL_PATH, as(token, 'DELETE'))).status).toBe(204);
    expect((await t.app.request(GLOBAL_PATH, as(token))).status).toBe(404);
    expect(await fileCount()).toBe(0);
    expect((await t.app.request(GLOBAL_PATH, as(token, 'DELETE'))).status).toBe(404);
  });

  it('lets the setup be saved fresh again afterwards', async () => {
    const token = await register();
    await put(token, { expected: 0, body: bytes(64, 1) });
    await t.app.request(GLOBAL_PATH, as(token, 'DELETE'));
    const res = await put(token, { expected: 0, body: bytes(64, 2) });
    expect(PutBundleResponseSchema.parse(await res.json()).revision).toBe(1);
  });
});

describe('limits per account (T47)', () => {
  it(`refuses a new setup past ${String(USER_STORAGE_LIMITS.maxSetups)} with 413 and says why, storing nothing`, async () => {
    const token = await register();
    // All but the last straight into the database; the last one through the API (QA-12).
    const last = USER_STORAGE_LIMITS.maxSetups - 1;
    await seedSetups(t.database.db, 'ahmed', last);
    const lastPath = `/bundles/claude-code/${scopeKeyOf(last)}`;
    const atLimit = await put(token, {
      expected: 0,
      body: bytes(64, 1),
      path: lastPath,
      nameEnc: bytes(40, 1),
    });
    expect(atLimit.status).toBe(200);
    const files = await fileCount();
    const res = await put(token, { expected: 0, body: bytes(64, 2) });
    expect(res.status).toBe(413);
    const body = await error(res);
    expect(body.code).toBe('payload_too_large');
    expect(body.message).toContain(`at most ${String(USER_STORAGE_LIMITS.maxSetups)} saved setups`);
    expect(await fileCount()).toBe(files);
  });

  it(`allows ${String(RATE_LIMITS.writesPerAccount.limit)} saves and deletes an hour per account, then 429`, async () => {
    const token = await register();
    for (let index = 0; index < RATE_LIMITS.writesPerAccount.limit; index++) {
      expect((await t.app.request(GLOBAL_PATH, as(token, 'DELETE'))).status).toBe(404);
    }
    const res = await t.app.request(GLOBAL_PATH, as(token, 'DELETE'));
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('rate_limited');
    // Downloads have their own limit, and the list has none.
    expect((await t.app.request(GLOBAL_PATH, as(token))).status).toBe(404);
    expect((await t.app.request('/bundles', as(token))).status).toBe(200);
  });

  it(`allows ${String(RATE_LIMITS.readsPerAccount.limit)} downloads an hour per account, then 429 (SEC-03)`, async () => {
    const token = await register();
    const other = await register('other');
    expect((await put(token, { expected: 0, body: bytes(64) })).status).toBe(200);
    const { rows: before } = await t.database.client.query<{ key: string }>(
      'select key from rate_limits',
    );
    expect((await t.app.request(GLOBAL_PATH, as(token))).status).toBe(200);
    // Skip ahead to the last allowed download instead of making hundreds of requests: the
    // only new counter is this account's download counter.
    const { affectedRows } = await t.database.client.query(
      'update rate_limits set count = $1 where not (key = any($2))',
      [RATE_LIMITS.readsPerAccount.limit - 1, before.map((row) => row.key)],
    );
    expect(affectedRows).toBe(1);
    expect((await t.app.request(GLOBAL_PATH, as(token))).status).toBe(200);

    const res = await t.app.request(GLOBAL_PATH, as(token));
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('rate_limited');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    // Per account: another account still downloads; the list and saves are not counted here.
    expect((await t.app.request(GLOBAL_PATH, as(other))).status).toBe(404);
    expect((await t.app.request('/bundles', as(token))).status).toBe(200);
    expect((await put(token, { expected: 1, body: bytes(64, 2) })).status).toBe(200);
  });
});
