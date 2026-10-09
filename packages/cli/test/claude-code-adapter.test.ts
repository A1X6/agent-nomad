import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collected,
  paths,
  readJson,
  readText,
  recordingReporter,
  scriptedPrompter,
  useTempDir,
  writeTestFile,
} from './fakes.ts';
import { fakeManagedSystem, probeMod } from './claude-code-plugin-fixtures.ts';
import { claudeCodeAdapter } from './claude-code-project-fixtures.ts';
import {
  AnswerNeededError,
  CLAUDE_JSON_BUNDLE_PATH,
  createNoTerminalPrompter,
  type ConflictChoice,
  type Prompter,
  type RestorePlanContext,
} from '../src/index.ts';

/** The Claude Code adapter's own steps; its parts have their own test files. */

let home: string;
useTempDir('agentnomad-adapter-plan-', (dir) => (home = dir));

/** Answers every conflict question the same way. */
const answer = (choice: ConflictChoice) => () => Promise.resolve(choice);

describe('Claude Code plan step: closing Claude Code before ~/.claude.json changes (T61)', () => {
  const incoming = collected(CLAUDE_JSON_BUNDLE_PATH, '{"diffTool":"terminal"}');
  // Not the fixtures' `noManagedSettings` (a parsed result): this is the PC to read (review 16 READ-07).
  const unmanagedPc = fakeManagedSystem({ platform: 'linux' });
  const QUESTION =
    'Claude Code (or the Claude app) is running and rewrites ~/.claude.json while open.';

  function planStep(running: boolean[], answers: string[], prompter?: Prompter) {
    const script = scriptedPrompter(answers);
    const { reporter } = recordingReporter({ levels: false });
    const adapter = claudeCodeAdapter(home, {
      isClaudeRunning: () => Promise.resolve(running.shift() ?? false),
      managedSystem: unmanagedPc,
    });
    const plan = (overrides: Partial<RestorePlanContext> = {}) => {
      if (!adapter.planRestore) throw new Error('no plan step');
      return adapter.planRestore({
        target: { kind: 'global' },
        files: [incoming],
        conflicts: new Map([[CLAUDE_JSON_BUNDLE_PATH, 'merge']]),
        conflictAnswer: undefined,
        prompter: prompter ?? script.prompter,
        reporter,
        assumeYes: false,
        allowCommands: false,
        parts: new Map(),
        ...overrides,
      });
    };
    return { plan, asked: script.asked };
  }

  it('"I closed it, continue" checks again, then the restore merges it', async () => {
    await writeTestFile(join(home, '.claude.json'), '{}');
    const t = planStep([true, true, false, false], ['retry', 'retry']);
    const planned = await t.plan();
    expect(t.asked).toEqual([QUESTION, QUESTION]);
    const report = await planned.restore(answer('merge'), {});
    expect(report.written).toEqual(['.agentnomad/claude.json']);
    expect((await readJson(join(home, '.claude.json')))['diffTool']).toBe('terminal');
  });

  it('"Skip" leaves it as it is with the warning, and nothing is asked while writing', async () => {
    await writeTestFile(join(home, '.claude.json'), '{}');
    const t = planStep([true], ['skip']);
    const planned = await t.plan();
    expect(t.asked).toEqual([QUESTION]);
    const report = await planned.restore(answer('merge'), {});
    expect(await readText(join(home, '.claude.json'))).toBe('{}');
    expect(report.warnings[0]).toContain('Claude Code or the Claude app was running');
    expect(t.asked).toHaveLength(1);
  });

  it('--yes never asks: the file is left with the warning while Claude Code runs', async () => {
    await writeTestFile(join(home, '.claude.json'), '{}');
    const t = planStep([true, true], []);
    const planned = await t.plan({ assumeYes: true });
    expect(t.asked).toEqual([]);
    const report = await planned.restore(answer('merge'), {});
    expect(await readText(join(home, '.claude.json'))).toBe('{}');
    expect(report.warnings[0]).toContain('Claude Code or the Claude app was running');
  });

  it('is not asked when the file would not change', async () => {
    await writeTestFile(join(home, '.claude.json'), '{"diffTool":"terminal"}');
    const t = planStep([true], []);
    await t.plan();
    expect(t.asked).toEqual([]);
  });

  it('is not asked when the merge was declined', async () => {
    await writeTestFile(join(home, '.claude.json'), '{}');
    const declined = planStep([true], []);
    await declined.plan({ conflicts: new Map([[CLAUDE_JSON_BUNDLE_PATH, 'skip']]) });
    expect(declined.asked).toEqual([]);
  });

  it('without a terminal, the open question stops the plan', async () => {
    await writeTestFile(join(home, '.claude.json'), '{}');
    const t = planStep([true], [], createNoTerminalPrompter());
    await expect(t.plan()).rejects.toBeInstanceOf(AnswerNeededError);
    expect(await readText(join(home, '.claude.json'))).toBe('{}');
  });
});

