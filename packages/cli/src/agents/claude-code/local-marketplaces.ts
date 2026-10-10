import { mkdir, readFile, rm, stat } from 'node:fs/promises';

import { BundlePathSchema, MAX_BUNDLE_BYTES } from '@agentnomad/contracts';
import * as z from 'zod';

import { parseJsonWith, valueOrNull, type JsonResult } from '../../system/json.ts';
import { formatSize } from '../../ui/format-size.ts';
import { printableLine } from '../../ui/printable.ts';
import type {
  CollectedFile,
  ConflictChoice,
  ConflictResolver,
  RestorePlanContext,
  RestoreReport,
} from '../adapter.ts';
import { bundlePathInside, createFileGatherer, jsonFile } from '../shared/file-gathering.ts';
import { findExecutable, pathsOf, type ExecutableLookupSystem } from '../shared/detector-system.ts';
import { homePathProblem, LOCAL_MARKETPLACES_PREFIX, SKIPPED_NAMES } from './global-paths.ts';
import {
  askPluginFolders,
  pluginFolderChange,
  type PluginFolderToReview,
  type PluginValidator,
} from './plugin-review.ts';
import { createProgramCli, type ProgramCli } from './plugin-sync.ts';
import {
  MarketplaceNameSchema,
  PluginEntrySchema,
  readLocalMarketplaces,
  type MarketplaceEntry,
  type PluginEntry,
  type PluginManifestInput,
} from './plugins.ts';
import { sameForRestore, type ClaudeCodeRestorer } from './restorer.ts';

/*
 * Marketplaces added from a folder on this PC (T98). Plugins are reinstalled with Claude
 * Code's own commands (T29), but a local folder exists only on the PC that has it: push saves
 * its files, and pull writes them back, with the folder's git history when it can re-clone it.
 */

/**
 * A remote `git clone` may take: not an option, no `<transport>::` helper (`ext::` runs a
 * command), no white space or control character. Clones also allow only the protocols below.
 */
const RemoteSchema = z
  .string()
  .max(2048)
  .regex(/^(?!-)(?!.*::)[^\s\p{Cc}]+$/u);

/** Protocols a re-clone may use; `file` for a remote that is a folder, e.g. a bare repository. */
const GIT_PROTOCOLS = 'file:git:http:https:ssh';

const GitSourceSchema = z.strictObject({
  remote: RemoteSchema,
  /** On the remote when push looked (`git branch -r --contains HEAD`). */
  commit: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
});
type GitSource = z.infer<typeof GitSourceSchema>;

/** A saved folder (T98, T99): where it was, where it can be re-cloned from, and its files. */
export const SAVED_FOLDER_SHAPE = {
  /** The folder by path from home, `/`-separated; `null` when it was outside home. */
  path: BundlePathSchema.nullable(),
  /** Where pull can re-clone it from; `null` outside git, or when the commit was not pushed. */
  git: GitSourceSchema.nullable(),
  /** Its files, with paths from the folder. */
  files: z.array(
    z.strictObject({ path: BundlePathSchema, content: z.base64(), executable: z.boolean() }),
  ),
};
export type SavedFolder = z.infer<z.ZodObject<typeof SAVED_FOLDER_SHAPE>>;

const SavedLocalMarketplaceSchema = z.strictObject({
  name: MarketplaceNameSchema,
  ...SAVED_FOLDER_SHAPE,
  /** Its plugins installed in this setup's scope, installed again by pull (T29). */
  plugins: z.array(PluginEntrySchema),
});
type SavedLocalMarketplace = z.infer<typeof SavedLocalMarketplaceSchema>;

/** The bundle path of a saved local marketplace. */
const bundlePathOf = (name: string) => `${LOCAL_MARKETPLACES_PREFIX}${name}.json`;

/** A saved local marketplace as pull reads it; never throws. */
export const readSavedLocalMarketplace = (content: Uint8Array): JsonResult<SavedLocalMarketplace> =>
  parseJsonWith(SavedLocalMarketplaceSchema, content);

