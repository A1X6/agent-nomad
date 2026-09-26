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
   * `--account-skills` / `--no-account-skills`: save a copy of your own claude.ai skills or not,
   * instead of asking (default with --yes: no) (T42).
   */
  readonly accountSkills?: boolean;
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
   * `--account-skills` / `--no-account-skills`: add saved claude.ai skills as local skills or
   * not, instead of asking (default with --yes: no) (T42).
   */
  readonly accountSkills?: boolean;
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

/** The command exists but is built in a later task. */
export class NotAvailableYetError extends Error {
  constructor(command: string, task: string) {
    super(`"agentnomad ${command}" is not available yet (coming in ${task}).`);
    this.name = 'NotAvailableYetError';
  }
}

const later = (command: string, task: string) => () =>
  Promise.reject(new NotAvailableYetError(command, task));

/** Placeholders until each command's task replaces it. */
export const NOT_YET_AVAILABLE: CommandHandlers = {
  register: later('register', 'T23'),
  login: later('login', 'T23'),
  logout: later('logout', 'T23'),
  push: later('push', 'T33'),
  pull: later('pull', 'T34'),
  list: later('list', 'T35'),
  agents: later('agents', 'T35'),
  status: later('status', 'T35'),
  delete: later('delete', 'T35'),
  accountDelete: later('account delete', 'T35'),
  env: later('env', 'T30'),
};
