import type { AgentId } from '@agentnomad/contracts';

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
   * An agent's optional parts answered by flags, by part id (T61), e.g. `--account-skills` /
   * `--no-account-skills` → `account-skills`: save it or not instead of asking (default with
   * --yes: no).
   */
  readonly parts?: ReadonlyMap<string, boolean>;
}

export interface PullOptions extends ScopeFlags {
  readonly yes: boolean;
  /** `--merge` or `--overwrite`: one answer for every existing file instead of asking. */
  readonly conflict?: 'merge' | 'overwrite';
  /**
   * `--allow-commands`: accept new or changed hooks, status line, MCP servers and the scripts
   * they run, and install plugins and programs, without asking. `--yes` alone skips them.
   */
  readonly allowCommands?: boolean;
  /**
   * An agent's optional parts answered by flags, by part id (T61), e.g. `--account-skills` /
   * `--no-account-skills` → `account-skills`: add saved claude.ai skills as local skills or
   * not, instead of asking (default with --yes: no).
   */
  readonly parts?: ReadonlyMap<string, boolean>;
}

export interface DeleteOptions extends ScopeFlags {
  readonly yes: boolean;
}

export interface ConfirmOptions {
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
 * What each command does (T20 routes to these). Commands are built in later tasks and plugged
 * in here, so parsing and help never depend on how a command works.
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
