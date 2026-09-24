import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from '../src/index.js';

describe('@agentnomad/cli', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@agentnomad/cli');
  });
});
