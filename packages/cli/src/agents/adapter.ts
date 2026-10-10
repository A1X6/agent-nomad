import type { AgentId, SourceOs } from '@agentnomad/contracts';

import type { Prompter, Reporter } from '../ui/prompter.ts';

/** Where a setup lives on this PC: the agent's global folder, or one project folder. */
export type ScopeTarget =
  { readonly kind: 'global' } | { readonly kind: 'project'; readonly projectDir: string };

/** What a Detector found on this PC. */
export interface DetectedAgent {
  readonly installed: boolean;
  /** Absolute base folder, e.g. `~/.claude` or `CLAUDE_CONFIG_DIR`; `null` when not installed. */
  readonly baseDir: string | null;
  /** Agent version, e.g. from `claude --version`; `null` when unknown. */
  readonly version: string | null;
}

/** Is the agent installed here, and where is its base folder (T24)? */
export interface Detector {
  detect(): Promise<DetectedAgent>;
}

/**
 * The bundle folder for reserved entries, which are not plain files of the agent's folder
 * (`.agentnomad/env.json`, an agent's own metadata): part of the bundle format for every
 * agent, so the generic code and each adapter build their paths from this one name (ARCH-01).
 */
export const RESERVED_DIR = '.agentnomad';

/** A file read from disk, ready to go into a bundle. */
export interface CollectedFile {
  /** Bundle path: relative to the base folder (global) or project root (project). */
  readonly path: string;
  readonly content: Uint8Array;
  readonly executable: boolean;
}

export interface CollectOptions {
  /** Include the agent's memory (what `memoryDescription` names). */
  readonly includeMemory: boolean;
  /** The adapter's optional parts (their `OptionalPart.id`) to include, e.g. `account-skills`. */
  readonly include?: ReadonlySet<string>;
  /** Told about each file left out, with why (T45: a link to a refused place, a huge file). */
  readonly onSkipped?: (bundlePath: string, reason: string) => void;
}

/** Which files belong to a setup. Never collects credentials or machine state (T25, T26). */
export interface Collector {
  collect(target: ScopeTarget, options: CollectOptions): Promise<readonly CollectedFile[]>;
}

/**
 * Something an agent saves only when the user opts in (T61), e.g. Claude Code's copy of the
 * user's claude.ai skills (T42). Push asks about each one; `--<id>` / `--no-<id>` answer it.
 */
export interface OptionalPart {
  /** Stable id, e.g. `account-skills`; also the flag name. */
  readonly id: string;
  /** The setup it belongs to. */
  readonly scope: ScopeTarget['kind'];
  /**
   * What there is to save on this PC, or why it cannot be read, and what to say before asking
   * (`notice`, e.g. what was left out and why).
   */
  available(): Promise<{
    readonly names: readonly string[];
    readonly problem: string | null;
    readonly notice?: string | null;
  }>;
  /** Push's question, e.g. `Also save a copy of your 2 claude.ai skills (a, b)? …`. */
  question(names: readonly string[]): string;
  /** Said when it cannot be read, given `available()`'s problem. */
  unreadable(problem: string): string;
  /** Said when a flag asks for it but there is nothing to save. */
  readonly noneFound: string;
  /** Help for its flags in push and in pull: what `--<id>` and `--no-<id>` do (ARCH-02). */
  readonly flagHelp: Readonly<Record<'push' | 'pull', PartFlagHelp>>;
}

interface PartFlagHelp {
  readonly include: string;
  readonly leaveOut: string;
}

/** The user's answer when a pulled file already exists here. */
export type ConflictChoice = 'merge' | 'overwrite' | 'skip';

export interface ConflictQuestion {
  /**
   * False for a file that must never be replaced, e.g. `~/.claude.json`, which also holds
   * the Claude login: then only merge or skip may be offered.
   */
  readonly overwriteAllowed: boolean;
  /** What to ask, when not `<path> already exists here and is different.` */
  readonly message?: string;
}

/** Answers (from the plan, never by asking) what to do with one existing file that differs. */
export type ConflictResolver = (
  path: string,
  question: ConflictQuestion,
) => Promise<ConflictChoice>;