/**
 * `git` found on this PC, run so it never waits for an answer: no password prompt, ssh in
 * batch mode (unless the user set their own ssh command). `null` when git is not installed.
 */
export async function findGit(system: ExecutableLookupSystem): Promise<ProgramCli | null> {
  const git = await findExecutable(system, 'git');
  if (git === null) return null;
  const env = {
    ...system.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ALLOW_PROTOCOL: GIT_PROTOCOLS,
    ...(system.env['GIT_SSH_COMMAND'] === undefined && {
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    }),
  };
  return createProgramCli(git, { platform: system.platform, env }, { timeoutMs: 120_000 });
}

/** What push needs to save local marketplaces. */
export interface LocalMarketplaceCollect {
  readonly homedir: string;
  /** Finds `git` (`findGit`); without it, or without git, every folder is walked. */
  readonly git?: () => Promise<ProgramCli | null>;
  /** Told about each marketplace or file left out, with why, so push can say so. */
  readonly onSkipped?: (what: string, reason: string) => void;
}

/** `https://user:token@host/x` → `https://host/x`: a login never goes into the bundle. */
const withoutLogin = (remote: string) => remote.replace(/^(https?:\/\/)[^/@]*@/i, '$1');

/** Whether a path from the folder is inside a `.git` folder or a name push never takes. */
const leftOut = (path: string) =>
  path.split('/').some((part) => part.toLowerCase() === '.git' || SKIPPED_NAMES.has(part));

/**
 * Where a saved folder can be cloned from: the commit it is at, and the remote of a branch
 * that holds it. `null` when that commit is on no remote branch (not pushed yet).
 */
async function gitSourceOf(git: ProgramCli, folder: string): Promise<GitSource | null> {
  const head = await git.run(['rev-parse', 'HEAD'], folder);
  const branches = await git.run(['branch', '-r', '--contains', 'HEAD'], folder);
  if (head.exitCode !== 0 || branches.exitCode !== 0) return null;
  // `  origin/main`, never the `origin/HEAD -> origin/main` line.
  const branch = branches.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.includes(' -> '));
  const remoteName = branch?.split('/')[0];
  if (remoteName === undefined) return null;
  const url = await git.run(['remote', 'get-url', remoteName], folder);
  if (url.exitCode !== 0) return null;
  const parsed = GitSourceSchema.safeParse({
    remote: withoutLogin(url.stdout.trim()),
    commit: head.stdout.trim(),
  });
  return parsed.success ? parsed.data : null;
}

/** The files git lists in `folder`: tracked ones as they are now, and new ones not ignored. */
async function gitFiles(git: ProgramCli, folder: string): Promise<string[] | null> {
  const listed = await git.run(
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    folder,
  );
  if (listed.exitCode !== 0) return null;
  return [...new Set(listed.stdout.split('\0'))].filter((path) => path !== '').sort();
}

/** What `saveFolder` needs besides the folder. */
export interface FolderSave {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  /** `git` from `findGit`; `null`: the folder is walked. */
  readonly git: ProgramCli | null;
  readonly onSkipped?: ((what: string, reason: string) => void) | undefined;
}

/**
 * A folder's files as push saves them (T98, T99). In a git repository, only what git lists
 * (tracked files with their current edits, and new files that are not ignored); elsewhere the
 * whole folder. Never `.git/` or the names push always skips; links stay inside the folder.
 * `null`, said as `what`, when the folder is gone or larger than the server takes.
 */
