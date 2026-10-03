import { describe, expect, it } from 'vitest';

import { collectedJson } from './fakes.ts';
import {
  CLAUDE_JSON_BUNDLE_PATH,
  CLAUDE_JSON_QUESTION,
  createClaudeJsonMerge,
  type MutableReport,
} from '../src/index.ts';

describe('the ~/.claude.json merge stands alone (SOLID-05)', () => {
  const pulled = (value: unknown) => collectedJson(CLAUDE_JSON_BUNDLE_PATH, value);
  const emptyReport = (): MutableReport => ({
    written: [],
    skipped: [],
    backups: [],
    warnings: [],
  });

  function merge(options: { existing: Uint8Array | null; running: boolean }) {
    const writes: { path: string; text: string; mode: number | null }[] = [];
    const merger = createClaudeJsonMerge({
      claudeJsonFile: '/home/a/.claude.json',
      isClaudeRunning: () => Promise.resolve(options.running),
      readExisting: () => Promise.resolve(options.existing),
      writeAtomically: (path, content, mode) => {
        writes.push({ path, text: new TextDecoder().decode(content), mode });
        return Promise.resolve();
      },
      freeSuffix: () => Promise.resolve(''),
    });
    return { merger, writes };
  }

  it('creates a missing file with only the restored keys, private to the user', async () => {
    const { merger, writes } = merge({ existing: null, running: false });
    const file = pulled({ mcpServers: { docs: { command: 'docs-mcp' } }, oauthAccount: 'x' });
    expect(await merger.change(file)).toBe('new');

    const report = emptyReport();
    await merger.merge(file, () => Promise.resolve('merge'), report, false);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.mode).toBe(0o600);
    expect(JSON.parse(writes[0]?.text ?? '')).toEqual({
      mcpServers: { docs: { command: 'docs-mcp' } },
    });
    expect(report.written).toEqual([CLAUDE_JSON_BUNDLE_PATH]);
    expect(report.warnings[0]).toContain('"oauthAccount"');
  });

  it('never writes while Claude Code runs, or when the plan chose to leave it', async () => {
    for (const [running, leave] of [
      [true, false],
      [false, true],
    ] as const) {
      const { merger, writes } = merge({ existing: null, running });
      const report = emptyReport();
      await merger.merge(pulled({ mcpServers: {} }), () => Promise.resolve('merge'), report, leave);
      expect(writes).toEqual([]);
      expect(report.skipped).toEqual([CLAUDE_JSON_BUNDLE_PATH]);
    }
  });

  it('asks its own question for an existing file, and a skip leaves it alone', async () => {
    const existing = new TextEncoder().encode(JSON.stringify({ mcpServers: { old: {} } }));
    const { merger, writes } = merge({ existing, running: false });
    const file = pulled({ mcpServers: { docs: {} } });
    expect(await merger.change(file)).toBe('merge');

    const asked: unknown[] = [];
    const report = emptyReport();
    await merger.merge(
      file,
      (path, question) => {
        asked.push([path, question]);
        return Promise.resolve('skip');
      },
      report,
      false,
    );
    expect(asked).toEqual([[CLAUDE_JSON_BUNDLE_PATH, CLAUDE_JSON_QUESTION]]);
    expect(writes).toEqual([]);
    expect(report.skipped).toEqual([CLAUDE_JSON_BUNDLE_PATH]);
  });
});
