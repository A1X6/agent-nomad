import { CommanderError } from '@commander-js/extra-typings';

import { AnswerNeededError } from '../ui/no-terminal-prompter.ts';
import { PromptCancelledError, type Reporter } from '../ui/prompter.ts';
import type { CommandHandlers } from './commands.ts';
import { describeError } from './error-messages.ts';
import { createProgram, type ProgramOutput } from './program.ts';

/**
 * Exit codes: 0 done; 1 failed, bad usage, or a question with no terminal to ask in;
 * 130 cancelled with Ctrl+C (shell convention).
 */
export const EXIT = { ok: 0, failed: 1, cancelled: 130 } as const;

/** Per command: the flags that answer its questions when there is no terminal (T36). */
export const ANSWER_FLAGS: Readonly<Record<string, string>> = {
  register: 'Use --username, --password-stdin and --yes.',
  login: 'Use --username and --password-stdin (and --yes to replace a login already here).',
  push: 'Use --agent, --global or --project <name>, --memory or --no-memory, --account-skills or --no-account-skills, and --yes.',
  pull: 'Use --agent, --global or --project <name>, --merge or --overwrite, --allow-commands, --account-skills or --no-account-skills, and --yes.',
  delete: 'Use --global or --project <name>, and --yes.',
  'account delete': 'Use --username, --password-stdin and --yes.',
};

/** The one line shown when a question could not be asked. */
export function describeAnswerNeeded(
  error: AnswerNeededError,
  command: string | undefined,
): string {
  const hint = command === undefined ? undefined : ANSWER_FLAGS[command];
  const help = command === undefined ? 'agentnomad --help' : `agentnomad ${command} --help`;
  return `${error.message} ${hint ?? 'Answer it with flags.'} See \`${help}\`.`;
}

export interface RunDeps {
  readonly handlers: CommandHandlers;
  readonly reporter: Pick<Reporter, 'error' | 'warn'>;
  readonly output?: ProgramOutput;
}

/**
 * Runs one CLI invocation and returns the exit code; never exits the process itself, so it
 * can be tested and every failure ends in one place.
 */
export async function runCli(args: readonly string[], deps: RunDeps): Promise<number> {
  const program = createProgram({
    handlers: deps.handlers,
    ...(deps.output && { output: deps.output }),
  });
  // Which command runs, e.g. `account delete`, for the "needs an answer" hint.
  let command: string | undefined;
  program.hook('preAction', (_program, action) => {
    // Walk up to (not including) the root `agentnomad` command.
    const names: string[] = [];
    for (let current = action; current.parent; current = current.parent)
      names.unshift(current.name());
    command = names.join(' ');
  });
  try {
    await program.parseAsync([...args], { from: 'user' });
    return EXIT.ok;
  } catch (error) {
    // Help, version and usage errors: commander has already printed its message.
    if (error instanceof CommanderError) return error.exitCode;
    if (error instanceof PromptCancelledError) {
      deps.reporter.warn('Cancelled.');
      return EXIT.cancelled;
    }
    if (error instanceof AnswerNeededError) {
      deps.reporter.error(describeAnswerNeeded(error, command));
      return EXIT.failed;
    }
    deps.reporter.error(describeError(error));
    return EXIT.failed;
  }
}
