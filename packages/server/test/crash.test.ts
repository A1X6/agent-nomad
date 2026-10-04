import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { exitOnCrash } from '../src/logging/crash.ts';
import { memoryLogger } from './support/fixtures.ts';

/** A stand-in process watched by exitOnCrash, and the errors it logs; `exit` gets the code. */
function watched(exit: (code: number) => void) {
  const { logger, errors } = memoryLogger();
  const target = new EventEmitter();
  exitOnCrash(target, logger, exit);
  return { target, errors };
}

describe('exitOnCrash (BUG-02)', () => {
  it.each(['uncaughtException', 'unhandledRejection'])(
    'logs one clear line and exits with 1 on %s',
    (event) => {
      const exits: number[] = [];
      const { target, errors } = watched((code) => exits.push(code));

      target.emit(event, new Error('boom'));

      expect(errors.map((entry) => entry.event)).toEqual(['process_crashed']);
      expect(errors[0]?.fields).toMatchObject({ reason: event, errorMessage: 'boom' });
      expect(exits).toEqual([1]);
    },
  );

  it('also describes a rejection that is not an Error', () => {
    const { target, errors } = watched(() => undefined);
    target.emit('unhandledRejection', 'plain text');
    expect(errors[0]?.fields).toMatchObject({ reason: 'unhandledRejection' });
  });
});
