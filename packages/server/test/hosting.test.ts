import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { renderClientIp } from '../src/hosting/client-ip.ts';
import { readPort } from '../src/port.ts';

async function ipFor(headers: Record<string, string>): Promise<string | undefined> {
  let seen: string | undefined = 'not called';
  const app = new Hono().get('/', (c) => {
    seen = renderClientIp(c);
    return c.body(null, 204);
  });
  await app.request('/', { headers });
  return seen;
}

describe('renderClientIp', () => {
  it('reads the address Cloudflare sets in True-Client-IP', async () => {
    expect(await ipFor({ 'true-client-ip': '203.0.113.7' })).toBe('203.0.113.7');
    expect(await ipFor({ 'true-client-ip': '2001:db8::1' })).toBe('2001:db8::1');
  });

  it('falls back to CF-Connecting-IP', async () => {
    expect(await ipFor({ 'cf-connecting-ip': '203.0.113.8' })).toBe('203.0.113.8');
  });

  it('never trusts X-Forwarded-For, which clients can fake on Render', async () => {
    expect(await ipFor({ 'x-forwarded-for': '198.51.100.1' })).toBeUndefined();
    expect(
      await ipFor({ 'x-forwarded-for': '198.51.100.1', 'true-client-ip': '203.0.113.7' }),
    ).toBe('203.0.113.7');
  });

  it.each([
    ['no header', {}],
    ['an empty header', { 'true-client-ip': '' }],
    ['something that is not an IP', { 'true-client-ip': 'evil"}; drop table' }],
    ['a far too long value', { 'true-client-ip': '1'.repeat(100) }],
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
