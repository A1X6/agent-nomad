import { describe, expect, it } from 'vitest';

import { setupLabel } from '../src/index.ts';

describe('setup labels in messages (DUP-05)', () => {
  it('names the global setup or the project, after the agent when given', () => {
    expect(setupLabel('Claude Code', null)).toBe('Claude Code global setup');
    expect(setupLabel('Claude Code', 'my-app')).toBe('Claude Code project "my-app"');
    expect(setupLabel(null, null)).toBe('global setup');
    expect(setupLabel(null, 'my-app')).toBe('project "my-app"');
  });
});