export async function saveFolder(
  folder: string,
  named: { readonly name: string; readonly what: string },
  options: FolderSave,
): Promise<SavedFolder | null> {
  const path = pathsOf(options.platform);
  const { git } = options;
  const { what } = named;
  const info = await stat(folder).catch(() => null);
  if (!info?.isDirectory()) {
    options.onSkipped?.(what, `its folder ${folder} is missing`);
    return null;
  }
  const gatherer = createFileGatherer(options.platform, {
    skippedNames: SKIPPED_NAMES,
    homedir: options.homedir,
    within: folder,
    ...(options.onSkipped && {
      onSkipped: (file: string, reason: string) => options.onSkipped?.(`${what}: ${file}`, reason),
    }),
  });
  // `--show-prefix` is empty at the top of a repository, and fails outside one.
  const repo = git === null ? null : await git.run(['rev-parse', '--show-prefix'], folder);
  const listed = git !== null && repo?.exitCode === 0 ? await gitFiles(git, folder) : null;
  const files: CollectedFile[] = [];
  if (listed === null) {
    const prefix = named.name;
    for (const file of await gatherer.walk(folder, prefix, leftOut)) {
      files.push({ ...file, path: file.path.slice(prefix.length + 1) });
    }
  } else {
    for (const relative of listed.filter((file) => !leftOut(file))) {
      if (!BundlePathSchema.safeParse(relative).success) continue;
      const file = await gatherer.readIfFile(path.join(folder, ...relative.split('/')), relative);
      if (file) files.push(file);
    }
  }
  const size = files.reduce((total, file) => total + file.content.byteLength, 0);
  if (size > MAX_BUNDLE_BYTES) {
    options.onSkipped?.(
      what,
      `its files are ${formatSize(size)}, more than the ${formatSize(MAX_BUNDLE_BYTES)} a saved setup can hold. Ignore large files in git or move them out of the folder, then push again`,
    );
    return null;
  }
  const top = listed !== null && repo?.stdout.trim() === '';
  return {
    path: bundlePathInside(path, options.homedir, folder),
    git: top && git !== null ? await gitSourceOf(git, folder) : null,
    files: files.map((file) => ({
      path: file.path,
      content: Buffer.from(file.content).toString('base64'),
      executable: file.executable,
    })),
  };
}

/**
 * The saved files of each local marketplace with a plugin installed in the setup's scope
 * (T98), one reserved entry each, as `saveFolder` saves them. A marketplace larger than the
 * server takes, or whose folder is gone, is left out and said.
 */
export async function localMarketplaceFiles(
  input: PluginManifestInput,
  options: LocalMarketplaceCollect,
): Promise<CollectedFile[]> {
  const marketplaces = await readLocalMarketplaces(input);
  if (marketplaces.length === 0) return [];
  const save: FolderSave = {
    platform: input.platform,
    homedir: options.homedir,
    git: (await options.git?.()) ?? null,
    onSkipped: options.onSkipped,
  };
  const saved: CollectedFile[] = [];
  for (const marketplace of marketplaces) {
    const folder = await saveFolder(
      marketplace.folder,
      { name: marketplace.name, what: `marketplace ${marketplace.name}` },
      save,
    );
    if (folder === null) continue;
    const value: SavedLocalMarketplace = {
      name: marketplace.name,
      ...folder,
      plugins: [...marketplace.plugins],
    };
    saved.push(jsonFile(bundlePathOf(marketplace.name), value));
  }
  return saved;
}

/** A saved folder pull writes (T98, T99), and where. */
export interface FolderToWrite {
  /** How messages name it, e.g. `marketplace tools`. */
  readonly what: string;
  /** The folder pull writes, chosen here: never a path read from the bundle as it is (T44). */
  readonly dir: string;
  readonly files: readonly CollectedFile[];
  /** Re-cloned first; `null` when the folder is already there or nothing to clone from. */
  readonly clone: GitSource | null;
  /** The conflict key of one of its files, e.g. `.agentnomad/local-marketplaces/tools/x`. */
  keyOf(file: string): string;
}

/** A saved local marketplace pull writes, and where. */
interface MarketplaceToWrite extends FolderToWrite {
  readonly name: string;
  readonly plugins: readonly PluginEntry[];
  /** Not a marketplace here yet: Claude Code adds it from `dir`. */
  readonly add: boolean;
}

/** Where pull may write a saved folder on this PC (T98, T99). */
export interface FolderPlaceDeps {
  readonly homedir: string;
  /** Claude Code's base folder: a saved folder is never written inside it. */
  readonly baseDir: string;
  readonly platform: NodeJS.Platform;
}

