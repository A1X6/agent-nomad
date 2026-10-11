import { MAX_BUNDLE_BYTES } from '@agentnomad/contracts';
import { Command, Option, type CommandUnknownOpts } from '@commander-js/extra-typings';

import type { OptionalPart } from '../agents/adapter.ts';
import { formatSize } from '../ui/format-size.ts';
import { CLI_VERSION } from '../version.ts';
import type { CommandHandlers, CredentialOptions, ScopeFlags } from './commands.ts';
import { parseAgentList, parseEnvValues, parseProjectName, parseUsername } from './flags.ts';
import {
  COMMAND_HELP,
  contentsHelp,
  FLAG_HELP,
  type AgentHelp,
  type ChosenFlag,
} from './help-text.ts';

/** Where commander writes help and errors; tests capture it instead of the terminal. */
export interface ProgramOutput {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

/** An agent's optional part as the command line needs it: its id and its flags' help. */
export type PartFlags = Pick<OptionalPart, 'id' | 'flagHelp'>;

export interface ProgramDeps {
  readonly handlers: CommandHandlers;
  /**
   * The registered agents' optional parts (T61): each gets `--<id>` and `--no-<id>` in push
   * and pull (ARCH-02). A part id two agents share gets one pair of flags.
   */
  readonly optionalParts: readonly PartFlags[];
  /** What each registered agent's setups hold, for push's and pull's `--help` (T115). */
  readonly agents?: readonly AgentHelp[];
  readonly output?: ProgramOutput;
}

const EXAMPLES = `
Examples:
  agentnomad push                                   choose agents and scopes interactively
  agentnomad push --agent claude-code --global      save the global Claude Code setup
  agentnomad pull --agent claude-code --project my-saas-app
                                                    restore a project into the current folder
  agentnomad pull --global --merge --yes            restore without questions, merging files;
                                                    new hooks and commands are skipped
  agentnomad pull --global --yes --allow-commands   also accept new hooks, MCP servers and
                                                    installs (only for setups you trust)
  echo "$PASSWORD" | agentnomad login --username me --password-stdin
                                                    log in from a script

With no terminal (a script or CI), nothing is asked: a question the flags do not
answer stops the command with exit code 1 and names the flags to add. Push and pull
also exit with code 1 when a setup was skipped or refused without a "no" from you
(a newer or older copy, over ${formatSize(MAX_BUNDLE_BYTES)}, or skipped by --yes); the rest is done first.`;

/** `--<id>` and `--no-<id>` for each optional part, with the command's help texts. */
function addPartOptions(
  command: CommandUnknownOpts,
  parts: readonly PartFlags[],
  which: 'push' | 'pull',
): void {
  for (const part of parts) {
    command.addOption(new Option(`--${part.id}`, part.flagHelp[which].include));
    command.addOption(new Option(`--no-${part.id}`, part.flagHelp[which].leaveOut));
  }
}

/** The optional parts as push's or pull's "only when you choose" help lines (T115). */
function partLines(parts: readonly PartFlags[], which: 'push' | 'pull'): ChosenFlag[] {
  return parts.map((part) => ({ flag: `--${part.id}`, help: part.flagHelp[which].include }));
}

/** The part flags given, mapped to the part's id (T61). */
function partsOf(
  command: CommandUnknownOpts,
  parts: readonly PartFlags[],
): { parts?: ReadonlyMap<string, boolean> } {
  const given = new Map<string, boolean>();
  for (const part of parts) {
    const value = command.getOptionValue(new Option(`--${part.id}`).attributeName());
    if (typeof value === 'boolean') given.set(part.id, value);
  }
  return given.size === 0 ? {} : { parts: given };
}

/** `--agent`, `--global`, `--project`: shared by the commands that work on saved setups. */
function scopeOptions() {
  return [
    new Option('--agent <ids>', FLAG_HELP.agent).argParser(parseAgentList),
    new Option('--global', FLAG_HELP.global),
    new Option('--project <name>', FLAG_HELP.project).argParser(parseProjectName),
  ] as const;
}

/** `-y, --yes`: in each command that would otherwise ask, with what it answers there. */
function yesOption(command: keyof typeof FLAG_HELP.yes) {
  return new Option('-y, --yes', FLAG_HELP.yes[command]);
}

/** `--env-values`: which environment values push saves or pull adds (T115). */
function envValuesOption(command: 'push' | 'pull') {
  return new Option('--env-values <names|all|none>', FLAG_HELP.envValues[command]).argParser(
    parseEnvValues,
  );
}

/** `--username`, `--password-stdin`: register, login and account delete from a script. */
function credentialOptions() {
  return [
    new Option('--username <name>', 'your username, instead of typing it').argParser(parseUsername),
    new Option(
      '--password-stdin',
      'read the password from the first line of standard input (never pass it as an argument)',
    ),
  ] as const;
}

function credentials(options: {
  username?: string | undefined;
  passwordStdin?: true | undefined;
  yes?: true | undefined;
}): CredentialOptions {
  return {
    yes: options.yes === true,
    passwordStdin: options.passwordStdin === true,
    ...(options.username !== undefined && { username: options.username }),
  };
}

function scope(options: {
  agent?: string[] | undefined;
  global?: true | undefined;
  project?: string | undefined;
}): ScopeFlags {
  return {
    global: options.global === true,
    ...(options.agent !== undefined && { agents: options.agent }),
    ...(options.project !== undefined && { project: options.project }),
  };
}

/**
 * The `agentnomad` command line (T20): every command, its flags and help.
 * Parsing only; each command's work is done by the injected handlers.
 */
export function createProgram({ handlers, optionalParts, agents = [], output }: ProgramDeps) {
  const parts = [...new Map(optionalParts.map((part) => [part.id, part])).values()];
  const program = new Command('agentnomad')
    .description(
      'Save your AI agent setup to the cloud, encrypted on your PC, and restore it on any other PC.\nThe server can never read your data. There is no password recovery: keep your password safe.',
    )
    .version(CLI_VERSION, '-v, --version', 'show the version')
    .helpOption('-h, --help', 'show help')
    .helpCommand('help [command]', 'show help for a command')
    .showSuggestionAfterError()
    .showHelpAfterError('(run agentnomad --help for usage)')
    // Throw instead of exiting, so runCli decides the exit code (and tests can run it).
    .exitOverride();
  if (output) program.configureOutput(output);
  program.addHelpText('after', EXAMPLES);

  // Settings above are copied to every command added below.
  const [registerUsername, registerPassword] = credentialOptions();
  program
    .command('register')
    .description(COMMAND_HELP.register)
    .addOption(registerUsername)
    .addOption(registerPassword)
    .addOption(
      new Option(
        '-y, --yes',
        'accept that there is no password recovery, and replace a login already on this PC',
      ),
    )
    .action((options) => handlers.register(credentials(options)));

  const [loginUsername, loginPassword] = credentialOptions();
  program
    .command('login')
    .description(COMMAND_HELP.login)
    .addOption(loginUsername)
    .addOption(loginPassword)
    .addOption(new Option('-y, --yes', 'replace a login already on this PC without asking'))
    .action((options) => handlers.login(credentials(options)));

  program
    .command('logout')
    .description(COMMAND_HELP.logout)
    .action(() => handlers.logout());

  const [pushAgent, pushGlobal, pushProject] = scopeOptions();
  const push = program
    .command('push')
    .description(COMMAND_HELP.push)
    .addOption(pushAgent)
    .addOption(pushGlobal)
    .addOption(pushProject)
    .addOption(new Option('--memory', FLAG_HELP.memory))
    .addOption(new Option('--no-memory', FLAG_HELP.noMemory))
    .addOption(envValuesOption('push'));
  addPartOptions(push, parts, 'push');
  push
    .addOption(yesOption('push'))
    .addHelpText(
      'after',
      contentsHelp('push', agents, [
        { flag: '--memory', help: FLAG_HELP.memory },
        { flag: '--env-values', help: FLAG_HELP.envValues.push },
        ...partLines(parts, 'push'),
      ]),
    )
    .action((options, command) =>
      handlers.push({
        ...scope(options),
        yes: options.yes === true,
        ...(options.memory !== undefined && { memory: options.memory }),
        ...(options.envValues !== undefined && { envValues: options.envValues }),
        ...partsOf(command, parts),
      }),
    );

  const [pullAgent, pullGlobal, pullProject] = scopeOptions();
  const pull = program
    .command('pull')
    .description(COMMAND_HELP.pull)
    .addOption(pullAgent)
    .addOption(pullGlobal)
    .addOption(pullProject)
    .addOption(yesOption('pull'))
    .addOption(new Option('--merge', FLAG_HELP.merge).conflicts(['overwrite', 'skipExisting']))
    .addOption(new Option('--overwrite', FLAG_HELP.overwrite).conflicts('skipExisting'))
    .addOption(new Option('--skip-existing', FLAG_HELP.skipExisting))
    .addOption(new Option('--allow-commands', FLAG_HELP.allowCommands))
    .addOption(envValuesOption('pull'));
  addPartOptions(pull, parts, 'pull');
  pull
    .addHelpText(
      'after',
      contentsHelp('pull', agents, [
        { flag: '--env-values', help: FLAG_HELP.envValues.pull },
        { flag: '--allow-commands', help: FLAG_HELP.allowCommands },
        ...partLines(parts, 'pull'),
      ]),
    )
    .action((options, command) =>
      handlers.pull({
        ...scope(options),
        yes: options.yes === true,
        ...(options.allowCommands && { allowCommands: true }),
        ...(options.envValues !== undefined && { envValues: options.envValues }),
        ...partsOf(command, parts),
        ...(options.merge && { conflict: 'merge' as const }),
        ...(options.overwrite && { conflict: 'overwrite' as const }),
        ...(options.skipExisting && { conflict: 'skip' as const }),
      }),
    );

  program
    .command('list')
    .description(COMMAND_HELP.list)
    .action(() => handlers.list());

  program
    .command('agents')
    .description(COMMAND_HELP.agents)
    .action(() => handlers.agents());

  const [statusAgent, statusGlobal, statusProject] = scopeOptions();
  program
    .command('status')
    .description(COMMAND_HELP.status)
    .addOption(statusAgent)
    .addOption(statusGlobal)
    .addOption(statusProject)
    .action((options) => handlers.status(scope(options)));

  const [deleteAgent, deleteGlobal, deleteProject] = scopeOptions();
  program
    .command('delete')
    .description(COMMAND_HELP.delete)
    .addOption(deleteAgent)
    .addOption(deleteGlobal)
    .addOption(deleteProject)
    .addOption(yesOption('delete'))
    .action((options) => handlers.delete({ ...scope(options), yes: options.yes === true }));

  const account = program.command('account').description(COMMAND_HELP.account);
  const [deleteUsername, deletePassword] = credentialOptions();
  account
    .command('delete')
    .description(COMMAND_HELP['account delete'])
    .addOption(deleteUsername)
    .addOption(deletePassword)
    .addOption(
      new Option('-y, --yes', 'confirm the deletion when username and password come from flags'),
    )
    .action((options) => handlers.accountDelete(credentials(options)));

  program
    .command('env')
    .description(COMMAND_HELP.env)
    .action(() => handlers.env());

  return program;
}
