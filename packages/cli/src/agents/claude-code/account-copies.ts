import type { CollectedFile, RestorePlanContext } from '../adapter.ts';

/*
 * What saved claude.ai skills (T42) and plugins (T101) share on pull (DUP-01): which saved
 * copies pull may add as folders in `~/.claude/skills/`, and the question about them. Both are
 * planned in pull's plan step, so the plugin review (T97) sees every folder they add (SEC-03).
 */

/** Why push leaves out a skill or plugin whose name is no folder name in `skills/`. */
export const NAME_NOT_A_FOLDER = 'its name cannot be a folder in ~/.claude/skills';

/** Names on this PC a saved claude.ai skill or plugin must not take, lower case. */
export interface NamesHere {
  /** Plugins and skills this PC already gets from its own claude.ai sync. */
  readonly syncedNames: ReadonlySet<string>;
  /** Folders in `~/.claude/skills/` (local skills and plugins), with those the pull writes. */
  readonly localNames: ReadonlySet<string>;
}

/** One saved skill or plugin: its folder name and its files, with paths from that folder. */
export interface SavedCopy {
  readonly name: string;
  readonly files: readonly CollectedFile[];
}

/**
 * The copies saved one folder each under `prefix` (`<prefix><name>/...`), sorted by name,
 * without the files `leaveOut` names (paths from the folder) and names `usable` refuses.
 */
export function savedCopiesIn(
  prefix: string,
  bundleFiles: readonly CollectedFile[],
  usable: (name: string) => boolean,
  leaveOut: (path: string) => boolean = () => false,
): SavedCopy[] {
  const byName = new Map<string, CollectedFile[]>();
  for (const file of bundleFiles) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    const name = rest.split('/')[0] ?? '';
    if (!usable(name) || rest === name) continue;
    const path = rest.slice(name.length + 1);
    if (leaveOut(path)) continue;
    const files = byName.get(name);
    if (files === undefined) byName.set(name, [{ ...file, path }]);
    else files.push({ ...file, path });
  }
  return sortedCopies([...byName].map(([name, files]) => ({ name, files })));
}

/** Copies sorted by name, as pull lists them. */
export const sortedCopies = (copies: readonly SavedCopy[]): SavedCopy[] =>
  [...copies].sort((a, b) => a.name.localeCompare(b.name));

/** What pull may add of some saved copies. */
export interface SavedCopiesPlan {
  /** Copies that can be added here. */
  readonly toAdd: readonly SavedCopy[];
  /** Copies left out, with why. */
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

/**
 * Which saved copies pull may add as `skills/<name>/`: not one this PC already gets from its
 * own claude.ai sync, never over a local folder of the same name (`localReason` says what it
 * is), nor one `problem` refuses.
 */
export function planSavedCopies(
  copies: readonly SavedCopy[],
  here: NamesHere,
  localReason: string,
  problem: (copy: SavedCopy) => string | null = () => null,
): SavedCopiesPlan {
  const toAdd: SavedCopy[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const copy of copies) {
    const reason = here.syncedNames.has(copy.name.toLowerCase())
      ? 'this PC already gets it from claude.ai'
      : here.localNames.has(copy.name.toLowerCase())
        ? localReason
        : problem(copy);
    if (reason === null) toAdd.push(copy);
    else skipped.push({ name: copy.name, reason });
  }
  return { toAdd, skipped };
}

/** A copy's files as global bundle paths, `skills/<name>/...`. */
export const filesInSkills = (copies: readonly SavedCopy[]): CollectedFile[] =>
  copies.flatMap((copy) =>
    copy.files.map((file) => ({ ...file, path: `skills/${copy.name}/${file.path}` })),
  );

/** The words pull uses about one kind of saved copy. */
export interface SavedCopyWords {
  /** The heading of the list, e.g. `Skills from your claude.ai account on the other PC:`. */
  readonly heading: string;
  /** A copy's line in the list, after `  + `. */
  readonly line: (copy: SavedCopy) => string;
  /** The question, answered yes by default (T114). */
  readonly question: string;
  /** The optional part (T61) whose flag answers the question, e.g. `account-skills`. */
  readonly part: string;
}

/** What the plan step gives the question about saved copies (T61). */
export type SavedCopiesContext = Pick<
  RestorePlanContext,
  'files' | 'prompter' | 'reporter' | 'assumeYes' | 'parts'
>;

/**
 * Lists the plan and asks whether to add the copies, yes by default, unless the part's flag
 * or `--yes` answers (T114). `answered`: a flag or `--yes` answered, not a person; `add`: false
 * after a no, said with how to add them later.
 */
export async function askSavedCopies(
  context: SavedCopiesContext,
  plan: SavedCopiesPlan,
  words: SavedCopyWords,
): Promise<{ readonly add: boolean; readonly answered: boolean }> {
  if (plan.toAdd.length === 0 && plan.skipped.length === 0) return { add: false, answered: true };
  context.reporter.info(
    [
      words.heading,
      ...plan.toAdd.map((copy) => `  + ${words.line(copy)}`),
      ...plan.skipped.map((copy) => `  - ${copy.name}: skipped, ${copy.reason}`),
    ].join('\n'),
  );
  if (plan.toAdd.length === 0) return { add: false, answered: true };
  const flag = context.parts.get(words.part);
  const answered = flag !== undefined || context.assumeYes;
  const add = flag ?? (context.assumeYes || (await context.prompter.confirm(words.question, true)));
  if (!add) {
    context.reporter.info(`Not added. To add them later: agentnomad pull --global --${words.part}`);
  }
  return { add, answered };
}
