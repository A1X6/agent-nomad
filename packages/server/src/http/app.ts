import { API_ROUTES, type HealthResponse } from '@agentnomad/contracts';
import { Hono } from 'hono';

import type { AuthService } from '../auth/auth-service.ts';
import type { BundleService } from '../bundles/bundle-service.ts';
import { handleError, handleNotFound } from './errors.ts';
import { accountRoutes } from './routes/account.ts';
import { authRoutes } from './routes/auth.ts';
import { bundleRoutes } from './routes/bundles.ts';

export interface AppDeps {
  readonly auth: AuthService;
  readonly bundles: BundleService;
}

/**
 * The agentnomad API. Built from injected services, so tests run it against PGlite with a
 * fixed clock and hosts wire in Neon.
 *
 * No CORS headers on purpose: the only client is the CLI, and without them browsers refuse
 * to let any website read these responses. Tokens travel in the Authorization header, never
 * in cookies, so cross-site request forgery does not apply either.
 */
export function createApp(deps: AppDeps): Hono {
  return new Hono()
    .use('*', async (c, next) => {
      await next();
      // OWASP REST guidance: never cache API responses (they carry tokens and keys), and
      // never let a client guess a different content type.
      c.header('Cache-Control', 'no-store');
      c.header('X-Content-Type-Options', 'nosniff');
    })
    .get(API_ROUTES.health, (c) => c.json({ status: 'ok' } satisfies HealthResponse))
    .route('/', authRoutes(deps.auth))
    .route('/', bundleRoutes(deps.auth, deps.bundles))
    .route('/', accountRoutes(deps.auth))
    .notFound(handleNotFound)
    .onError(handleError);
}
