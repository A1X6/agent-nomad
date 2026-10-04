import { describe, expect, it } from 'vitest';

import { memorySecrets } from './fakes.ts';
import { ApiError, SessionExpiredError, withSession } from '../src/index.ts';

describe('sessions and messages', () => {
  it('an expired session clears the login and says to log in again', async () => {
    const { store, saved } = memorySecrets();
    saved.set('session-token', 'x').set('data-key', 'y');
    await expect(
      withSession(store, () => Promise.reject(new ApiError(401, 'unauthorized', 'expired'))),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    expect(saved.size).toBe(0);
  });

  it('other errors leave the login alone', async () => {
    const { store, saved } = memorySecrets();
    saved.set('session-token', 'x');
    await expect(
      withSession(store, () => Promise.reject(new ApiError(404, 'not_found', 'gone'))),
    ).rejects.toBeInstanceOf(ApiError);
    expect(saved.size).toBe(1);
  });
});
