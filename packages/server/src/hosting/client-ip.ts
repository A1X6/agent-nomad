import type { ClientIp } from '../http/rate-limit.ts';

/** An IPv4 or IPv6 address: only these characters, and a sane length. */
const IP_PATTERN = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * Render's proxy puts the real client IP first in X-Forwarded-For (T19). Verified after
 * deploy: a client-sent X-Forwarded-For must not change which rate-limit bucket is used.
 * Anything that does not look like an IP counts as unknown (one shared, stricter bucket).
 */
export const firstForwardedIp: ClientIp = (c) => {
  const first = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return first && IP_PATTERN.test(first) ? first : undefined;
};
