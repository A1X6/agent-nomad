import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { exitOnCrash } from '../src/logging/crash.ts';
import type { Logger } from '../src/logging/logger.ts';
import { createDatabasePool } from '../src/server.ts';

function memoryLogger() {
  const errors: { event: string; fields: Record<string, unknown> }[] = [];
  const logger: Logger = {
    info: () => undefined,
    error: (event, fields = {}) => errors.push({ event, fields }),
  };
  return { logger, errors };
}

describe('database pool errors (BUG-02)', () => {
  it('logs an error from an idle connection instead of crashing the process', async () => {
    const { logger, errors } = memoryLogger();
    const pool = createDatabasePool(
      'postgresql://user:hunter2@ep-example.eu-central-1.aws.neon.tech/neondb',
      logger,
    );
    // With no listener, Node throws an emitted 'error'; with one, emit returns normally.
    expect(() => pool.emit('error', new Error('connection dropped'))).not.toThrow();
    expect(errors.map((entry) => entry.event)).toEqual(['pool_error']);
    expect(errors[0]?.fields).toMatchObject({ errorMessage: 'connection dropped' });
    expect(JSON.stringify(errors)).not.toContain('hunter2');
    await pool.end();
  });
});

describe('exitOnCrash (BUG-02)', () => {
  it.each(['uncaughtException', 'unhandledRejection'])(
    'logs one clear line and exits with 1 on %s',
    (event) => {
      const { logger, errors } = memoryLogger();
      const target = new EventEmitter();
      const exits: number[] = [];
      exitOnCrash(target, logger, (code) => exits.push(code));

      target.emit(event, new Error('boom'));

      expect(errors.map((entry) => entry.event)).toEqual(['process_crashed']);
      expect(errors[0]?.fields).toMatchObject({ reason: event, errorMessage: 'boom' });
      expect(exits).toEqual([1]);
    },
  );

  it('also describes a rejection that is not an Error', () => {
    const { logger, errors } = memoryLogger();
    const target = new EventEmitter();
    exitOnCrash(target, logger, () => undefined);
    target.emit('unhandledRejection', 'plain text');
    expect(errors[0]?.fields).toMatchObject({ reason: 'unhandledRejection' });
  });
});
