import { describe, expect, it } from 'vitest';

import {
  API_HEADERS,
  API_ROUTES,
  AUTH_KEY_BYTES,
  BundleParamsSchema,
  DeleteAccountRequestSchema,
  ErrorResponseSchema,
  GetBundleResponseHeadersSchema,
  KDF_SALT_BYTES,
  KdfParamsSchema,
  ListBundlesQuerySchema,
  ListBundlesResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  MAX_BUNDLE_BYTES,
  PreloginRequestSchema,
  PreloginResponseSchema,
  PutBundleRequestHeadersSchema,
  PutBundleResponseSchema,
  RegisterRequestSchema,
  SessionResponseSchema,
  WRAPPED_DATA_KEY_BYTES,
} from '../src/index.ts';

/** Canonical base64 for `n` zero bytes (content is irrelevant, only the decoded length matters). */
function b64(n: number): string {
  const full = 'AAAA'.repeat(Math.floor(n / 3));
  const rest = ['', 'AA==', 'AAA='][n % 3] ?? '';
  return full + rest;
}

const sha256 = 'a'.repeat(64);
const token = 'A'.repeat(43);
const kdfParams = {
  algorithm: 'argon2id',
  version: 19,
  memoryKiB: 65536,
  passes: 3,
  parallelism: 1,
};

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe('shared sizes', () => {
  it('match the crypto design (T08)', () => {
    expect(KDF_SALT_BYTES).toBe(16);
    expect(AUTH_KEY_BYTES).toBe(32);
    // XChaCha20-Poly1305: 24-byte nonce + 32-byte key + 16-byte tag.
    expect(WRAPPED_DATA_KEY_BYTES).toBe(72);
    expect(MAX_BUNDLE_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe('routes and headers', () => {
  it('builds bundle paths', () => {
    expect(API_ROUTES.bundle('claude-code', 'global')).toBe('/bundles/claude-code/global');
  });

  it('uses lowercase header names (fetch and Hono normalise to lowercase)', () => {
    for (const name of Object.values(API_HEADERS)) expect(name).toBe(name.toLowerCase());
  });
});

describe('KdfParamsSchema', () => {
  it('accepts the default parameters', () => {
    expect(ok(KdfParamsSchema, kdfParams)).toBe(true);
  });

  // Upper bounds protect the CLI from a malicious server asking for huge memory at prelogin.
  it.each([
    { memoryKiB: 8192 },
    { memoryKiB: 2 * 1024 * 1024 },
    { passes: 0 },
    { passes: 1 },
    { passes: 11 },
    { parallelism: 4 },
    { algorithm: 'argon2i' },
    { version: 16 },
  ])('rejects %j', (change) => {
    expect(ok(KdfParamsSchema, { ...kdfParams, ...change })).toBe(false);
  });
});

describe('auth', () => {
  it('prelogin: username in, salt and params out', () => {
    expect(ok(PreloginRequestSchema, { username: 'ahmed' })).toBe(true);
    expect(ok(PreloginResponseSchema, { kdfSalt: b64(16), kdfParams })).toBe(true);
    expect(ok(PreloginResponseSchema, { kdfSalt: b64(15), kdfParams })).toBe(false);
  });

  it.each(['ahmed', 'a1x6', 'dev.team_1', 'abc'])('accepts username %j', (username) => {
    expect(ok(PreloginRequestSchema, { username })).toBe(true);
  });

  it.each(['', 'ab', 'Ahmed', 'has space', '-lead', 'a'.repeat(33), 'émile'])(
    'rejects username %j',
    (username) => {
      expect(ok(PreloginRequestSchema, { username })).toBe(false);
    },
  );

  const register = {
    username: 'ahmed',
    kdfSalt: b64(16),
    kdfParams,
    authKey: b64(32),
    wrappedDataKey: b64(72),
    deviceName: 'Ahmed laptop',
  };

  it('register: accepts a full request', () => {
    expect(ok(RegisterRequestSchema, register)).toBe(true);
  });

  it.each([
    { authKey: b64(31) },
    { wrappedDataKey: b64(40) },
    { kdfSalt: 'not base64!' },
    { deviceName: '' },
    { deviceName: 'line\nbreak' },
    { extra: 1 },
  ])('register: rejects %j', (change) => {
    expect(ok(RegisterRequestSchema, { ...register, ...change })).toBe(false);
  });

  it('login: username, auth key and device name in; session and wrapped key out', () => {
    expect(ok(LoginRequestSchema, { username: 'ahmed', authKey: b64(32), deviceName: 'pc' })).toBe(
      true,
    );
    const session = { sessionToken: token, expiresAt: '2026-10-24T13:00:00Z' };
    expect(ok(SessionResponseSchema, session)).toBe(true);
    expect(ok(LoginResponseSchema, { ...session, wrappedDataKey: b64(72) })).toBe(true);
    expect(ok(SessionResponseSchema, { ...session, sessionToken: 'short' })).toBe(false);
    expect(ok(SessionResponseSchema, { ...session, expiresAt: 'tomorrow' })).toBe(false);
  });

  it('account delete requires the auth key, not just a session', () => {
    expect(ok(DeleteAccountRequestSchema, { authKey: b64(32) })).toBe(true);
    expect(ok(DeleteAccountRequestSchema, {})).toBe(false);
  });
});

describe('bundles', () => {
  it.each([
    { agent: 'claude-code', scopeKey: 'global' },
    { agent: 'claude-code', scopeKey: sha256 },
  ])('accepts path params %j', (params) => {
    expect(ok(BundleParamsSchema, params)).toBe(true);
  });

  it.each([
    { agent: 'Claude', scopeKey: 'global' },
    { agent: 'claude-code', scopeKey: 'my-project' },
    { agent: 'claude-code', scopeKey: 'A'.repeat(64) },
  ])('rejects path params %j', (params) => {
    expect(ok(BundleParamsSchema, params)).toBe(false);
  });

  it('list query: parses strings from the URL and defaults the limit', () => {
    expect(ListBundlesQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(ListBundlesQuerySchema.parse({ limit: '10', cursor: 'abc_-1' })).toEqual({
      limit: 10,
      cursor: 'abc_-1',
    });
    expect(ok(ListBundlesQuerySchema, { limit: '0' })).toBe(false);
    expect(ok(ListBundlesQuerySchema, { limit: '101' })).toBe(false);
    expect(ok(ListBundlesQuerySchema, { limit: '5.5' })).toBe(false);
    expect(ok(ListBundlesQuerySchema, { cursor: 'has space' })).toBe(false);
  });

  it('list response: metadata only, never ciphertext', () => {
    const item = {
      agent: 'claude-code',
      scopeKey: sha256,
      nameEnc: b64(60),
      revision: 3,
      formatVersion: 1,
      sizeBytes: 2048,
      updatedAt: '2026-09-24T13:00:00Z',
    };
    expect(ok(ListBundlesResponseSchema, { items: [item], nextCursor: null })).toBe(true);
    expect(
      ok(ListBundlesResponseSchema, { items: [{ ...item, ciphertext: 'x' }], nextCursor: null }),
    ).toBe(false);
    expect(
      ok(ListBundlesResponseSchema, {
        items: [{ ...item, scopeKey: 'global', nameEnc: null }],
        nextCursor: 'c1',
      }),
    ).toBe(true);
  });

  describe('PUT headers', () => {
    const headers = {
      [API_HEADERS.expectedRevision]: '0',
      [API_HEADERS.contentSha256]: sha256,
      [API_HEADERS.formatVersion]: '1',
    };

    it('parses header strings into typed values', () => {
      expect(PutBundleRequestHeadersSchema.parse(headers)).toEqual({
        [API_HEADERS.expectedRevision]: 0,
        [API_HEADERS.contentSha256]: sha256,
        [API_HEADERS.formatVersion]: 1,
      });
    });

    it('accepts an encrypted project name', () => {
      expect(
        ok(PutBundleRequestHeadersSchema, { ...headers, [API_HEADERS.nameEnc]: b64(60) }),
      ).toBe(true);
    });

    it('ignores unrelated headers such as content-type', () => {
      expect(
        ok(PutBundleRequestHeadersSchema, {
          ...headers,
          'content-type': 'application/octet-stream',
        }),
      ).toBe(true);
    });

    it.each([
      { [API_HEADERS.expectedRevision]: '-1' },
      { [API_HEADERS.expectedRevision]: '01' },
      { [API_HEADERS.expectedRevision]: '1e3' },
      { [API_HEADERS.contentSha256]: 'A'.repeat(64) },
      { [API_HEADERS.contentSha256]: 'a'.repeat(63) },
      { [API_HEADERS.formatVersion]: '0' },
      { [API_HEADERS.nameEnc]: 'not base64!' },
    ])('rejects %j', (change) => {
      expect(ok(PutBundleRequestHeadersSchema, { ...headers, ...change })).toBe(false);
    });

    it('requires the expected revision and content hash', () => {
      expect(ok(PutBundleRequestHeadersSchema, { [API_HEADERS.formatVersion]: '1' })).toBe(false);
    });
  });

  it('GET response headers describe the downloaded bytes', () => {
    expect(
      GetBundleResponseHeadersSchema.parse({
        [API_HEADERS.revision]: '7',
        [API_HEADERS.contentSha256]: sha256,
        [API_HEADERS.formatVersion]: '1',
      }),
    ).toEqual({
      [API_HEADERS.revision]: 7,
      [API_HEADERS.contentSha256]: sha256,
      [API_HEADERS.formatVersion]: 1,
    });
  });

  it('PUT response returns the new revision', () => {
    expect(ok(PutBundleResponseSchema, { revision: 1, updatedAt: '2026-09-24T13:00:00Z' })).toBe(
      true,
    );
    expect(ok(PutBundleResponseSchema, { revision: 0, updatedAt: '2026-09-24T13:00:00Z' })).toBe(
      false,
    );
  });
});

describe('ErrorResponseSchema', () => {
  it('has a machine-readable code and a message', () => {
    expect(
      ok(ErrorResponseSchema, { error: { code: 'unauthorized', message: 'Log in again' } }),
    ).toBe(true);
  });

  it('tells the CLI the current revision on a conflict', () => {
    const conflict = {
      error: { code: 'revision_conflict', message: 'Newer copy exists', currentRevision: 4 },
    };
    expect(ok(ErrorResponseSchema, conflict)).toBe(true);
  });

  it('rejects unknown codes', () => {
    expect(ok(ErrorResponseSchema, { error: { code: 'teapot', message: '' } })).toBe(false);
  });
});
