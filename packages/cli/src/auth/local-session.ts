import { fromBase64 } from '@agentnomad/contracts';

import { ApiError, NotLoggedInError } from '../api/api-errors.ts';
import type { SecretStore } from '../secrets/secret-store.ts';

/** The server no longer accepts this PC's session (90 days old, or 30 days unused). */
export class SessionExpiredError extends Error {
  constructor(options?: ErrorOptions) {
    super('Your session has expired. Run `agentnomad login` to log in again.', options);
    this.name = 'SessionExpiredError';
  }
}

/** A login is kept as these two secrets; both go together. */
export interface LocalSession {
  readonly sessionToken: string;
  /** The unlocked data key, base64. */
  readonly dataKey: string;
}

export async function saveLocalSession(secrets: SecretStore, session: LocalSession): Promise<void> {
  await secrets.setMany({ 'session-token': session.sessionToken, 'data-key': session.dataKey });
}

/** Forgets the login on this PC. Never fails because one secret was already gone. */
export async function clearLocalSession(secrets: SecretStore): Promise<void> {
  await secrets.delete('session-token');
  await secrets.delete('data-key');
}

export async function hasLocalSession(secrets: SecretStore): Promise<boolean> {
  return (await secrets.get('session-token')) !== null;
}

/**
 * Runs a request that needs the session. When the server says the session is no longer
 * valid, the stale secrets are cleared and the user is told to log in again.
 */
export async function withSession<T>(secrets: SecretStore, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'unauthorized') {
      await clearLocalSession(secrets);
      throw new SessionExpiredError({ cause: error });
    }
    throw error;
  }
}

/**
 * The unlocked data key of this PC's login; NotLoggedInError when there is none, with
 * `message` when the command words it its own way.
 */
export async function readDataKey(secrets: SecretStore, message?: string): Promise<Uint8Array> {
  const [token, dataKey] = await Promise.all([
    secrets.get('session-token'),
    secrets.get('data-key'),
  ]);
  if (token === null || dataKey === null) throw new NotLoggedInError(message);
  return fromBase64(dataKey);
}
