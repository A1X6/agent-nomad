import { AUTHORIZATION_SCHEME, SessionTokenSchema } from '@agentnomad/contracts';
import { createMiddleware } from 'hono/factory';

import type { AuthenticatedSession, AuthService } from '../auth/auth-service.ts';
import { ApiError } from './errors.ts';

export interface SessionVariables {
  session: AuthenticatedSession;
}

/**
 * Requires `Authorization: Bearer <token>` with a live session and puts it in
 * `c.get('session')`. Every failure gets the same 401, so nothing is learned from it.
 */
export function requireSession(auth: AuthService) {
  return createMiddleware<{ Variables: SessionVariables }>(async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const [scheme, token, ...rest] = header.split(' ');
    const valid =
      scheme === AUTHORIZATION_SCHEME &&
      rest.length === 0 &&
      SessionTokenSchema.safeParse(token).success;
    const session = valid && token ? await auth.authenticate(token) : null;
    if (!session) throw new ApiError(401, 'unauthorized', 'Log in again: no valid session');
    c.set('session', session);
    await next();
  });
}
