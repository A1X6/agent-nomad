import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACCOUNT_SKILLS_PREFIX,
  collectAccountSkills,
  createClaudeCodeAfterRestore,
  createClaudeCodeGlobalCollector,
  createClaudeCodeRestorer,
  createFileGatherer,
  globalDestination,
  planAccountSkills,
  readSyncedSkills,
  type AfterRestoreContext,
  type CollectedFile,
  type DetectorSystem,
} from '../src/index.ts';

let root: string;
let home: string;
let base: string;
const ACCOUNT = '7c844940_79950eec';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentnomad-account-skills-'));
  home = join(root, 'home');
  base = join(home, '.claude');
  await mkdir(base, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const synced = (...parts: string[]) => join(base, 'skills', 'synced', ACCOUNT, ...parts);

/** A synced folder as Claude Code 2.1.283 writes it: the user's skill, Anthropic's, an organization's. */
async function syncedSetup(): Promise<void> {
  await put(join(base, 'skills', 'synced', `.bucket-${ACCOUNT}`), '');
  await put(synced('.last-complete-round'), '1');
  await put(synced('.staging', 'tmp'), 'partial');
  await put(
    synced('manifest.json'),
    JSON.stringify({
      lastUpdated: 1,
      skills: [
        {
          skillId: 'skill_01',
          name: 'my-skill',
          description: 'd',
          source: 'plugin',
          updatedAt: 't',
          creatorType: 'user',
        },
        {
          skillId: 'pdf',
          name: 'pdf',
          description: 'd',
          source: 'anthropic',
          updatedAt: 't',
          creatorType: 'anthropic',
        },
        {
          skillId: 'skill_02',
          name: 'team-skill',
          description: 'd',
          source: 'org',
          updatedAt: 't',
          creatorType: 'organization',
        },
        {
          skillId: 'skill_03',
          name: 'synced',
          description: 'd',
          source: 'plugin',
          updatedAt: 't',
          creatorType: 'user',
        },
      ],
    }),
  );
  await put(synced('my-skill', 'SKILL.md'), '---\nname: my-skill\n---\nDo my thing.\n');
  await put(synced('my-skill', 'reference', 'notes.md'), 'Notes.\n');
  await put(synced('pdf', 'SKILL.md'), '---\nname: pdf\n---\nAnthropic PDF skill.\n');
  await put(synced('team-skill', 'SKILL.md'), '---\nname: team-skill\n---\nOrg only.\n');
  await put(synced('synced', 'SKILL.md'), 'reserved name');
}

describe('claude.ai skills (T42): reading and saving', () => {
  it("finds only the user's own synced skills; every synced name is known", async () => {
    await syncedSetup();
    const found = await readSyncedSkills(createFileGatherer(process.platform), base);
    expect(found.problem).toBeNull();
    expect(found.own.map((skill) => skill.name)).toEqual(['my-skill']);
    expect([...found.allNames].sort()).toEqual(['my-skill', 'pdf', 'synced', 'team-skill']);
  });

  it('saves them under the reserved folder, never as skills/synced', async () => {
    await syncedSetup();
    const files = createFileGatherer(process.platform);
    const collected = await collectAccountSkills(files, await readSyncedSkills(files, base));
    expect(collected.map((file) => file.path).sort()).toEqual([
      `${ACCOUNT_SKILLS_PREFIX}my-skill/SKILL.md`,
      `${ACCOUNT_SKILLS_PREFIX}my-skill/reference/notes.md`,
    ]);
  });

  it('an entry without creatorType (as on a newly synced skill) is skipped, not the whole list', async () => {
    await put(
      synced('manifest.json'),
      JSON.stringify({
        skills: [{ name: 'my-skill', creatorType: 'user' }, { name: 'brand-new' }, 'not an object'],
      }),
    );
    await put(synced('my-skill', 'SKILL.md'), 'x');
    await put(synced('brand-new', 'SKILL.md'), 'y');
    const found = await readSyncedSkills(createFileGatherer(process.platform), base);
    expect(found.problem).toBeNull();
    expect(found.own.map((skill) => skill.name)).toEqual(['my-skill']);
    expect([...found.allNames].sort()).toEqual(['brand-new', 'my-skill']);
  });

  it('a missing or unknown manifest saves nothing and says why', async () => {
    await put(synced('my-skill', 'SKILL.md'), 'x');
    await put(synced('manifest.json'), '{"version": 2, "entries": []}');
    const found = await readSyncedSkills(createFileGatherer(process.platform), base);
    expect(found.own).toEqual([]);
    expect(found.problem).toContain('in a format agentnomad does not know');
  });

  it('the global collector adds them only when asked', async () => {
    await syncedSetup();
    await put(join(base, 'CLAUDE.md'), 'Notes');
    const collector = createClaudeCodeGlobalCollector({
      baseDir: base,
      homedir: home,
      platform: process.platform,
      customConfigDir: false,
    });
    const plain = await collector.collect({ kind: 'global' }, { includeMemory: false });
    expect(
      plain.some(
        (file) => file.path.includes('synced') || file.path.startsWith(ACCOUNT_SKILLS_PREFIX),
      ),
    ).toBe(false);
    const withSkills = await collector.collect(
      { kind: 'global' },
      { includeMemory: false, includeAccountSkills: true },
    );
    expect(withSkills.filter((file) => file.path.startsWith(ACCOUNT_SKILLS_PREFIX))).toHaveLength(
      2,
    );
    expect(withSkills.some((file) => file.path.startsWith('skills/synced'))).toBe(false);
  });

  it("restore never writes them directly: they are left to pull's follow-up", () => {
    expect(globalDestination(`${ACCOUNT_SKILLS_PREFIX}my-skill/SKILL.md`, new Set())).toEqual({
      kind: 'metadata',
    });
  });
});

const saved = (name: string, body: string): CollectedFile => ({
  path: `${ACCOUNT_SKILLS_PREFIX}${name}/SKILL.md`,
  content: new TextEncoder().encode(`---\nname: ${name}\n---\n${body}\n`),
  executable: false,
});

describe('claude.ai skills (T42): what pull may add', () => {
  it('skips a skill this PC already syncs or a local name, marks ones that run commands', () => {
    const plan = planAccountSkills(
      [
        saved('mine', 'Plain.'),
        saved('Synced-Here', 'Plain.'),
        saved('local-one', 'Plain.'),
        saved('runner', 'Branch: !`git branch --show-current`'),
        saved('synced', 'reserved'),
      ],
      { syncedNames: new Set(['synced-here']), localNames: new Set(['local-one']) },
    );
    expect(plan.toAdd).toEqual([
      { name: 'mine', runsCommands: false },
      { name: 'runner', runsCommands: true },
    ]);
    expect(plan.skipped).toEqual([
      { name: 'local-one', reason: 'you already have a local skill with this name' },
      { name: 'Synced-Here', reason: 'this PC already gets it from claude.ai' },
    ]);
    expect(plan.files.map((file) => file.path)).toEqual([
      'skills/mine/SKILL.md',
      'skills/runner/SKILL.md',
    ]);
  });
});

describe('claude.ai skills (T42): pull adds them as local skills', () => {
  function run(
    files: CollectedFile[],
    options: Partial<AfterRestoreContext> = {},
    answers: boolean[] = [],
  ) {
    const asked: string[] = [];
    const lines: string[] = [];
    const system: DetectorSystem = {
      platform: process.platform,
      homedir: home,
      env: { PATH: '' },
      isDirectory: () => Promise.resolve(false),
      isExecutable: () => Promise.resolve(false),
      readText: () => Promise.resolve(null),
      runVersion: () => Promise.resolve(null),
    };
    const restorer = createClaudeCodeRestorer({
      baseDir: base,
      homedir: home,
      platform: process.platform,
      env: {},
      customConfigDir: false,
      isClaudeRunning: () => Promise.resolve(false),
      onClaudeRunning: () => Promise.resolve('skip'),
    });
    const done = createClaudeCodeAfterRestore({ system, restorer })({
      target: { kind: 'global' },
      files,
      assumeYes: false,
      allowCommands: false,
      prompter: {
        confirm: (message: string) => {
          asked.push(message);
          return Promise.resolve(answers.shift() ?? false);
        },
      } as unknown as AfterRestoreContext['prompter'],
      reporter: {
        info: (m) => lines.push(m),
        success: (m) => lines.push(m),
        warn: (m) => lines.push(m),
        error: (m) => lines.push(m),
        spinner: () => ({ start: () => undefined, stop: () => undefined }),
      },
      ...options,
    });
    return { done, asked, lines };
  }
  const skillFile = (name: string) => readFile(join(base, 'skills', name, 'SKILL.md'), 'utf8');

  it('asks, and a yes writes them into ~/.claude/skills/<name>/', async () => {
    const t = run([saved('mine', 'Plain.')], {}, [true]);
    await t.done;
    expect(t.asked).toEqual([
      'Add them as local skills? Only needed if this PC uses another claude.ai account, or none.',
    ]);
    expect(await skillFile('mine')).toContain('Plain.');
    expect(t.lines.at(-1)).toContain('Added mine as local skills.');
  });

  it('no by default; --yes alone never adds them and never asks', async () => {
    const no = run([saved('mine', 'Plain.')], {}, [false]);
    await no.done;
    await expect(skillFile('mine')).rejects.toThrow();
    const yes = run([saved('mine', 'Plain.')], { assumeYes: true });
    await yes.done;
    expect(yes.asked).toEqual([]);
    await expect(skillFile('mine')).rejects.toThrow();
  });

  it('--account-skills adds them without asking, but not one that runs commands unless --allow-commands', async () => {
    const files = [saved('mine', 'Plain.'), saved('runner', 'Run !`git status`')];
    const flag = run(files, { accountSkills: true });
    await flag.done;
    expect(flag.asked).toEqual([]);
    expect(await skillFile('mine')).toContain('Plain.');
    await expect(skillFile('runner')).rejects.toThrow();
    expect(flag.lines.join('\n')).toContain('runner  ⚠ runs commands');
    expect(flag.lines.join('\n')).toContain('Skipped runner: it runs commands as a local skill.');

    const allowed = run(files, { accountSkills: true, allowCommands: true });
    await allowed.done;
    expect(await skillFile('runner')).toContain('git status');
  });

  it('skips a skill this PC already gets from claude.ai, and never touches a local one', async () => {
    await syncedSetup();
    await put(join(base, 'skills', 'local-one', 'SKILL.md'), 'My own local version.');
    const t = run([saved('my-skill', 'From the other PC.'), saved('local-one', 'Theirs.')], {
      accountSkills: true,
    });
    await t.done;
    expect(await skillFile('local-one')).toBe('My own local version.');
    await expect(skillFile('my-skill')).rejects.toThrow();
    expect(t.lines.join('\n')).toContain(
      'my-skill: skipped, this PC already gets it from claude.ai',
    );
  });
});
