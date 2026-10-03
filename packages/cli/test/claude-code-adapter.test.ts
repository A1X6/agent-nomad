import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordingReporter, scriptedPrompter } from './fakes.ts';
import {
  AnswerNeededError,
  createClaudeCodeAdapter,
  createNoTerminalPrompter,
  type CollectedFile,
  type ConflictChoice,
  type ManagedSettingsSystem,
  type Prompter,
  type RestorePlanContext,
} from '../src/index.ts';

/** The Claude Code adapter's own steps; its parts have their own test files. */

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentnomad-adapter-plan-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
const read = (path: string) => readFile(path, 'utf8');
const readJson = async (path: string) => JSON.parse(await read(path)) as Record<string, unknown>;
const file = (path: string, content: string): CollectedFile => ({
  path,
  content: new TextEncoder().encode(content),
  executable: false,
});

/** Answers every conflict question the same way. */
function answer(choice: ConflictChoice) {
  return { resolve: () => Promise.resolve(choice) };
}

describe('Claude Code plan step: closing Claude Code before ~/.claude.json changes (T61)', () => {
  const incoming = file('.agentnomad/claude.json', '{"diffTool":"terminal"}');
  const noManagedSettings: ManagedSettingsSystem = {
    platform: 'linux',
    env: {},
    baseDir: '/nowhere',
    readText: () => Promise.resolve(null),
    exists: () => Promise.resolve(false),
    listDir: () => Promise.resolve([]),
    readRegistry: () => Promise.resolve(null),
  };
  const QUESTION =
    'Claude Code (or the Claude app) is running and rewrites ~/.claude.json while open.';

  function planStep(running: boolean[], answers: string[], prompter?: Prompter) {
    const script = scriptedPrompter(answers);
    const { reporter, lines } = recordingReporter({ levels: false });
    const adapter = createClaudeCodeAdapter({
      env: { PATH: '' },
      homedir: home,
      platform: process.platform,
      isClaudeRunning: () => Promise.resolve(running.shift() ?? false),
      managedSystem: noManagedSettings,
    });
    const plan = (overrides: Partial<RestorePlanContext> = {}) => {
      if (!adapter.planRestore) throw new Error('no plan step');
      return adapter.planRestore({
        target: { kind: 'global' },
        files: [incoming],
        conflicts: new Map([['.agentnomad/claude.json', 'merge']]),
        conflictAnswer: undefined,
        prompter: prompter ?? script.prompter,
        reporter,
        assumeYes: false,
        allowCommands: false,
        parts: new Map(),
        ...overrides,
      });
    };
    return { plan, asked: script.asked, lines };
  }

  it('"I closed it, continue" checks again, then the restore merges it', async () => {
    await put(join(home, '.claude.json'), '{}');
    const t = planStep([true, true, false, false], ['retry', 'retry']);
    const planned = await t.plan();
    expect(t.asked).toEqual([QUESTION, QUESTION]);
    const report = await planned.restore(answer('merge').resolve, {});
    expect(report.written).toEqual(['.agentnomad/claude.json']);
    expect((await readJson(join(home, '.claude.json')))['diffTool']).toBe('terminal');
  });

  it('"Skip" leaves it as it is with the warning, and nothing is asked while writing', async () => {
    await put(join(home, '.claude.json'), '{}');
    const t = planStep([true], ['skip']);
    const planned = await t.plan();
    expect(t.asked).toEqual([QUESTION]);
    const report = await planned.restore(answer('merge').resolve, {});
    expect(await read(join(home, '.claude.json'))).toBe('{}');
    expect(report.warnings[0]).toContain('Claude Code or the Claude app was running');
    expect(t.asked).toHaveLength(1);
  });

  it('--yes never asks: the file is left with the warning while Claude Code runs', async () => {
    await put(join(home, '.claude.json'), '{}');
    const t = planStep([true, true], []);
    const planned = await t.plan({ assumeYes: true });
    expect(t.asked).toEqual([]);
    const report = await planned.restore(answer('merge').resolve, {});
    expect(await read(join(home, '.claude.json'))).toBe('{}');
    expect(report.warnings[0]).toContain('Claude Code or the Claude app was running');
  });

  it('is not asked when the file would not change or its merge was declined', async () => {
    await put(join(home, '.claude.json'), '{"diffTool":"terminal"}');
    expect(
      await (async () => {
        const t = planStep([true], []);
        await t.plan();
        return t.asked;
      })(),
    ).toEqual([]);
    await put(join(home, '.claude.json'), '{}');
    const declined = planStep([true], []);
    await declined.plan({ conflicts: new Map([['.agentnomad/claude.json', 'skip']]) });
    expect(declined.asked).toEqual([]);
  });

  it('without a terminal, the open question stops the plan', async () => {
    await put(join(home, '.claude.json'), '{}');
    const t = planStep([true], [], createNoTerminalPrompter());
    await expect(t.plan()).rejects.toBeInstanceOf(AnswerNeededError);
    expect(await read(join(home, '.claude.json'))).toBe('{}');
  });
});