/** What pull needs to write saved folders on this PC. */
export interface FolderWriteDeps {
  readonly platform: NodeJS.Platform;
  readonly restorer: Pick<ClaudeCodeRestorer, 'restoreFolder'>;
  readonly git: () => Promise<ProgramCli | null>;
}

/** What pull needs to write local marketplaces on this PC. */
export interface LocalMarketplaceRestoreDeps extends FolderPlaceDeps, FolderWriteDeps {
  /** This PC's `known_marketplaces.json` (`readKnownMarketplaces`). */
  readonly known: Readonly<
    Record<
      string,
      { readonly source: { readonly source: string; readonly path?: string | undefined } }
    >
  >;
  readonly validator: () => Promise<PluginValidator>;
}

/** What pull's plan step decided about the saved local marketplaces of one setup. */
export interface LocalMarketplacePlan {
  /** Marketplaces Claude Code adds from the folders pull writes. */
  readonly marketplaces: readonly MarketplaceEntry[];
  /** Their plugins to install, as T29 installs the others. */
  readonly plugins: readonly PluginEntry[];
  /** A plugin folder was declined in the review (T97), so a later push asks first. */
  readonly declined: boolean;
  /** Writes the folders, re-cloning first where it can; asks nothing. */
  restore(onConflict: ConflictResolver): Promise<RestoreReport>;
}

/** The folder of plugin `id` in a marketplace's files, from its catalog; `null`: not there. */
function pluginFolderOf(files: readonly CollectedFile[], id: string): string | null {
  const catalog = files.find((file) => file.path === '.claude-plugin/marketplace.json');
  const plugins = catalog
    ? valueOrNull(
        parseJsonWith(
          z.looseObject({
            plugins: z.array(z.looseObject({ name: z.string(), source: z.unknown() })),
          }),
          catalog.content,
        ),
      )?.plugins
    : undefined;
  const source = plugins?.find((plugin) => plugin.name === id.split('@')[0])?.source;
  if (typeof source !== 'string' || !source.startsWith('./')) return null;
  const parts = source.split('/').filter((part) => part !== '' && part !== '.');
  return parts.includes('..') ? null : parts.join('/');
}

/** `files` under `folder` (`''`: all), with paths from it. */
const filesUnder = (files: readonly CollectedFile[], folder: string): CollectedFile[] =>
  folder === ''
    ? [...files]
    : files
        .filter((file) => file.path.startsWith(`${folder}/`))
        .map((file) => ({ ...file, path: file.path.slice(folder.length + 1) }));

/** A saved folder's files as pull writes them. */
export const savedFolderFiles = (saved: SavedFolder): CollectedFile[] =>
  saved.files.map((file) => ({
    path: file.path,
    content: new Uint8Array(Buffer.from(file.content, 'base64')),
    executable: file.executable,
  }));

/**
 * Re-clones `source` into `dir`, which is not there: git's history and the saved commit, with
 * no files checked out, as pull writes the saved files next. On failure, `dir` is removed and
 * the reason returned.
 */
async function cloneInto(
  git: ProgramCli,
  source: GitSource,
  dir: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const parent = pathsOf(platform).dirname(dir);
  await mkdir(parent, { recursive: true });
  const said = (run: { exitCode: number; stderr: string }) =>
    run.stderr.trim().split(/\r?\n/)[0] || `exit code ${String(run.exitCode)}`;
  const cloned = await git.run(
    ['clone', '--no-checkout', '--quiet', '--', source.remote, dir],
    parent,
  );
  if (cloned.exitCode !== 0) {
    await rm(dir, { recursive: true, force: true });
    return said(cloned);
  }
  // HEAD and the index at the saved commit, the folder still empty: the saved files then
  // show as git showed them on the other PC (edits, new files).
  const reset = await git.run(['reset', '--quiet', source.commit], dir);
  if (reset.exitCode !== 0) {
    await rm(dir, { recursive: true, force: true });
    return said(reset);
  }
  return null;
}