/** One file here that differs from the pulled one, and what to ask about it (T61). */
export interface ConflictToAsk {
  /** Bundle path. */
  readonly path: string;
  readonly question: ConflictQuestion;
}

/**
 * Something in a setup that runs programs on this PC (T34, T44): a hook, an MCP server, a
 * script they run. Pull shows the new or changed ones and asks before writing them.
 */
export interface RunnableEntry {
  /** The bundle file it lives in, e.g. `settings.json` or `.mcp.json`. */
  readonly file: string;
  /** What it is, e.g. `hook PreToolUse`, `status line`, `MCP server github`. */
  readonly label: string;
  /** What runs, e.g. `~/.claude/hooks/check.sh` or `npx gh-mcp` or a URL. */
  readonly command: string;
  /** What is compared with this PC; the whole entry, so a change anywhere in it shows. */
  readonly identity: string;
}

export interface ReviewedEntry extends RunnableEntry {
  readonly change: 'new' | 'changed';
}

/**
 * Where an agent's setup refers to environment variables as `${VAR}` (T30): push offers to
 * save their values and `agentnomad env` lists them (ARCH-01).
 */
export interface EnvReferenceFiles {
  /** Bundle paths of files with MCP servers (an `mcpServers` object), e.g. `.mcp.json`. */
  readonly mcp: ReadonlySet<string>;
  /** Bundle paths of settings files; their `env` block sets variables for the agent. */
  readonly settings: ReadonlySet<string>;
  /** Variables the agent sets itself for hooks and servers; never the user's secrets. */
  readonly ownVariables: ReadonlySet<string>;
  /** A readable name for a file in messages, when its bundle path is not one. */
  label?(path: string): string;
}

/** What a restore did, for the summary shown to the user. Paths are bundle paths. */
export interface RestoreReport {
  readonly written: readonly string[];
  readonly skipped: readonly string[];
  /** Backups made before overwriting. */
  readonly backups: readonly string[];
  /** Things the user should know, e.g. a hook that will likely not run on this OS. */
  readonly warnings: readonly string[];
}

/** About the setup being restored. */
export interface RestoreContext {
  /** OS the setup was pushed from, to flag hooks that only run there. */
  readonly sourceOs?: SourceOs;
}

/**
 * Writes a pulled setup to disk, with per-OS permissions and line endings (T27), and tells
 * pull's plan step what it must ask first (T61). It never asks anything itself.
 */
export interface Restorer {
  /**
   * What in `files` runs programs and is new or changed against `current` (this PC's setup
   * as the collector sees it). Pull shows these and asks before writing (T34).
   */
  reviewRunnable(
    files: readonly CollectedFile[],
    current: readonly CollectedFile[],
  ): readonly ReviewedEntry[];
  /**
   * Environment variable names that send programs' requests elsewhere (a proxy, another
   * endpoint): pull gives saved values of these their own question (T44, T56).
   */
  isRedirectVariable(name: string): boolean;
  /** The files here that differ from the pulled ones, in the order `restore` meets them. */
  conflicts(
    files: readonly CollectedFile[],
    current: readonly CollectedFile[],
  ): readonly ConflictToAsk[];
  restore(
    target: ScopeTarget,
    files: readonly CollectedFile[],
    onConflict: ConflictResolver,
    context?: RestoreContext,
  ): Promise<RestoreReport>;
}

/**
 * Agent-specific checks that commands show to the user (T31, T32).
 * @public part of the adapter contract an agent implements (docs/ARCHITECTURE.md).
 */
export interface AgentInspector {
  /** Entries the collector does not know, e.g. a folder a newer agent version added. */
  unknownEntries(target: ScopeTarget): Promise<readonly string[]>;
  /** Things to point out before push, pull or `agents`, e.g. organization-managed settings. */
  notices(command: 'push' | 'pull' | 'agents'): Promise<readonly string[]>;
  /**
   * What pull says about the version a setup was saved with, and about what in its `files`
   * this PC's version cannot run (T103: mods); `null`: nothing to say.
   */
  versionNotice?(
    savedWith: string | null,
    here: string | null,
    files: readonly CollectedFile[],
  ): string | null;
  /** Lines push's summary adds about collected files, e.g. the plugins among them (T97). */
  pushNotes?(files: readonly CollectedFile[]): readonly string[];
}

