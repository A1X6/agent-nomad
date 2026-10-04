import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.ts';
import {
  b64,
  bearer,
  bytes,
  deleteAccountRequest,
  errorCode,
  loginRequest,
  putSetup,
  registerForToken,
} from './support/fixtures.ts';

/** Each test user has its own auth key (derived from their password in real life). */
const authKeyOf = (username: string) => b64(bytes(32, username.length));

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
});

afterEach(async () => {
  await t.database.close();
});

const register = (username: string) =>
  registerForToken(t.app, username, { authKey: authKeyOf(username) });

const login = (username: string) =>
  loginRequest(t.app, username, authKeyOf(username), { deviceName: 'desktop' });

async function pushGlobal(token: string): Promise<void> {
  const res = await putSetup(t.app, token, { expected: 0, body: bytes(64, 7) });
  expect(res.status).toBe(200);
}

const deleteAccount = (token: string | null, body: unknown) =>
  deleteAccountRequest(t.app, token, body);

/** Rows per table that belong to `username`. */
async function rowsOf(username: string) {
  const { rows } = await t.database.client.query<Record<string, number>>(
    `select
       (select count(*) from users where username = $1)::int as users,
       (select count(*) from sessions s join users u on u.id = s.user_id where u.username = $1)::int as sessions,
       (select count(*) from bundles b join users u on u.id = b.user_id where u.username = $1)::int as bundles,
       (select count(*) from bundle_blobs f join users u on u.id = f.user_id where u.username = $1)::int as files`,
    [username],
  );
  return rows[0];
}

describe('DELETE /account', () => {
  it('removes the user and every row they own, on all devices', async () => {
    const token = await register('ahmed');
    await login('ahmed'); // a second device
    await pushGlobal(token);
    expect(await rowsOf('ahmed')).toEqual({ users: 1, sessions: 2, bundles: 1, files: 1 });

    const res = await deleteAccount(token, { authKey: authKeyOf('ahmed') });
    expect(res.status).toBe(204);

    const { rows } = await t.database.client.query<{ n: number }>(
      `select (select count(*) from users)::int + (select count(*) from sessions)::int
            + (select count(*) from bundles)::int + (select count(*) from bundle_blobs)::int as n`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('ends every session and lets the username be registered fresh', async () => {
    const token = await register('ahmed');
    await deleteAccount(token, { authKey: authKeyOf('ahmed') });

    const reuse = await t.app.request('/bundles', {
      headers: bearer(token),
    });
    expect(reuse.status).toBe(401);
    expect((await login('ahmed')).status).toBe(401);
    await register('ahmed');
    expect(await rowsOf('ahmed')).toMatchObject({ users: 1, bundles: 0 });
  });

  it('refuses a stolen session token without the auth key, deleting nothing', async () => {
    const token = await register('ahmed');
    await pushGlobal(token);
    const res = await deleteAccount(token, { authKey: b64(bytes(32, 99)) });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('unauthorized');
    expect(await rowsOf('ahmed')).toEqual({ users: 1, sessions: 1, bundles: 1, files: 1 });
  });

  it("cannot delete someone else's account, even with their auth key", async () => {
    await register('owner');
    const intruder = await register('intruder');
    const res = await deleteAccount(intruder, { authKey: authKeyOf('owner') });
    expect(res.status).toBe(401);
    expect(await rowsOf('owner')).toMatchObject({ users: 1 });
    expect(await rowsOf('intruder')).toMatchObject({ users: 1 });
  });

  it('leaves other users untouched', async () => {
    const token = await register('ahmed');
    const other = await register('other');
    await pushGlobal(other);
    await deleteAccount(token, { authKey: authKeyOf('ahmed') });
    expect(await rowsOf('other')).toEqual({ users: 1, sessions: 1, bundles: 1, files: 1 });
  });

  it('needs a session', async () => {
    const res = await deleteAccount(null, { authKey: authKeyOf('ahmed') });
    expect(res.status).toBe(401);
  });

  it.each([
    ['no body', undefined],
    ['a missing auth key', {}],
    ['an auth key of the wrong length', { authKey: b64(bytes(16, 1)) }],
    ['an unknown field', { authKey: authKeyOf('ahmed'), confirm: true }],
  ])('rejects %s with 400', async (_, body) => {
    const token = await register('ahmed');
    const res = await deleteAccount(token, body);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('bad_request');
    expect(await rowsOf('ahmed')).toMatchObject({ users: 1 });
  });
});
