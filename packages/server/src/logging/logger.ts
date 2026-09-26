/** Values safe to log. Never pass headers, bodies, tokens, keys or query strings. */
export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

/** Structured logs (T18): one JSON object per line, easy to search on any host. */
export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/** Writes one JSON line per event to the given sink (console by default). */
export function createJsonLogger(
  write: (line: string) => void = (line) => {
    console.log(line);
  },
  now: () => Date = () => new Date(),
): Logger {
  const emit = (level: 'info' | 'error', event: string, fields: LogFields = {}) => {
    write(JSON.stringify({ time: now().toISOString(), level, event, ...fields }));
  };
  return {
    info: (event, fields) => {
      emit('info', event, fields);
    },
    error: (event, fields) => {
      emit('error', event, fields);
    },
  };
}

/** What an unexpected error may put in the logs: its type and message, never extra data. */
export function describeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message, stack: error.stack };
  }
  return { errorName: typeof error };
}
