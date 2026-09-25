import { CommanderError } from '@commander-js/extra-typings';

import { PromptCancelledError, type Reporter } from '../ui/prompter.ts';
import type { CommandHandlers } from './commands.ts';
import { describeError } from './error-messages.ts';
import { createProgram, type ProgramOutput } from './program.ts';

/** Exit codes: 0 done, 1 failed or bad usage, 130 cancelled with Ctrl+C (shell convention). */
export const EXIT = { ok: 0, failed: 1, cancelled: 130 } as const;

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
    deps.reporter.error(describeError(error));
    return EXIT.failed;
  }
}
