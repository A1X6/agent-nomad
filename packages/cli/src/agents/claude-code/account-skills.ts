import { readdir, readFile } from 'node:fs/promises';
import type { PlatformPath } from 'node:path';

import * as z from 'zod';

import { isDirectory } from '../../system/files.ts';
import { parseJsonWith, valueOrNull } from '../../system/json.ts';
import type { Reporter } from '../../ui/prompter.ts';
import type { CollectedFile } from '../adapter.ts';
import type { FileGatherer } from '../shared/file-gathering.ts';
import {
  askSavedCopies,
  filesInSkills,
  NAME_NOT_A_FOLDER,
  planSavedCopies,
  savedCopiesIn,
  type NamesHere,
  type SavedCopiesContext,
  type SavedCopiesPlan,
  type SavedCopy,
} from './account-copies.ts';
import { ACCOUNT_SKILLS_PREFIX } from './global-paths.ts';
import { runnableInMarkdown } from './runnable-markdown.ts';
import { NOT_OWN_SCOPES, readSyncedPluginsOf, SYNCED_PLUGINS_DIR } from './synced-plugins.ts';

/**
 * Skills from the user's claude.ai account (T42). Claude Code downloads them into
 * `~/.claude/skills/synced/<account>/<name>/` and manages that folder itself; agentnomad
 * never writes there. On request, push saves the user's **own** ones (never Anthropic's, nor
 * an organization's when Claude Code's files tell them apart) under a reserved bundle folder,
 * and pull can add them back as normal local skills on a PC that does not get them from its
 * own claude.ai sync.
 */
const SYNCED_SKILLS_DIR = 'skills/synced';
/** The id of the optional part for saved claude.ai skills (T42, T61); also the flag name. */
export const ACCOUNT_SKILLS_PART = 'account-skills';

/**
 * Claude Code's `manifest.json` for one account's synced skills (an internal file, so only
 * the fields used here are checked, and each entry on its own). Before 2.1.295 an entry's
 * `creatorType` said who made it (`user`: the user). Claude Code 2.1.295 writes no
 * `creatorType` (the 2.1.296 program never names it, T107); `source` says where a skill comes
 * from instead: `custom` (the server sent none) and `plugin` (backed by the claude.ai plugin
 * `backingPluginId`) can be the user's; `anthropic`, `anthropic-example` and `session-refs`
 * never are.
 */
const ManifestSchema = z.looseObject({ skills: z.array(z.unknown()) });
const EntrySchema = z.looseObject({
  name: z.string(),
  creatorType: z.string().optional(),
  source: z.string().optional(),
  backingPluginId: z.string().optional(),
});
type SyncedSkillEntry = z.infer<typeof EntrySchema>;

/** Sources that are never the user's own skills. */
const NOT_OWN_SOURCES = new Set(['anthropic', 'anthropic-example', 'session-refs']);

/**
 * The marketplace scope of each synced plugin of one account, by plugin id; `'no list'` when
 * Claude Code keeps no `.marketplaces.json` there, `'unreadable'` when one is there but cannot
 * be read.
 */
type PluginScopes = ReadonlyMap<string, string> | 'no list' | 'unreadable';

async function readPluginScopes(path: PlatformPath, accountDir: string): Promise<PluginScopes> {
  const plugins = await readSyncedPluginsOf(path, accountDir);
  if (typeof plugins === 'string') return plugins;
  const scopes = new Map<string, string>();
  for (const { pluginId, scope } of plugins) {
    if (pluginId !== undefined && scope !== undefined) scopes.set(pluginId, scope);
  }
  return scopes;
}

/**
 * Whether a synced skill is the user's own: `'own'`, `'not own'` (Anthropic's and the like,
 * left out without a word), or why it is left out. When in doubt it is left out.
 */
type Ownership = 'own' | 'not own' | { readonly leftOut: string };

function ownershipOf(skill: SyncedSkillEntry, scopes: PluginScopes): Ownership {
  // Older Claude Code: `creatorType` decides, as it always did.
  if (skill.creatorType !== undefined) return skill.creatorType === 'user' ? 'own' : 'not own';
  if (skill.source === 'custom') return 'own';
  if (skill.source !== undefined && NOT_OWN_SOURCES.has(skill.source)) return 'not own';
  if (skill.source !== 'plugin') {
    return { leftOut: 'Claude Code does not say where it comes from in a way agentnomad knows' };
  }
  // Without the marketplaces list an organization's plugin cannot be told apart (said once).
  if (scopes === 'no list') return 'own';
  const scope =
    scopes === 'unreadable' || skill.backingPluginId === undefined
      ? undefined
      : scopes.get(skill.backingPluginId);
  if (scope === 'account') return 'own';
  if (scope !== undefined && NOT_OWN_SCOPES.has(scope)) {
    return { leftOut: 'it comes from your organization or claude.ai, not from you' };
  }
  return { leftOut: 'agentnomad cannot tell which claude.ai marketplace it comes from' };
}

