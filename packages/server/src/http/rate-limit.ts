import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';

import {
  RateLimitedError,
  type RateLimiter,
  type RateLimitRule,
} from '../rate-limit/rate-limiter.ts';

/**
 * Reads the visitor's IP. Host-specific (each host passes it in its own proxy header), so
 * it is chosen where the server is wired up (T19). `undefined` when it cannot be known.
 */
export type ClientIp = (c: Context) => string | undefined;

/** Refuses the request with 429 once this IP has used up the rule's limit. */
export function limitPerIp(limiter: RateLimiter, rule: RateLimitRule, clientIp: ClientIp) {
  return createMiddleware(async (c, next) => {
    // Visitors whose IP cannot be read share one bucket: stricter, never looser.
    const status = await limiter.hit(rule, clientIp(c) ?? 'unknown');
    if (!status.allowed) throw new RateLimitedError(status.retryAfterSeconds);
    await next();
  });
}
