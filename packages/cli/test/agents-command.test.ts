import { describe, expect, it } from 'vitest';

import { fakeAdapter, installedAgent, missingAgent, recordingReporter } from './fakes.ts';
import { createAgentRegistry, createAgentsCommand, describeAgent } from '../src/index.ts';

describe('agentnomad agents', () => {
  it('shows each agent with its version and folder, and a count', async () => {
    const { reporter, lines } = recordingReporter({ levels: false });
    const command = createAgentsCommand({
      registry: () =>
        createAgentRegistry([
          fakeAdapter('claude-code', 'Claude Code', installedAgent),
          fakeAdapter('codex', 'Codex', missingAgent),
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
    expect(describeAgent('Claude Code', { ...installedAgent, version: null })).toBe(
      '✓ Claude Code  version unknown  /home/a/.claude',
    );
  });
});
