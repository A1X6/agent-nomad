import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createAgentRegistry,
  createAgentsCommand,
  createClaudeCodeAdapter,
  describeAgent,
  type AgentAdapter,
  type DetectedAgent,
} from '../src/index.ts';

const fakeAdapter = (id: string, displayName: string, found: DetectedAgent): AgentAdapter => ({
  id,
  displayName,
  detector: { detect: () => Promise.resolve(found) },
  collector: { collect: () => Promise.resolve([]) },
  restorer: {
    restore: () => Promise.resolve({ written: [], skipped: [], backups: [], warnings: [] }),
  },
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
    const lines: string[] = [];
    const command = createAgentsCommand({
      registry: () =>
        createAgentRegistry([
          fakeAdapter('claude-code', 'Claude Code', installed),
          fakeAdapter('codex', 'Codex', missing),
        ]),
      reporter: {
        info: (m) => lines.push(m),
        success: (m) => lines.push(m),
        warn: (m) => lines.push(m),
      },
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

describe('Claude Code adapter', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentnomad-adapter-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const adapter = (env: Record<string, string> = { PATH: '' }) =>
    createClaudeCodeAdapter({
      env,
      homedir: home,
      platform: process.platform,
      isClaudeRunning: () => Promise.resolve(false),
      onClaudeRunning: () => Promise.resolve('skip'),
    });

  it('is registered as claude-code / Claude Code', () => {
    expect(adapter()).toMatchObject({ id: 'claude-code', displayName: 'Claude Code' });
  });

  it('detects, collects global and project setups, and restores them', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'CLAUDE.md'), 'global rules');
    const project = join(home, 'app');
    await mkdir(project);
    await writeFile(join(project, 'CLAUDE.md'), 'project rules');

    const claude = adapter();
    expect(await claude.detector.detect()).toEqual({
      installed: true,
      baseDir: join(home, '.claude'),
      version: null,
    });
    const global = await claude.collector.collect({ kind: 'global' }, { includeMemory: false });
    const local = await claude.collector.collect(
      { kind: 'project', projectDir: project },
      { includeMemory: false },
    );
    expect(global.map((file) => file.path)).toEqual(['CLAUDE.md']);
    expect(local.map((file) => file.path)).toEqual(['CLAUDE.md']);
    expect(new TextDecoder().decode(local[0]?.content)).toBe('project rules');

    const other = join(home, 'other-app');
    const report = await claude.restorer.restore(
      { kind: 'project', projectDir: other },
      local,
      () => Promise.resolve('skip'),
    );
    expect(report.written).toEqual(['CLAUDE.md']);
  });

  it('uses CLAUDE_CONFIG_DIR for every part', async () => {
    const custom = join(home, 'work-claude');
    await mkdir(custom);
    await writeFile(join(custom, 'CLAUDE.md'), 'custom');
    const claude = adapter({ PATH: '', CLAUDE_CONFIG_DIR: custom });
    expect((await claude.detector.detect()).baseDir).toBe(custom);
    const files = await claude.collector.collect({ kind: 'global' }, { includeMemory: false });
    expect(new TextDecoder().decode(files[0]?.content)).toBe('custom');
  });
});