/**
 * The folder for a saved folder on this PC: the same path from home, or `fallback` for one
 * that was outside home or would land in a refused place (keys, autostart folders, Claude
 * Code's own folder).
 */
export function homeFolderFor(
  savedPath: string | null,
  fallback: string,
  deps: FolderPlaceDeps,
): string {
  const path = pathsOf(deps.platform);
  if (savedPath === null || homePathProblem(savedPath) !== null) return fallback;
  const dir = path.join(deps.homedir, ...savedPath.split('/'));
  const inClaude =
    bundlePathInside(path, deps.baseDir, dir) !== null || path.relative(dir, deps.baseDir) === '';
  return inClaude ? fallback : dir;
}

/**
 * The folder for a saved marketplace on this PC: the one it is already added from here, or
 * `homeFolderFor` with `~/.agentnomad/marketplaces/<name>`.
 */
function folderFor(
  saved: SavedLocalMarketplace,
  deps: LocalMarketplaceRestoreDeps,
): { dir: string; add: boolean } | { problem: string } {
  const here = deps.known[saved.name];
  if (here !== undefined) {
    return here.source.source === 'directory' && here.source.path !== undefined
      ? { dir: here.source.path, add: false }
      : { problem: 'a marketplace with that name is already added here from another source' };
  }
  const fallback = pathsOf(deps.platform).join(
    deps.homedir,
    '.agentnomad',
    'marketplaces',
    saved.name,
  );
  return { dir: homeFolderFor(saved.path, fallback, deps), add: true };
}

export const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The parts of pull's plan context the saved local marketplaces need. */
export type LocalMarketplaceContext = Pick<
  RestorePlanContext,
  'files' | 'prompter' | 'reporter' | 'assumeYes' | 'allowCommands' | 'askConflict'
>;

/**
 * Each file of `folders` that is here and differs, asked as pull asks about the setup's files
 * (T34): the answers by conflict key.
 */
export async function askFolderConflicts(
  folders: readonly FolderToWrite[],
  context: Pick<RestorePlanContext, 'askConflict'>,
  platform: NodeJS.Platform,
): Promise<Map<string, ConflictChoice>> {
  const path = pathsOf(platform);
  const answers = new Map<string, ConflictChoice>();
  for (const folder of folders) {
    for (const file of folder.files) {
      const native = path.join(folder.dir, ...file.path.split('/'));
      const here = await readFile(native).catch(() => null);
      if (here === null || sameForRestore(platform, file.path, here, file.content)) continue;
      const key = folder.keyOf(file.path);
      const answer = await context.askConflict?.(key, {
        overwriteAllowed: true,
        message: `${printableLine(native)} already exists here and is different.`,
      });
      if (answer !== undefined) answers.set(key, answer);
    }
  }
  return answers;
}

/**
 * Writes `folders`, re-cloning a repository first where it can and writing the saved files
 * whatever happens, with the plan's `answers` (`askFolderConflicts`); asks nothing.
 */
export async function writeFolders(
  folders: readonly FolderToWrite[],
  answers: ReadonlyMap<string, ConflictChoice>,
  onConflict: ConflictResolver,
  deps: FolderWriteDeps,
): Promise<RestoreReport> {
  const report = {
    written: [] as string[],
    skipped: [] as string[],
    backups: [] as string[],
    warnings: [] as string[],
  };
  for (const folder of folders) {
    if (folder.files.length === 0) continue;
    if (folder.clone !== null) {
      const git = await deps.git();
      const failed =
        git === null
          ? 'git is not installed here'
          : await cloneInto(git, folder.clone, folder.dir, deps.platform);
      if (failed !== null) {
        report.warnings.push(
          `Could not re-clone the ${folder.what} from ${printableLine(folder.clone.remote)} (${printableLine(failed)}), so its saved files were written without git.`,
        );
      }
    }
    const written = await deps.restorer.restoreFolder(
      folder.dir,
      folder.files,
      (file, question) => {
        const key = folder.keyOf(file);
        const answer = answers.get(key);
        return answer === undefined ? onConflict(key, question) : Promise.resolve(answer);
      },
    );
    const named = (paths: readonly string[]) => paths.map((file) => folder.keyOf(file));
    report.written.push(...named(written.written));
    report.skipped.push(...named(written.skipped));
    report.backups.push(...named(written.backups));
    report.warnings.push(...written.warnings);
  }
  return report;
}

