import { describe, expect, it } from 'vitest';

import { recordingReporter } from './fakes.ts';
import { stubRestorer } from './stub-restorer.ts';
import {
  createAgentRegistry,
  createAgentsCommand,
  describeAgent,
  type AgentAdapter,
  type DetectedAgent,
} from '../src/index.ts';

const fakeAdapter = (id: string, displayName: string, found: DetectedAgent): AgentAdapter => ({
  id,
  displayName,
  detector: { detect: () => Promise.resolve(found) },
  collector: { collect: () => Promise.resolve([]) },
  restorer: stubRestorer(),
});

const installed: DetectedAgent = {
  installed: true,
  baseDir: '/home/a/.claude',
  version: '2.1.282',
};
const missing: DetectedAgent = { installed: false, baseDir: null, version: null };

describe('agent registry', () => {
  it('lists adapters in order and finds one by id', () => {
    const claude = fakeAdapter('claude-code', 'Claude Code', installed);
    const codex = fakeAdapter('codex', 'Codex', missing);
    const registry = createAgentRegistry([claude, codex]);
    expect(registry.list().map((adapter) => adapter.id)).toEqual(['claude-code', 'codex']);
    expect(registry.get('codex')).toBe(codex);
    expect(registry.get('cursor')).toBeUndefined();
  });

  it('refuses the same agent twice', () => {
    const claude = fakeAdapter('claude-code', 'Claude Code', installed);
    expect(() => createAgentRegistry([claude, claude])).toThrow('registered twice');
  });
});

describe('agentnomad agents', () => {
  it('shows each agent with its version and folder, and a count', async () => {
    const { reporter, lines } = recordingReporter({ levels: false });
    const command = createAgentsCommand({
      registry: () =>
        createAgentRegistry([
          fakeAdapter('claude-code', 'Claude Code', installed),
          fakeAdapter('codex', 'Codex', missing),
        ]),
      reporter,
    });
    await command.agents();
    expect(lines).toEqual([
      'Supported agents:\n  ✓ Claude Code  2.1.282  /home/a/.claude\n  ✗ Codex  not found on this PC',
      '1 of 2 supported agents found on this PC.',
    ]);
  });

  it('says when the version is unknown', () => {
    expect(describeAgent('Claude Code', { ...installed, version: null })).toBe(
      '✓ Claude Code  version unknown  /home/a/.claude',
    );
  });
});
