import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from '../src/index.ts';

describe('@agentnomad/server', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@agentnomad/server');
  });
});
