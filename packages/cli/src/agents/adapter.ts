import type { AgentId } from '@agentnomad/contracts';

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

/** A file read from disk, ready to go into a bundle. */
export interface CollectedFile {
  /** Bundle path: relative to the base folder (global) or project root (project). */
  readonly path: string;
  readonly content: Uint8Array;
  readonly executable: boolean;
}

export interface CollectOptions {
  /** Include opt-in memory folders (subagent and auto memory). */
  readonly includeMemory: boolean;
}

/** Which files belong to a setup. Never collects credentials or machine state (T25, T26). */
export interface Collector {
  collect(target: ScopeTarget, options: CollectOptions): Promise<readonly CollectedFile[]>;
}

/** The user's answer when a pulled file already exists here. */
export type ConflictChoice = 'merge' | 'overwrite' | 'skip';

/** Asks (or decides from flags) what to do with one existing file. */
export type ConflictResolver = (path: string) => Promise<ConflictChoice>;

/** What a restore did, for the summary shown to the user. Paths are bundle paths. */
export interface RestoreReport {
  readonly written: readonly string[];
  readonly skipped: readonly string[];
  /** Backups made before overwriting. */
  readonly backups: readonly string[];
}

/** Writes a pulled setup to disk, with per-OS permissions and line endings (T27). */
export interface Restorer {
  restore(
    target: ScopeTarget,
    files: readonly CollectedFile[],
    onConflict: ConflictResolver,
  ): Promise<RestoreReport>;
}

/**
 * Everything agentnomad knows about one agent. Adding an agent means writing one of these
 * and registering it; nothing else changes.
 */
export interface AgentAdapter {
  readonly id: AgentId;
  /** Shown to users, e.g. `Claude Code`. */
  readonly displayName: string;
  readonly detector: Detector;
  readonly collector: Collector;
  readonly restorer: Restorer;
}

/** The only place agents are registered (T28). */
export interface AgentRegistry {
  list(): readonly AgentAdapter[];
  get(id: AgentId): AgentAdapter | undefined;
}
