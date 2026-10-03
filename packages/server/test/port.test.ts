import { describe, expect, it } from 'vitest';

import { readPort } from '../src/port.ts';

describe('readPort', () => {
  it('uses Render’s PORT, or 10000 when it is not set', () => {
    expect(readPort({ PORT: '8080' })).toBe(8080);
    expect(readPort({})).toBe(10_000);
  });

  it.each(['abc', '0', '70000', '80.5'])('refuses PORT=%j', (PORT) => {
    expect(() => readPort({ PORT })).toThrow(/PORT/);
  });
});
