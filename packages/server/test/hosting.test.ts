import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { firstForwardedIp } from '../src/hosting/client-ip.ts';
import { readPort } from '../src/port.ts';

async function ipFor(headers: Record<string, string>): Promise<string | undefined> {
  let seen: string | undefined = 'not called';
  const app = new Hono().get('/', (c) => {
    seen = firstForwardedIp(c);
    return c.body(null, 204);
  });
  await app.request('/', { headers });
  return seen;
}

describe('firstForwardedIp (Render)', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['203.0.113.7, 10.0.0.1, 10.0.0.2', '203.0.113.7'],
    ['2001:db8::1, 10.0.0.1', '2001:db8::1'],
  ])('reads the first address of %j', async (header, expected) => {
    expect(await ipFor({ 'x-forwarded-for': header })).toBe(expected);
  });

  it.each([
    ['no header', {}],
    ['an empty header', { 'x-forwarded-for': '' }],
    ['something that is not an IP', { 'x-forwarded-for': 'evil"}; drop table' }],
    ['a far too long value', { 'x-forwarded-for': '1'.repeat(100) }],
  ])('treats %s as unknown', async (_, headers) => {
    expect(await ipFor(headers)).toBeUndefined();
  });
});

describe('readPort', () => {
  it('uses Render’s PORT, or 10000 when it is not set', () => {
    expect(readPort({ PORT: '8080' })).toBe(8080);
    expect(readPort({})).toBe(10_000);
  });

  it.each(['abc', '0', '70000', '80.5'])('refuses PORT=%j', (PORT) => {
    expect(() => readPort({ PORT })).toThrow(/PORT/);
  });
});