describe('Claude Code adapter', () => {
  const adapter = (env: Record<string, string> = { PATH: '' }) => claudeCodeAdapter(home, { env });

  it('is registered as claude-code / Claude Code', () => {
    expect(adapter()).toMatchObject({ id: 'claude-code', displayName: 'Claude Code' });
  });

  it('detects Claude Code from its folder', async () => {
    await writeTestFile(join(home, '.claude', 'CLAUDE.md'), 'global rules');
    expect(await adapter().detector.detect()).toEqual({
      installed: true,
      baseDir: join(home, '.claude'),
      version: null,
    });
  });

  it('collects the global and a project setup', async () => {
    await writeTestFile(join(home, '.claude', 'CLAUDE.md'), 'global rules');
    const project = join(home, 'app');
    await writeTestFile(join(project, 'CLAUDE.md'), 'project rules');
    const claude = adapter();
    const global = await claude.collector.collect({ kind: 'global' }, { includeMemory: false });
    const local = await claude.collector.collect(
      { kind: 'project', projectDir: project },
      { includeMemory: false },
    );
    expect(paths(global)).toEqual(['CLAUDE.md']);
    expect(paths(local)).toEqual(['CLAUDE.md']);
    expect(new TextDecoder().decode(local[0]?.content)).toBe('project rules');
  });

  it('restores a project setup into another folder', async () => {
    const other = join(home, 'other-app');
    const report = await adapter().restorer.restore(
      { kind: 'project', projectDir: other },
      [collected('CLAUDE.md', 'project rules')],
      () => Promise.resolve('skip'),
    );
    expect(report.written).toEqual(['CLAUDE.md']);
    expect(await readText(join(other, 'CLAUDE.md'))).toBe('project rules');
  });

  it('tells push about the plugins in a collected skills folder (T96)', () => {
    const notes = adapter().inspector?.describeCollected?.({ kind: 'global' }, probeMod()) ?? [];
    expect(notes).toEqual([
      'Plugins in the skills folder, saved with it: my-mod (skills/my-mod/, a mod: runs code inside Claude Code). They load as <name>@skills-dir on the other PC, after pull shows what they run.',
    ]);
    expect(adapter().inspector?.describeCollected?.({ kind: 'global' }, [])).toEqual([]);
  });

  it('uses CLAUDE_CONFIG_DIR for every part', async () => {
    const custom = join(home, 'work-claude');
    await writeTestFile(join(custom, 'CLAUDE.md'), 'custom');
    const claude = adapter({ PATH: '', CLAUDE_CONFIG_DIR: custom });
    expect((await claude.detector.detect()).baseDir).toBe(custom);
    const files = await claude.collector.collect({ kind: 'global' }, { includeMemory: false });
    expect(new TextDecoder().decode(files[0]?.content)).toBe('custom');
  });
});
