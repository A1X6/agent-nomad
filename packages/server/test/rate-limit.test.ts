import { describe, expect, it } from 'vitest';

import { rateLimitSubject } from '../src/http/rate-limit.ts';

describe('rateLimitSubject: who a per-IP limit counts (T47)', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:0:1::1', '2001:db8:0:1::/64'],
    ['2001:db8:0:1:ffff:ffff:ffff:ffff', '2001:db8:0:1::/64'],
    ['2001:0db8:0000:0001:0:0:0:9', '2001:db8:0:1::/64'],
    ['::1', '0:0:0:0::/64'],
  ])('%s → %s', (ip, subject) => {
    expect(rateLimitSubject(ip)).toBe(subject);
  });
});
