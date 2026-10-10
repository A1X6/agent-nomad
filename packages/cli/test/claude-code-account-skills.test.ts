import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  base,
  home,
  synced,
  syncedSetup,
  useProjectFolders,
} from './claude-code-project-fixtures.ts';
import {
  olderSyncedSkillsManifest,
  SYNCED_ACCOUNT,
  syncedAccount,
  syncedDirectorySkill,
  syncedOrganizationSkill,
  syncedSkillsManifest,
  type SyncedSkillEntry,
} from './claude-code-plugin-fixtures.ts';
import {
  collected,
  executableLookup,
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

  it('saves them under the reserved folder, never as skills/synced', async () => {
    await syncedSetup();
    const files = createFileGatherer(process.platform, { skippedNames: SKIPPED_NAMES });
    const collected = await collectAccountSkills(files, await readSyncedSkills(files.path, base));
    expect(paths(collected).sort()).toEqual([
      `${ACCOUNT_SKILLS_PREFIX}my-skill/SKILL.md`,
      `${ACCOUNT_SKILLS_PREFIX}my-skill/reference/notes.md`,
    ]);
  });

  it('an entry with neither creatorType nor source is left out and named, not the whole list', async () => {
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
    expect(found.notice).toContain(
      'brand-new (Claude Code does not say where it comes from in a way agentnomad knows).',
    );
  });

  it('a missing or unknown manifest saves nothing and says why', async () => {
    await writeTestFile(synced('my-skill', 'SKILL.md'), 'x');
    await writeTestFile(synced('manifest.json'), '{"version": 2, "entries": []}');
    const found = await readSyncedSkills(pathsOf(process.platform), base);
    expect(found.own).toEqual([]);
    expect(found.problem).toContain('in a format agentnomad does not know');
  });

  it('names every account whose manifest cannot be read, not only the last', async () => {
    await writeTestFile(synced('manifest.json'), '{"version": 2, "entries": []}');
    await writeTestFile(join(base, 'skills', 'synced', 'other-account', 'manifest.json'), 'x');
    const found = await readSyncedSkills(pathsOf(process.platform), base);
    expect(found.problem?.match(/Claude Code's list of synced skills/g)).toHaveLength(2);
    expect(found.problem).toContain('(skills/synced/other-account/manifest.json)');
  });
});

/** One entry of the 2.1.295 skills manifest, by name. */
function syncedSkill(name: string): SyncedSkillEntry {
  const skill = syncedSkillsManifest.skills.find((entry) => entry.name === name);
  if (skill === undefined) throw new Error(`no synced skill ${name} in the fixture`);
  return skill;
}

/** What push finds after Claude Code 2.1.295 synced `skills` (see `syncedAccount`). */
async function syncedWith(skills: readonly SyncedSkillEntry[], marketplaces = true) {
  await syncedAccount(base, { skills, marketplaces });
  const found = await readSyncedSkills(pathsOf(process.platform), base);
  return { ...found, ownNames: found.own.map((skill) => skill.name) };
}

const notSavedFrom = `Not saved from claude.ai account ${SYNCED_ACCOUNT}:`;
const fromOthers = 'it comes from your organization or claude.ai, not from you';
const cannotTell = 'agentnomad cannot tell which claude.ai marketplace it comes from';
const unknownSource = 'Claude Code does not say where it comes from in a way agentnomad knows';

describe('claude.ai skills on Claude Code 2.1.295, without creatorType (T105)', () => {
  it('saves a plugin skill from your own uploads', async () => {
    const found = await syncedWith([syncedSkill('my-upload')]);
    expect(found.ownNames).toEqual(['my-upload']);
    expect(found.notice).toBeNull();
  });

  it('saves a custom skill (no source from the server)', async () => {
    const found = await syncedWith([syncedSkill('my-custom')]);
    expect(found.ownNames).toEqual(['my-custom']);
    expect(found.notice).toBeNull();
  });

  it.each([
    ['anthropic', 'pdf'],
    ['anthropic-example', 'example-skill'],
    ['session-refs', 'session-skill'],
  ])('never saves a skill with source %s, and says nothing about it', async (_source, name) => {
    const found = await syncedWith([syncedSkill(name)]);
    expect(found.ownNames).toEqual([]);
    expect(found.notice).toBeNull();
  });

  it('from the whole manifest saves only the plugin and custom skills', async () => {
    const found = await syncedWith(syncedSkillsManifest.skills);
    expect(found.problem).toBeNull();
    expect(found.ownNames).toEqual(['my-custom', 'my-upload']);
    expect([...found.allNames].sort()).toEqual([
      'example-skill',
      'my-custom',
      'my-upload',
      'pdf',
      'session-skill',
    ]);
  });

  it("leaves out an organization's plugin skill and names it", async () => {
    const found = await syncedWith([syncedSkill('my-upload'), syncedOrganizationSkill]);
    expect(found.ownNames).toEqual(['my-upload']);
    expect(found.notice).toBe(`${notSavedFrom} team-skill (${fromOthers}).`);
  });

  it("leaves out a plugin skill from claude.ai's directory and names it", async () => {
    const found = await syncedWith([syncedDirectorySkill]);
    expect(found.ownNames).toEqual([]);
    expect(found.notice).toBe(`${notSavedFrom} directory-skill (${fromOthers}).`);
  });

  it('without the marketplaces list saves plugin skills and says organization skills cannot be told apart', async () => {
    const found = await syncedWith([syncedSkill('my-upload'), syncedOrganizationSkill], false);
    expect(found.ownNames).toEqual(['my-upload', 'team-skill']);
    expect(found.notice).toBe(
      `Claude Code keeps no list of claude.ai marketplaces for account ${SYNCED_ACCOUNT} (plugins/synced/${SYNCED_ACCOUNT}/.marketplaces.json), so your organization's skills cannot be told apart from your own: check the names before you save them.`,
    );
  });

  it('without the marketplaces list a custom skill needs no notice', async () => {
    const found = await syncedWith([syncedSkill('my-custom')], false);
    expect(found.ownNames).toEqual(['my-custom']);
    expect(found.notice).toBeNull();
  });

  it('leaves out a plugin skill whose plugin is not among the synced plugins', async () => {
    const gone = { ...syncedSkill('my-upload'), backingPluginId: 'plugin_99gone' };
    const found = await syncedWith([gone]);
    expect(found.ownNames).toEqual([]);
    expect(found.notice).toBe(`${notSavedFrom} my-upload (${cannotTell}).`);
  });

  it('leaves out every plugin skill when the marketplaces list cannot be read', async () => {
    await syncedAccount(base, { skills: [syncedSkill('my-upload'), syncedSkill('my-custom')] });
    await writeTestFile(join(base, 'plugins', 'synced', SYNCED_ACCOUNT, '.marketplaces.json'), 'x');
    const found = await readSyncedSkills(pathsOf(process.platform), base);
    expect(found.own.map((skill) => skill.name)).toEqual(['my-custom']);
    expect(found.notice).toBe(`${notSavedFrom} my-upload (${cannotTell}).`);
  });

  it('leaves out a skill with a source agentnomad does not know and names it', async () => {
    const found = await syncedWith([{ name: 'odd', description: 'd', source: 'marketplace-v3' }]);
    expect(found.ownNames).toEqual([]);
    expect(found.notice).toBe(`${notSavedFrom} odd (${unknownSource}).`);
  });

  it('still follows creatorType on an older Claude Code', async () => {
    const found = await syncedWith(olderSyncedSkillsManifest.skills);
    expect(found.ownNames).toEqual(['older-skill']);
    expect(found.notice).toBeNull();
  });

  it('never saves an entry whose creatorType is not user, whatever its source', async () => {
    const found = await syncedWith([{ ...syncedSkill('my-custom'), creatorType: 'organization' }]);
    expect(found.ownNames).toEqual([]);
    expect(found.notice).toBeNull();
  });

  it('an unreadable manifest saves nothing and names the account', async () => {
    await syncedAccount(base);
    await writeTestFile(join(base, 'skills', 'synced', SYNCED_ACCOUNT, 'manifest.json'), '{');
    const found = await readSyncedSkills(pathsOf(process.platform), base);
    expect(found.own).toEqual([]);
    expect(found.problem).toBe(
      `Claude Code's list of synced skills (skills/synced/${SYNCED_ACCOUNT}/manifest.json) is missing or in a format agentnomad does not know.`,
    );
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
});

describe('claude.ai skills (T42): pull adds them as local skills', () => {
  function run(
    files: CollectedFile[],
    options: { assumeYes?: boolean; allowCommands?: boolean; accountSkills?: boolean } = {},
    answers: boolean[] = [],
  ) {
    const script = scriptedPrompter(answers);
    const { reporter, lines } = recordingReporter({ levels: false });
    const system = executableLookup({
      platform: process.platform,
      homedir: home,
      env: { PATH: '' },
    });
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

  it('a no adds none', async () => {
    const no = run([saved('mine', 'Plain.')], {}, [false]);
    await no.done;
    await expect(skillFile('mine')).rejects.toThrow();
  });

  it('--yes alone never adds them and never asks', async () => {
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

  it('skips a skill this PC already gets from claude.ai', async () => {
    await syncedSetup();
    const t = run([saved('my-skill', 'From the other PC.')], { accountSkills: true });
    await t.done;
    await expect(skillFile('my-skill')).rejects.toThrow();
    expect(t.lines.join('\n')).toContain(
      'my-skill: skipped, this PC already gets it from claude.ai',
    );
  });

  it('never touches a local skill of the same name', async () => {
    await writeTestFile(join(base, 'skills', 'local-one', 'SKILL.md'), 'My own local version.');
    const t = run([saved('local-one', 'Theirs.')], { accountSkills: true });
    await t.done;
    expect(await skillFile('local-one')).toBe('My own local version.');
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
