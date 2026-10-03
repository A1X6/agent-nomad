import { describe, expect, it } from 'vitest';

import { ApiError, describeError, describeWait } from '../src/index.ts';

describe('describeError', () => {
  it('rate limits say when to try again', () => {
    const limited = (seconds?: number) =>
      new ApiError(429, 'rate_limited', 'Too many requests', {
        ...(seconds !== undefined && { retryAfterSeconds: seconds }),
      });
    expect(describeError(limited(240))).toBe('Too many attempts. Try again in 4 minutes.');
    expect(describeError(limited(61))).toBe('Too many attempts. Try again in 2 minutes.');
    expect(describeError(limited(1))).toBe('Too many attempts. Try again in 1 second.');
    expect(describeError(limited())).toBe('Too many attempts. Wait a while and try again.');
    expect(describeWait(60)).toBe('1 minute');
  });
});
