import { describe, expect, it } from 'vitest';

import { deviceNameOf } from '../src/index.ts';

describe('deviceNameOf', () => {
  it('device names are one short line', () => {
    expect(deviceNameOf('LAPTOP-01')).toBe('LAPTOP-01');
    expect(deviceNameOf('a\nb')).toBe('ab');
    expect(deviceNameOf('x'.repeat(100))).toHaveLength(64);
    expect(deviceNameOf('  ')).toBe('unknown device');
  });
});
