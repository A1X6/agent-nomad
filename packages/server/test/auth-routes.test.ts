import {
  DEFAULT_KDF_PARAMS,
  ErrorResponseSchema,
  LoginResponseSchema,
  PreloginResponseSchema,
  SessionResponseSchema,
  type KdfParams,
} from '@agentnomad/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_LIFETIME_MS } from '../src/auth/auth-service.ts';
import { createTestApp, postJson, type TestApp } from './support/app.ts';

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

const realKdf: KdfParams = { ...DEFAULT_KDF_PARAMS, memoryKiB: 131_072 };
const authKey = b64(bytes(32, 1));

const registration = (username = 'ahmed') => ({
  username,
  kdfSalt: b64(bytes(16, 9)),
  kdfParams: realKdf,
  authKey,
  wrappedDataKey: b64(bytes(72, 5)),
  deviceName: 'laptop',
});

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
});

afterEach(async () => {
  await t.database.close();
});

async function register(username = 'ahmed'): Promise<string> {
  const res = await t.app.request('/auth/register', postJson(registration(username)));
  expect(res.status).toBe(201);
  return SessionResponseSchema.parse(await res.json()).sessionToken;
}

async function errorCode(res: Response): Promise<string> {
  return ErrorResponseSchema.parse(await res.json()).error.code;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('every response', () => {
  it('health check answers ok', async () => {
    const res = await t.app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it.each(['/health', '/nope'])('%s is never cached and never sniffed', async (path) => {
    const res = await t.app.request(path);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sends no CORS headers, so no website can read API responses', async () => {
    const res = await t.app.request('/auth/prelogin', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const post = await t.app.request(
      '/auth/prelogin',
      postJson({ username: 'ahmed' }, { origin: 'https://evil.example' }),
    );
    expect(post.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('unknown paths get the standard error body', async () => {
    const res = await t.app.request('/nope');
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
  });
});

describe('POST /auth/prelogin', () => {
  it('returns the stored salt and settings for a real account', async () => {
    await register();
    const res = await t.app.request('/auth/prelogin', postJson({ username: 'ahmed' }));
    expect(PreloginResponseSchema.parse(await res.json())).toEqual({
      kdfSalt: b64(bytes(16, 9)),
      kdfParams: realKdf,
    });
  });

  it('answers an unknown username exactly like a real one', async () => {
    const res = await t.app.request('/auth/prelogin', postJson({ username: 'ghost' }));
    expect(res.status).toBe(200);
    const body = PreloginResponseSchema.parse(await res.json());
    expect(body.kdfParams).toEqual(DEFAULT_KDF_PARAMS);
    expect(Buffer.from(body.kdfSalt, 'base64')).toHaveLength(16);
  });

  it('gives the same fake salt every time, so repeating it reveals nothing', async () => {
    const ask = async (username: string) =>
      PreloginResponseSchema.parse(
        await (await t.app.request('/auth/prelogin', postJson({ username }))).json(),
      ).kdfSalt;
    expect(await ask('ghost')).toBe(await ask('ghost'));
    expect(await ask('ghost')).not.toBe(await ask('ghost2'));
  });

  it('bases fake salts on the server secret, so outsiders cannot compute them', async () => {
    const other = await createTestApp(new Uint8Array(32).fill(7));
    const ask = async (app: TestApp) =>
      PreloginResponseSchema.parse(
        await (await app.app.request('/auth/prelogin', postJson({ username: 'ghost' }))).json(),
      ).kdfSalt;
    expect(await ask(t)).not.toBe(await ask(other));
    await other.database.close();
  });

  it('rejects an invalid username with 400', async () => {
    const res = await t.app.request('/auth/prelogin', postJson({ username: 'NO' }));
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('bad_request');
  });
});

describe('POST /auth/register', () => {
  it('creates the account and returns a 90-day session at once', async () => {
    const res = await t.app.request('/auth/register', postJson(registration()));
    expect(res.status).toBe(201);
    const body = SessionResponseSchema.parse(await res.json());
    const lifetime = new Date(body.expiresAt).getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(SESSION_LIFETIME_MS - 60_000);
    expect(lifetime).toBeLessThanOrEqual(SESSION_LIFETIME_MS);
  });

  it('stores only a keyed hash of the auth key and of the session token', async () => {
    const token = await register();
    const { rows: users } = await t.database.client.query<{ auth_hash: string }>(
      'select auth_hash from users',
    );
    expect(users[0]?.auth_hash).toMatch(/^hmac-sha256-v1\$[0-9a-f]{64}$/);
    expect(users[0]?.auth_hash).not.toContain(Buffer.from(authKey, 'base64').toString('hex'));
    const { rows: sessions } = await t.database.client.query<{ token_hash: string }>(
      'select token_hash from sessions',
    );
    expect(sessions[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sessions[0]?.token_hash).not.toContain(token);
  });

  it('refuses a taken username with 409 username_taken', async () => {
    await register();
    const res = await t.app.request('/auth/register', postJson(registration()));
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('username_taken');
  });

  it.each([
    ['a missing field', { ...registration(), authKey: undefined }],
    ['an unknown field', { ...registration(), isAdmin: true }],
    ['a salt of the wrong length', { ...registration(), kdfSalt: b64(bytes(8, 1)) }],
    ['KDF settings below the minimum', { ...registration(), kdfParams: { ...realKdf, passes: 1 } }],
  ])('rejects %s with 400', async (_, body) => {
    const res = await t.app.request('/auth/register', postJson(body));
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('bad_request');
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await t.app.request('/auth/register', {
      method: 'POST',
      body: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('bad_request');
  });

  it('refuses a body over 16 KB with 413 before reading it', async () => {
    const res = await t.app.request(
      '/auth/register',
      postJson({ ...registration(), deviceName: 'x'.repeat(20_000) }),
    );
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe('payload_too_large');
  });
});

describe('POST /auth/login', () => {
  it('returns a new session and the locked data key', async () => {
    await register();
    const res = await t.app.request(
      '/auth/login',
      postJson({ username: 'ahmed', authKey, deviceName: 'desktop' }),
    );
    expect(res.status).toBe(200);
    const body = LoginResponseSchema.parse(await res.json());
    expect(body.wrappedDataKey).toBe(b64(bytes(72, 5)));
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    await register();
    const wrongKey = await t.app.request(
      '/auth/login',
      postJson({ username: 'ahmed', authKey: b64(bytes(32, 2)), deviceName: 'pc' }),
    );
    const unknownUser = await t.app.request(
      '/auth/login',
      postJson({ username: 'ghost', authKey, deviceName: 'pc' }),
    );
    expect(wrongKey.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(await wrongKey.json()).toEqual(await unknownUser.json());
  });
});

describe('sessions', () => {
  const logout = (headers: Record<string, string>) =>
    t.app.request('/auth/logout', { method: 'POST', headers });

  it('logout ends the session, and the token stops working', async () => {
    const token = await register();
    expect((await logout(bearer(token))).status).toBe(204);
    const again = await logout(bearer(token));
    expect(again.status).toBe(401);
    expect(await errorCode(again)).toBe('unauthorized');
  });

  it.each([
    ['no header', {}],
    ['a different scheme', { authorization: `Basic ${'A'.repeat(43)}` }],
    ['a malformed token', { authorization: 'Bearer short' }],
    ['a well-formed but unknown token', bearer('A'.repeat(43))],
    ['extra parts', { authorization: `Bearer ${'A'.repeat(43)} extra` }],
  ])('rejects %s with the same 401', async (_, headers) => {
    const res = await logout(headers);
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('unauthorized');
  });

  it('ends a session after its 90 days, however much it is used', async () => {
    t.setNow(new Date(Date.now() - SESSION_LIFETIME_MS - 60_000));
    const token = await register();
    t.setNow(new Date());
    expect((await logout(bearer(token))).status).toBe(401);
  });

  it('ends a session unused for over 30 days (idle timeout) and removes it', async () => {
    const token = await register();
    await t.database.client.query(`update sessions set last_used_at = now() - interval '31 days'`);
    expect((await logout(bearer(token))).status).toBe(401);
    const { rows } = await t.database.client.query('select id from sessions');
    expect(rows).toEqual([]);
  });

  it('keeps an active session alive by refreshing last_used_at (at most daily)', async () => {
    const token = await register();
    await t.database.client.query(`update sessions set last_used_at = now() - interval '2 days'`);
    expect(await t.auth.authenticate(token)).not.toBeNull();
    const { rows } = await t.database.client.query<{ idle: boolean }>(
      `select last_used_at > now() - interval '1 minute' as idle from sessions`,
    );
    expect(rows[0]?.idle).toBe(true);
  });
});
