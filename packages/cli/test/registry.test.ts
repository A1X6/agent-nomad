import { describe, expect, it } from 'vitest';

import { fakeAdapter, installedAgent, missingAgent } from './fakes.ts';
import { createAgentRegistry } from '../src/index.ts';

describe('agent registry', () => {
  it('lists adapters in order and finds one by id', () => {
    const claude = fakeAdapter('claude-code', 'Claude Code', installedAgent);
    const codex = fakeAdapter('codex', 'Codex', missingAgent);
    const registry = createAgentRegistry([claude, codex]);
    expect(registry.list().map((adapter) => adapter.id)).toEqual(['claude-code', 'codex']);
    expect(registry.get('codex')).toBe(codex);
    expect(registry.get('cursor')).toBeUndefined();
  });

  it('refuses the same agent twice', () => {
    const claude = fakeAdapter('claude-code', 'Claude Code', installedAgent);
    expect(() => createAgentRegistry([claude, claude])).toThrow('registered twice');
  });
});