/** What an agent's part of pull's plan step gets for one setup (T61). Nothing is written yet. */
export interface RestorePlanContext {
  readonly target: ScopeTarget;
  /** The files that will be restored, including agentnomad's own entries (plugins, programs). */
  readonly files: readonly CollectedFile[];
  /** The answer for each file here that differs, by bundle path. */
  readonly conflicts: ReadonlyMap<string, ConflictChoice>;
  /** The answer for every other file (flags or "… all remaining files"), if one was given. */
  readonly conflictAnswer: ConflictChoice | undefined;
  /**
   * Asks about one more file that is here and differs, as pull asks about the setup's files
   * (T98: a file the agent writes outside its folders); the same "… all remaining files"
   * answer holds. Without it, such a file gets `conflictAnswer`, or is left as it is.
   */
  readonly askConflict?: ConflictResolver;
  readonly prompter: Prompter;
  readonly reporter: Reporter;
  /** `--yes`: accept without asking where that is safe. */
  readonly assumeYes: boolean;
  /**
   * `--allow-commands`: also accept what installs or runs code (plugins, programs) without
   * asking. Without it, `--yes` skips those with a note (T38).
   */
  readonly allowCommands: boolean;
  /** Optional parts answered by flags (`--account-skills`): id → yes or no; missing: ask. */
  readonly parts: ReadonlyMap<string, boolean>;
}

/** What the follow-up after a restore gets: a reporter, and no prompter, so it never asks. */
export interface AfterRestoreContext {
  readonly reporter: Reporter;
}

/** An agent's answers for one pulled setup (T61); carrying them out never asks. */
export interface AgentRestorePlan {
  /** Writes the setup's files with the plan's answers (the restorer's `restore`). */
  restore(onConflict: ConflictResolver, context: RestoreContext): Promise<RestoreReport>;
  /** Runs after every planned setup was written, e.g. plugin reinstalls (T34). */
  afterRestore(context: AfterRestoreContext): Promise<void>;
  /**
   * The agent's questions left part of the setup out (T97: a declined plugin folder), so a
   * later push asks first, as after declined commands.
   */
  readonly declined?: boolean;
}

/**
 * Everything agentnomad knows about one agent. Adding an agent means writing one of these
 * and registering it; nothing else changes.
 */
export interface AgentAdapter {
  readonly id: AgentId;
  /** Shown to users, e.g. `Claude Code`. */
  readonly displayName: string;
  /** What push's memory question names, e.g. `what Claude learned: subagent and auto memory`. */
  readonly memoryDescription?: string;
  readonly detector: Detector;
  readonly collector: Collector;
  readonly restorer: Restorer;
  readonly inspector?: AgentInspector;
  /** Files that can use environment variables; without it, none are found or saved. */
  readonly envReferences?: EnvReferenceFiles;
  /** What push saves only after a yes (T61). */
  readonly optionalParts?: readonly OptionalPart[];
  /**
   * The agent's own questions for one pulled setup, asked in pull's plan step before
   * anything is written (T61): e.g. an open app that rewrites a file, plugins to reinstall.
   * Without it, the restorer writes the files and nothing follows.
   */
  planRestore?(context: RestorePlanContext): Promise<AgentRestorePlan>;
}

/** The only place agents are registered (T28). */
export interface AgentRegistry {
  list(): readonly AgentAdapter[];
  get(id: AgentId): AgentAdapter | undefined;
}

/** An agent chosen for a push or pull, with what its detector found. */
export interface ChosenAgent {
  readonly adapter: AgentAdapter;
  readonly version: string | null;
  readonly baseDir: string | null;
}

export const chosenAgent = (entry: {
  readonly adapter: AgentAdapter;
  readonly found: DetectedAgent;
}): ChosenAgent => ({
  adapter: entry.adapter,
  version: entry.found.version,
  baseDir: entry.found.baseDir,
});