/**
 * Pull's questions about saved local marketplaces (T98), before anything is written: the
 * review of each plugin folder that would be added or changed (T97), then each file that is
 * here and differs (T34). The plan writes the folders, re-cloning a repository first when it
 * can and writing the saved files whatever happens, and names the marketplaces and plugins
 * for Claude Code to add and install.
 */
export async function planLocalMarketplaces(
  context: LocalMarketplaceContext,
  deps: LocalMarketplaceRestoreDeps,
): Promise<LocalMarketplacePlan> {
  const path = pathsOf(deps.platform);
  const toWrite: MarketplaceToWrite[] = [];
  for (const entry of context.files.filter((file) =>
    file.path.startsWith(LOCAL_MARKETPLACES_PREFIX),
  )) {
    const read = readSavedLocalMarketplace(entry.content);
    if (!('value' in read)) {
      context.reporter.warn(
        `The saved marketplace ${printableLine(entry.path)} could not be read: ${read.problem}`,
      );
      continue;
    }
    const saved = read.value;
    const place = folderFor(saved, deps);
    if ('problem' in place) {
      context.reporter.warn(`Skipped the saved marketplace ${saved.name}: ${place.problem}.`);
      continue;
    }
    const there = await exists(place.dir);
    toWrite.push({
      name: saved.name,
      what: `marketplace ${saved.name}`,
      dir: place.dir,
      files: savedFolderFiles(saved),
      plugins: saved.plugins,
      clone: there ? null : saved.git,
      add: place.add,
      keyOf: (file) => `${LOCAL_MARKETPLACES_PREFIX}${saved.name}/${file}`,
    });
  }

  // The review of each plugin folder that would be added or changed (T97).
  const folders: {
    folder: PluginFolderToReview;
    change: 'new' | 'changed';
    market: number;
    at: string;
  }[] = [];
  for (const [market, marketplace] of toWrite.entries()) {
    for (const plugin of marketplace.plugins) {
      const at = pluginFolderOf(marketplace.files, plugin.id);
      if (at === null) continue;
      const folder: PluginFolderToReview = {
        id: plugin.id,
        folder: printableLine(at === '' ? marketplace.dir : path.join(marketplace.dir, at)),
        files: filesUnder(marketplace.files, at),
      };
      if (folder.files.length === 0) continue;
      const change = await pluginFolderChange(path.join(marketplace.dir, ...at.split('/')), folder);
      if (change !== null) folders.push({ folder, change, market, at });
    }
  }
  const accepted =
    folders.length === 0
      ? new Set<string>()
      : await askPluginFolders(folders, await deps.validator(), context);
  const declinedIds = new Set(
    folders.filter(({ folder }) => !accepted.has(folder.folder)).map(({ folder }) => folder.id),
  );
  const plans = toWrite.map((marketplace, market) => {
    const declinedAt = folders
      .filter((entry) => entry.market === market && declinedIds.has(entry.folder.id))
      .map((entry) => entry.at);
    return {
      ...marketplace,
      files: marketplace.files.filter(
        (file) => !declinedAt.some((at) => at === '' || file.path.startsWith(`${at}/`)),
      ),
      plugins: marketplace.plugins.filter((plugin) => !declinedIds.has(plugin.id)),
    };
  });

  const answers = await askFolderConflicts(plans, context, deps.platform);
  return {
    marketplaces: plans
      .filter((marketplace) => marketplace.add && marketplace.plugins.length > 0)
      .map((marketplace) => ({ name: marketplace.name, add: marketplace.dir })),
    plugins: plans.flatMap((marketplace) => marketplace.plugins),
    declined: declinedIds.size > 0,
    restore: (onConflict) => writeFolders(plans, answers, onConflict, deps),
  };
}
