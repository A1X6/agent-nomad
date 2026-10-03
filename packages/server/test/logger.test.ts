import { describe, expect, it } from 'vitest';

import { describeError } from '../src/logging/logger.ts';

describe('describeError never logs query parameters (T47)', () => {
  it('keeps the SQL text and the database error, not the values', () => {
    const cause = Object.assign(new Error('connection lost'), { code: '08006' });
    const failed = Object.assign(
      new Error('Failed query: insert into "users" values ($1, $2)\nparams: ahmed,SECRET-HASH'),
      {
        name: 'DrizzleQueryError',
        query: 'insert into "users" values ($1, $2)',
        params: ['ahmed', 'SECRET-HASH'],
        cause,
      },
    );
    const fields = describeError(failed);
    expect(JSON.stringify(fields)).not.toContain('SECRET-HASH');
    expect(fields).toEqual({
      errorName: 'DrizzleQueryError',
      query: 'insert into "users" values ($1, $2)',
      causeName: 'Error',
      causeMessage: 'connection lost',
      causeCode: '08006',
    });
  });
});
