import { readdir, readFile, stat } from 'node:fs/promises';
import type { PlatformPath } from 'node:path';

import * as z from 'zod';

import { parseJsonWith, valueOrNull } from '../../system/json.ts';
import type { CollectedFile } from '../adapter.ts';
import type { FileGatherer } from '../shared/file-gathering.ts';
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
 * `creatorType`; `source` says where a skill comes from instead: `custom` (the server sent
 * none) and `plugin` (backed by the claude.ai plugin `backingPluginId`) can be the user's;
 * `anthropic`, `anthropic-example` and `session-refs` never are.
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

const isDirectory = async (path: string) =>
  (await stat(path).catch(() => null))?.isDirectory() ?? false;

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
      const dir = path.join(accountDir, skill.name);
      if (
        ownership === 'own' &&
        isUsableSkillName(skill.name) &&
        !own.has(skill.name) &&
        (await isDirectory(dir))
      ) {
        own.set(skill.name, dir);
        // A plugin skill picked without the marketplaces list may be an organization's.
        cannotTell ||=
          scopes === 'no list' && skill.creatorType === undefined && skill.source === 'plugin';
      }
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

/**
 * Which saved account skills pull may add on this PC as local skills: not one this PC already
 * gets from its own claude.ai sync, and never over a local skill of the same name.
 */
export function planAccountSkills(
  bundleFiles: readonly CollectedFile[],
  here: { syncedNames: ReadonlySet<string>; localNames: ReadonlySet<string> },
): AccountSkillPlan {
  const byName = new Map<string, CollectedFile[]>();
  for (const file of bundleFiles) {
    if (!file.path.startsWith(ACCOUNT_SKILLS_PREFIX)) continue;
    const rest = file.path.slice(ACCOUNT_SKILLS_PREFIX.length);
    const name = rest.split('/')[0] ?? '';
    if (!isUsableSkillName(name) || rest === name) continue;
    const skillFiles = byName.get(name);
    if (skillFiles === undefined) byName.set(name, [file]);
    else skillFiles.push(file);
  }
  const toAdd: { name: string; runsCommands: boolean }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const files: CollectedFile[] = [];
  for (const [name, skillFiles] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (here.syncedNames.has(name.toLowerCase())) {
      skipped.push({ name, reason: 'this PC already gets it from claude.ai' });
      continue;
    }
    if (here.localNames.has(name.toLowerCase())) {
      skipped.push({ name, reason: 'you already have a local skill with this name' });
      continue;
    }
    const runsCommands = skillFiles.some(
      (file) =>
        file.path.toLowerCase().endsWith('.md') &&
        runnableInMarkdown(new TextDecoder().decode(file.content)).length > 0,
    );
    toAdd.push({ name, runsCommands });
    for (const file of skillFiles) {
      files.push({ ...file, path: `skills/${file.path.slice(ACCOUNT_SKILLS_PREFIX.length)}` });
    }
  }
  return { toAdd, skipped, files };
}
