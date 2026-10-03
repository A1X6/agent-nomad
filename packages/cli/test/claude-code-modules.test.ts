import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_JSON_BUNDLE_PATH,
  CLAUDE_JSON_QUESTION,
  commandsInSettings,
  createClaudeJsonMerge,
  programOf,
  type CollectedFile,
  type MutableReport,
} from '../src/index.ts';

const source = (name: string) =>
  readFile(new URL(`../src/agents/claude-code/${name}`, import.meta.url), 'utf8');
const imports = (text: string) =>
  [...text.matchAll(/^import [^;]*? from '([^']+)';$/gms)].map((match) => match[1]);

describe('settings parsing is its own module, with no file access (SOLID-05)', () => {
  it('settings-commands.ts imports nothing from Node or the file walker', async () => {
    const used = imports(await source('settings-commands.ts'));
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((from) => from?.startsWith('node:'))).toEqual([]);
    expect(used).not.toContain('./file-gathering.ts');
  });

  it('the pure rule modules no longer import the file walker', async () => {
    for (const name of ['restore-rules.ts', 'command-review.ts', 'auto-memory.ts']) {
      expect(imports(await source(name))).not.toContain('./file-gathering.ts');
    }
  });

  it('still reads hooks, the status line and programs', () => {
    const settings = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ command: 'bash ~/.claude/hooks/done.sh' }] }] },
      statusLine: { command: 'npx -y ccstatusline@latest' },
    });
    expect(commandsInSettings(settings)).toEqual([
      'bash ~/.claude/hooks/done.sh',
      'npx -y ccstatusline@latest',
    ]);
    expect(programOf('npx -y ccstatusline@latest')).toEqual({
      name: 'ccstatusline',
      runner: true,
    });
  });
});

describe('the ~/.claude.json merge stands alone (SOLID-05)', () => {
  const pulled = (value: unknown): CollectedFile => ({
    path: CLAUDE_JSON_BUNDLE_PATH,
    content: new TextEncoder().encode(JSON.stringify(value)),
    executable: false,
  });
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
