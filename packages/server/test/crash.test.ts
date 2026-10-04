import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { exitOnCrash } from '../src/logging/crash.ts';
import { memoryLogger } from './support/fixtures.ts';

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
