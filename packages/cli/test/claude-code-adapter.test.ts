import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collected,
  executableLookup,
  paths,
  readJson,
  readText,
  recordingReporter,
  scriptedPrompter,
  useTempDir,
  writeTestFile,
} from './fakes.ts';
import {
  fakeManagedSystem,
  modFiles,
  validateCli,
  validatePassWithWarning,
} from './claude-code-plugin-fixtures.ts';
import { claudeCodeAdapter } from './claude-code-project-fixtures.ts';
import {
  AnswerNeededError,
  CLAUDE_JSON_BUNDLE_PATH,
  createNoTerminalPrompter,
  findPluginValidator,
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
  const noManagedSettings = fakeManagedSystem({ platform: 'linux' });
  const QUESTION =
    'Claude Code (or the Claude app) is running and rewrites ~/.claude.json while open.';

  function planStep(running: boolean[], answers: string[], prompter?: Prompter) {
    const script = scriptedPrompter(answers);
    const { reporter } = recordingReporter({ levels: false });
    const adapter = claudeCodeAdapter(home, {
      isClaudeRunning: () => Promise.resolve(running.shift() ?? false),
      managedSystem: noManagedSettings,
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

  it('is not asked when its merge was declined', async () => {
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

  /** A global setup and a project, each with its CLAUDE.md; returns the project folder. */
  async function globalAndProject() {
    await writeTestFile(join(home, '.claude', 'CLAUDE.md'), 'global rules');
    const project = join(home, 'app');
    await writeTestFile(join(project, 'CLAUDE.md'), 'project rules');
    return project;
  }

  it('detects Claude Code by its base folder', async () => {
    await globalAndProject();
    expect(await adapter().detector.detect()).toEqual({
      installed: true,
      baseDir: join(home, '.claude'),
      version: null,
    });
  });

  it('collects the global setup', async () => {
    await globalAndProject();
    const global = await adapter().collector.collect({ kind: 'global' }, { includeMemory: false });
    expect(paths(global)).toEqual(['CLAUDE.md']);
  });

  it('collects a project setup', async () => {
    const project = await globalAndProject();
    const local = await adapter().collector.collect(
      { kind: 'project', projectDir: project },
      { includeMemory: false },
    );
    expect(paths(local)).toEqual(['CLAUDE.md']);
    expect(new TextDecoder().decode(local[0]?.content)).toBe('project rules');
  });

  it('restores a project setup into another folder', async () => {
    const project = await globalAndProject();
    const claude = adapter();
    const local = await claude.collector.collect(
      { kind: 'project', projectDir: project },
      { includeMemory: false },
    );
    const report = await claude.restorer.restore(
      { kind: 'project', projectDir: join(home, 'other-app') },
      local,
      () => Promise.resolve('skip'),
    );
    expect(report.written).toEqual(['CLAUDE.md']);
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

describe('Claude Code plan step: plugin folders in skills/ (T97)', () => {
  const base = () => join(home, '.claude');

  /** The plan step with `claude` answering validate with a passing report, and these answers. */
  async function planStep(answers: boolean[], overrides: Partial<RestorePlanContext> = {}) {
    const script = scriptedPrompter(answers);
    const { reporter } = recordingReporter({ levels: false });
    const system = executableLookup({
      platform: 'linux',
      homedir: home,
      env: { PATH: '/usr/bin' },
      executables: ['/usr/bin/claude'],
    });
    const adapter = claudeCodeAdapter(home, {
      managedSystem: fakeManagedSystem({ platform: 'linux' }),
      pluginValidator: await findPluginValidator(system, validateCli(validatePassWithWarning).cli),
    });
    if (!adapter.planRestore) throw new Error('no plan step');
    const planned = await adapter.planRestore({
      target: { kind: 'global' },
      files: modFiles(),
      conflicts: new Map(),
      conflictAnswer: undefined,
      prompter: script.prompter,
      reporter,
      assumeYes: false,
      allowCommands: false,
      parts: new Map(),
      ...overrides,
    });
    return { planned, asked: script.asked };
  }

  it('writes a mod after a yes', async () => {
    const t = await planStep([true]);
    const report = await t.planned.restore(answer('skip'), {});
    expect(report.written).toContain('skills/probe-mod/hooks/register.ts');
    expect(t.planned.declined).toBe(false);
  });

  it('leaves a declined mod out, and says the setup is partial', async () => {
    const t = await planStep([false]);
    const report = await t.planned.restore(answer('skip'), {});
    expect(report.written).toEqual([]);
    expect(t.planned.declined).toBe(true);
  });

  it('does not ask about a plugin folder that is here as it is', async () => {
    for (const file of modFiles()) {
      await writeTestFile(join(base(), ...file.path.split('/')), file.content);
    }
    const t = await planStep([]);
    expect(t.asked).toEqual([]);
  });

  it('reviews no plugin folder in a project setup', async () => {
    const t = await planStep([], { target: { kind: 'project', projectDir: join(home, 'app') } });
    expect(t.asked).toEqual([]);
  });

  it("names the plugins in push's summary", () => {
    expect(claudeCodeAdapter(home).inspector?.pushNotes?.(modFiles())).toEqual([
      'Plugins in skills/: probe-mod@skills-dir (runs code)',
    ]);
  });
});
