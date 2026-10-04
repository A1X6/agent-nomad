import { describe, expect, it } from 'vitest';

import { backoffDelay, DEFAULT_RETRY_POLICY } from '../src/index.ts';

describe('ApiClient: retries', () => {
  it('keeps each retry wait between the base and the cap', () => {
    const waits = [1, 2, 3, 4, 5].map((retry) =>
      backoffDelay(retry, DEFAULT_RETRY_POLICY, () => 0.99),
    );
    expect(waits[0]).toBeGreaterThanOrEqual(500);
    expect(Math.max(...waits)).toBe(4000);
  });
});
