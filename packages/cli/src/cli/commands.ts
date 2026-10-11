import type { AgentId } from '@agentnomad/contracts';

/** `--env-values` (T115): these variables by name, every one there is (`all`), or none. */
export type EnvValuesChoice = 'all' | 'none' | readonly string[];

/** Which saved setups a command works on. Anything not given is asked for interactively. */
export interface ScopeFlags {
  /** `--agent`: skip the agent checklist. */
  readonly agents?: readonly AgentId[];
  /** `--global`: the global setup. */
  readonly global: boolean;
  /** `--project <name>`: one project setup. */
  readonly project?: string;
}

export interface PushOptions extends ScopeFlags {
  /** `--yes`: accept defaults instead of asking. */
  readonly yes: boolean;
  /** `--memory` / `--no-memory`: include memory or not, instead of asking (default with --yes: no). */
  readonly memory?: boolean;
  /**
   * `--env-values`: which environment values to save with each setup instead of asking; only
   * ones the setup uses and this PC has (default with --yes: none).
   */
  readonly envValues?: EnvValuesChoice;
  /**
   * An agent's optional parts answered by flags, by part id (T61), e.g. `--account-skills` /
   * `--no-account-skills` → `account-skills`: save it or not instead of asking (with --yes:
   * the part's `defaultYes`, T114: claude.ai skills and plugins yes, plugin data no).
   */
  readonly parts?: ReadonlyMap<string, boolean>;
}

export interface PullOptions extends ScopeFlags {
  readonly yes: boolean;
  /**
   * `--merge`, `--overwrite` or `--skip-existing`: one answer for every file here that differs,
   * instead of asking (default with --yes: merge).
   */
  readonly conflict?: 'merge' | 'overwrite' | 'skip';
  /**
   * `--allow-commands`: accept new or changed hooks, status line, MCP servers and the scripts
   * they run, and install plugins and programs, without asking. `--yes` alone skips them.
   */
  readonly allowCommands?: boolean;
  /**
   * `--env-values`: which saved environment values missing here to add, instead of asking
   * (default with --yes: every plain one). One that loads code or redirects requests still
   * needs `--allow-commands` or a yes.
   */
  readonly envValues?: EnvValuesChoice;
  /**
   * An agent's optional parts answered by flags, by part id (T61), e.g. `--account-skills` /
   * `--no-account-skills` → `account-skills`: add saved claude.ai skills as local skills or
   * not, instead of asking (with --yes, T114: claude.ai skills and plugins yes, plugin data no).
   */
  readonly parts?: ReadonlyMap<string, boolean>;
}

interface DeleteOptions extends ScopeFlags {
  readonly yes: boolean;
}

interface ConfirmOptions {
  readonly yes: boolean;
}

/** Answers for register, login and account delete, so they can run from a script (T36). */
export interface CredentialOptions extends ConfirmOptions {
  /** `--username <name>`: instead of typing it. */
  readonly username?: string;
  /** `--password-stdin`: read the password from the first line of standard input. */
  readonly passwordStdin: boolean;
}

/**
 * What each command does (T20 routes to these). The handlers are plugged in here, so parsing
 * and help never depend on how a command works.
 */
export interface CommandHandlers {
  register(options: CredentialOptions): Promise<void>;
  login(options: CredentialOptions): Promise<void>;
  logout(): Promise<void>;
  push(options: PushOptions): Promise<void>;
  pull(options: PullOptions): Promise<void>;
  list(): Promise<void>;
  agents(): Promise<void>;
  status(options: ScopeFlags): Promise<void>;
  delete(options: DeleteOptions): Promise<void>;
  accountDelete(options: CredentialOptions): Promise<void>;
  env(): Promise<void>;
}
