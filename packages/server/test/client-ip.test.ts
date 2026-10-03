import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { renderClientIp } from '../src/hosting/client-ip.ts';

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
  it('reads CF-Connecting-IP first, which Cloudflare sets on every request (T47)', async () => {
    expect(await ipFor({ 'cf-connecting-ip': '203.0.113.8' })).toBe('203.0.113.8');
    expect(
      await ipFor({ 'cf-connecting-ip': '203.0.113.8', 'true-client-ip': '198.51.100.66' }),
    ).toBe('203.0.113.8');
  });

  it('falls back to True-Client-IP', async () => {
    expect(await ipFor({ 'true-client-ip': '203.0.113.7' })).toBe('203.0.113.7');
    expect(await ipFor({ 'true-client-ip': '2001:db8::1' })).toBe('2001:db8::1');
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
