import { describeError, type Logger } from './logger.ts';

/** The part of `process` this needs, so tests can pass an EventEmitter. */
export interface CrashSource {
  on(
    event: 'uncaughtException' | 'unhandledRejection',
    listener: (error: unknown) => void,
  ): unknown;
}

/**
 * Turns an uncaught error or unhandled rejection into one clear log line and exit code 1
 * (BUG-02), instead of Node's multi-line stack on stderr. The host (Render) restarts the
 * process; carrying on after an unknown error could leave it in a broken state.
 */
export function exitOnCrash(
  source: CrashSource,
  logger: Logger,
  exit: (code: number) => void,
): void {
  for (const reason of ['uncaughtException', 'unhandledRejection'] as const) {
    source.on(reason, (error) => {
      logger.error('process_crashed', { reason, ...describeError(error) });
      exit(1);
    });
  }
}
