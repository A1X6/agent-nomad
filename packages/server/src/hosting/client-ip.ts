import type { ClientIp } from '../http/rate-limit.ts';

/** An IPv4 or IPv6 address: only these characters, and a sane length. */
const IP_PATTERN = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * The visitor's IP on Render (T19). Cloudflare always sits in front of Render and sets
 * True-Client-IP and CF-Connecting-IP itself, overwriting anything the client sends.
 * X-Forwarded-For is NOT used: Render's proxy only appends to it, so its first entry is
 * whatever the client wrote (verified live: faking it dodged the per-IP limit).
 * Anything that does not look like an IP counts as unknown (one shared, stricter bucket).
 */
export const renderClientIp: ClientIp = (c) => {
  const ip = (c.req.header('true-client-ip') ?? c.req.header('cf-connecting-ip'))?.trim();
  return ip && IP_PATTERN.test(ip) ? ip : undefined;
};