/**
 * A folder name in `~/.claude/skills/` that is safe everywhere and not one Claude Code
 * reserves; also checked for saved claude.ai plugins (T101).
 */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RESERVED_NAMES = new Set(['synced', 'anthropic-skills']);
export const isUsableSkillName = (name: string) =>
  SKILL_NAME.test(name) && !RESERVED_NAMES.has(name.toLowerCase());

export interface SyncedSkills {
  /** The user's own skills, with their folder on this PC. */
  readonly own: readonly { readonly name: string; readonly dir: string }[];
  /** Every synced skill name on this PC (any creator), to avoid adding a duplicate. */
  readonly allNames: ReadonlySet<string>;
  /**
   * Why an account's skills could not be read, e.g. a manifest in an unknown format, one
   * sentence per account; `null` when fine.
   */
  readonly problem: string | null;
  /**
   * What push should say before saving them, one sentence per account: skills left out with
   * why, or that an organization's cannot be told apart here; `null` when nothing.
   */
  readonly notice: string | null;
}

/** What `~/.claude/skills/synced/` holds on this PC. Never throws; unreadable parts are skipped. */
export async function readSyncedSkills(path: PlatformPath, baseDir: string): Promise<SyncedSkills> {
  const root = path.join(baseDir, ...SYNCED_SKILLS_DIR.split('/'));
  const own = new Map<string, string>();
  const allNames = new Set<string>();
  const problems: string[] = [];
  const notices: string[] = [];
  const accounts = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const account of accounts) {
    if (!account.isDirectory() || account.name.startsWith('.')) continue;
    const accountDir = path.join(root, account.name);
    const text = await readFile(path.join(accountDir, 'manifest.json'), 'utf8').catch(() => null);
    const manifest = text === null ? null : valueOrNull(parseJsonWith(ManifestSchema, text));
    if (manifest === null) {
      problems.push(
        `Claude Code's list of synced skills (${SYNCED_SKILLS_DIR}/${account.name}/manifest.json) is missing or in a format agentnomad does not know.`,
      );
      continue;
    }
    const scopes = await readPluginScopes(
      path,
      path.join(baseDir, ...SYNCED_PLUGINS_DIR.split('/'), account.name),
    );
    const leftOut: string[] = [];
    let cannotTell = false;
    for (const entry of manifest.skills) {
      const parsed = EntrySchema.safeParse(entry);
      if (!parsed.success) continue;
      const skill = parsed.data;
      allNames.add(skill.name.toLowerCase());
      const ownership = ownershipOf(skill, scopes);
      if (typeof ownership === 'object') leftOut.push(`${skill.name} (${ownership.leftOut})`);
      if (ownership !== 'own' || own.has(skill.name)) continue;
      // Named, as for plugins (UX-03): push names every skill of the user's it leaves out.
      if (!isUsableSkillName(skill.name)) {
        leftOut.push(`${skill.name} (${NAME_NOT_A_FOLDER})`);
        continue;
      }
      const dir = path.join(accountDir, skill.name);
      if (!(await isDirectory(dir))) {
        leftOut.push(`${skill.name} (its folder here is missing)`);
        continue;
      }
      own.set(skill.name, dir);
      // A plugin skill picked without the marketplaces list may be an organization's.
      cannotTell ||=
        scopes === 'no list' && skill.creatorType === undefined && skill.source === 'plugin';
    }
    if (leftOut.length > 0) {
      notices.push(`Not saved from claude.ai account ${account.name}: ${leftOut.join(', ')}.`);
    }
    if (cannotTell) {
      notices.push(
        `Claude Code keeps no list of claude.ai marketplaces for account ${account.name} (${SYNCED_PLUGINS_DIR}/${account.name}/.marketplaces.json), so your organization's skills cannot be told apart from your own: check the names before you save them.`,
      );
    }
  }
  return {
    own: [...own.entries()]
      .map(([name, dir]) => ({ name, dir }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    allNames,
    problem: problems.length === 0 ? null : problems.join(' '),
    notice: notices.length === 0 ? null : notices.join(' '),
  };
}

/** The user's own synced skills as bundle files, under `.agentnomad/account-skills/<name>/`. */
export async function collectAccountSkills(
  files: FileGatherer,
  skills: SyncedSkills,
): Promise<CollectedFile[]> {
  const found: CollectedFile[] = [];
  for (const skill of skills.own) {
    found.push(
      ...(await files.walk(skill.dir, `${ACCOUNT_SKILLS_PREFIX}${skill.name}`, () => false)),
    );
  }
  return found;
}

export interface AccountSkillPlan {
  /** Skills that can be added here, and whether each runs commands as a local skill. */
  readonly toAdd: readonly { readonly name: string; readonly runsCommands: boolean }[];
  /** Skills left out, with why. */
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
  /** The files to write, as global bundle paths (`skills/<name>/...`). */
  readonly files: readonly CollectedFile[];
}

/** The saved skills pull may add here, as {@link planAccountSkills} says. */
const planSkills = (bundleFiles: readonly CollectedFile[], here: NamesHere): SavedCopiesPlan =>
  planSavedCopies(
    savedCopiesIn(ACCOUNT_SKILLS_PREFIX, bundleFiles, isUsableSkillName),
    here,
    'you already have a local skill with this name',
  );

/** Whether a skill runs commands as a local skill (T44's detector). */
const runsCommands = (copy: SavedCopy) =>
  copy.files.some(
    (file) =>
      file.path.toLowerCase().endsWith('.md') &&
      runnableInMarkdown(new TextDecoder().decode(file.content)).length > 0,
  );

/**
 * Which saved account skills pull may add on this PC as local skills: not one this PC already
 * gets from its own claude.ai sync, and never over a local skill of the same name.
 */
export function planAccountSkills(
  bundleFiles: readonly CollectedFile[],
  here: NamesHere,
): AccountSkillPlan {
  const plan = planSkills(bundleFiles, here);
  return {
    toAdd: plan.toAdd.map((copy) => ({ name: copy.name, runsCommands: runsCommands(copy) })),
    skipped: plan.skipped,
    files: filesInSkills(plan.toAdd),
  };
}

/** What the plan step gives the question about saved skills (T61). */
export type AccountSkillsContext = SavedCopiesContext & { readonly allowCommands: boolean };

/**
 * Saved claude.ai skills (T42): added as local skills on a PC that does not already get them
 * from its own claude.ai sync, unless the user says no (T114). A skill with `` !`command` ``
 * lines runs those as a local skill (a synced one does not), so it is marked, and a flag or
 * --yes (no question asked) adds it only with --allow-commands too. Planned in pull's plan
 * step with the saved plugins, so a skill folder that is a plugin gets the plugin review
 * (SEC-03). Returns the skills to add and their files, as `skills/<name>/...`.
 */
export async function askAccountSkills(
  context: AccountSkillsContext,
  here: NamesHere,
): Promise<{ readonly names: readonly string[]; readonly files: readonly CollectedFile[] }> {
  const plan = planSkills(context.files, here);
  const { add, answered } = await askSavedCopies(context, plan, {
    heading: 'Skills from your claude.ai account on the other PC:',
    line: (copy) =>
      `${copy.name}${runsCommands(copy) ? '  ⚠ runs commands as a local skill (! lines, ```! blocks or hooks)' : ''}`,
    question:
      'Add them as local skills? Only needed if this PC uses another claude.ai account, or none. Added unless you say no.',
    part: ACCOUNT_SKILLS_PART,
  });
  if (!add) return { names: [], files: [] };
  // Answered by a flag or --yes, not a person: commands only run with --allow-commands too.
  const blocked = answered && !context.allowCommands ? plan.toAdd.filter(runsCommands) : [];
  for (const { name } of blocked) {
    context.reporter.warn(
      `Skipped ${name}: it runs commands as a local skill. Add --allow-commands to add it anyway.`,
    );
  }
  const approved = plan.toAdd.filter((copy) => !blocked.includes(copy));
  return { names: approved.map((copy) => copy.name), files: filesInSkills(approved) };
}

/**
 * Says which of the saved skills `names` pull added, from the paths it `written` (UX-01 of an
 * earlier review): the restorer or the plugin review may leave a skill's files out.
 */
export function reportAccountSkills(
  names: readonly string[],
  written: readonly string[],
  reporter: Reporter,
): void {
  if (names.length === 0) return;
  const added = new Set(written.map((path) => path.split('/')[1] ?? ''));
  const missing = names.filter((name) => !added.has(name));
  if (missing.length > 0) reporter.warn(`Not added: ${missing.join(', ')}.`);
  const done = names.filter((name) => added.has(name));
  if (done.length === 0) return;
  reporter.success(
    `Added ${done.join(', ')} as local skills. If this PC later signs in to the claude.ai account they came from, they sync there too, and your local copy keeps the short name.`,
  );
}
