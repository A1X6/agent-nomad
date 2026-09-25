import {
  API_ROUTES,
  LoginRequestSchema,
  PreloginRequestSchema,
  RegisterRequestSchema,
  type LoginResponse,
  type PreloginResponse,
  type SessionResponse,
} from '@agentnomad/contracts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { InvalidCredentialsError, type AuthService } from '../../auth/auth-service.ts';
import { fromBase64, toBase64 } from '../../encoding.ts';
import { UsernameTakenError } from '../../db/repositories.ts';
import { ApiError } from '../errors.ts';
import { requireSession, type SessionVariables } from '../session.ts';
import { jsonBody } from '../validate.ts';

/** Auth requests are small JSON; anything bigger is refused before it is read. */
const MAX_AUTH_BODY_BYTES = 16 * 1024;

/** Per route (not `use('*')`), so it never applies to the large bundle uploads (T16). */
const smallBody = () =>
  bodyLimit({
    maxSize: MAX_AUTH_BODY_BYTES,
    onError: () => {
      throw new ApiError(413, 'payload_too_large', 'Request body is too large');
    },
  });

/** POST /auth/prelogin, /auth/register, /auth/login, /auth/logout (T15). */
export function authRoutes(auth: AuthService) {
  return new Hono<{ Variables: SessionVariables }>()

    .post(API_ROUTES.prelogin, smallBody(), jsonBody(PreloginRequestSchema), async (c) => {
      const { username } = c.req.valid('json');
      const result = await auth.prelogin(username);
      const body: PreloginResponse = {
        kdfSalt: toBase64(result.kdfSalt),
        kdfParams: result.kdfParams,
      };
      return c.json(body);
    })

    .post(API_ROUTES.register, smallBody(), jsonBody(RegisterRequestSchema), async (c) => {
      const request = c.req.valid('json');
      try {
        const session = await auth.register({
          username: request.username,
          kdfSalt: fromBase64(request.kdfSalt),
          kdfParams: request.kdfParams,
          authKey: fromBase64(request.authKey),
          wrappedDataKey: fromBase64(request.wrappedDataKey),
          deviceName: request.deviceName,
        });
        const body: SessionResponse = {
          sessionToken: session.token,
          expiresAt: session.expiresAt.toISOString(),
        };
        return c.json(body, 201);
      } catch (error) {
        if (error instanceof UsernameTakenError) {
          throw new ApiError(409, 'username_taken', 'That username is taken');
        }
        throw error;
      }
    })

    .post(API_ROUTES.login, smallBody(), jsonBody(LoginRequestSchema), async (c) => {
      const request = c.req.valid('json');
      try {
        const result = await auth.login(
          request.username,
          fromBase64(request.authKey),
          request.deviceName,
        );
        const body: LoginResponse = {
          sessionToken: result.token,
          expiresAt: result.expiresAt.toISOString(),
          wrappedDataKey: toBase64(result.wrappedDataKey),
        };
        return c.json(body);
      } catch (error) {
        if (error instanceof InvalidCredentialsError) {
          throw new ApiError(401, 'unauthorized', 'Wrong username or password');
        }
        throw error;
      }
    })

    .post(API_ROUTES.logout, smallBody(), requireSession(auth), async (c) => {
      await auth.logout(c.get('session').sessionId);
      return c.body(null, 204);
    });
}
