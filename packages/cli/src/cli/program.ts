import { Command, Option } from '@commander-js/extra-typings';

import { CLI_VERSION } from '../version.ts';
import type { CommandHandlers, ScopeFlags } from './commands.ts';
import { parseAgentList, parseProjectName } from './flags.ts';

/** Where commander writes help and errors; tests capture it instead of the terminal. */
export interface ProgramOutput {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface ProgramDeps {
  readonly handlers: CommandHandlers;
  readonly output?: ProgramOutput;
}

const EXAMPLES = `
Examples:
  agentnomad push                                   choose agents and scopes interactively
  agentnomad push --agent claude-code --global      save the global Claude Code setup
  agentnomad pull --agent claude-code --project my-saas-app
                                                    restore a project into the current folder
  agentnomad pull --global --merge --yes            restore without questions, merging files`;

/** `--agent`, `--global`, `--project`: shared by the commands that work on saved setups. */
function scopeOptions() {
  return [
    new Option('--agent <ids>', 'agents to use, comma-separated (e.g. claude-code)').argParser(
      parseAgentList,
    ),
    new Option('--global', 'the global setup (e.g. ~/.claude)'),
    new Option('--project <name>', 'a project setup, by the name it was saved under').argParser(
      parseProjectName,
    ),
  ] as const;
}

const yesOption = () => new Option('-y, --yes', 'accept defaults instead of asking');

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
 * The `agentnomad` command line (T20): every command from the PRD, its flags and help.
 * Parsing only; each command's work is done by the injected handlers.
 */
export function createProgram({ handlers, output }: ProgramDeps) {
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
  program
    .command('register')
    .description('create an account (there is no password recovery)')
    .action(() => handlers.register());

  program
    .command('login')
    .description('log in on this PC')
    .action(() => handlers.login());

  program
    .command('logout')
    .description('log out on this PC')
    .action(() => handlers.logout());

  const [pushAgent, pushGlobal, pushProject] = scopeOptions();
  program
    .command('push')
    .description('save setups to the cloud (encrypted on this PC first)')
    .addOption(pushAgent)
    .addOption(pushGlobal)
    .addOption(pushProject)
    .addOption(yesOption())
    .action((options) => handlers.push({ ...scope(options), yes: options.yes === true }));

  const [pullAgent, pullGlobal, pullProject] = scopeOptions();
  program
    .command('pull')
    .description('restore saved setups onto this PC (a project goes into the current folder)')
    .addOption(pullAgent)
    .addOption(pullGlobal)
    .addOption(pullProject)
    .addOption(yesOption())
    .addOption(
      new Option(
        '--merge',
        'merge with existing files (JSON by key, others side by side)',
      ).conflicts('overwrite'),
    )
    .addOption(new Option('--overwrite', 'replace existing files (the old ones are backed up)'))
    .action((options) =>
      handlers.pull({
        ...scope(options),
        yes: options.yes === true,
        ...(options.merge && { conflict: 'merge' as const }),
        ...(options.overwrite && { conflict: 'overwrite' as const }),
      }),
    );

  program
    .command('list')
    .description('show saved setups, grouped by agent')
    .action(() => handlers.list());

  program
    .command('agents')
    .description('show supported agents and which are installed here')
    .action(() => handlers.agents());

  const [statusAgent, statusGlobal, statusProject] = scopeOptions();
  program
    .command('status')
    .description('show whether this PC matches the saved setup')
    .addOption(statusAgent)
    .addOption(statusGlobal)
    .addOption(statusProject)
    .action((options) => handlers.status(scope(options)));

  const [deleteAgent, deleteGlobal, deleteProject] = scopeOptions();
  program
    .command('delete')
    .description('remove saved setups from the cloud (files on this PC are not touched)')
    .addOption(deleteAgent)
    .addOption(deleteGlobal)
    .addOption(deleteProject)
    .addOption(yesOption())
    .action((options) => handlers.delete({ ...scope(options), yes: options.yes === true }));

  const account = program.command('account').description('manage your account');
  account
    .command('delete')
    .description('delete your account and every saved setup (cannot be undone)')
    .addOption(yesOption())
    .action((options) => handlers.accountDelete({ yes: options.yes === true }));

  program
    .command('env')
    .description(
      'show which environment variables your setups use (e.g. API keys) and which are set here',
    )
    .action(() => handlers.env());

  return program;
}
