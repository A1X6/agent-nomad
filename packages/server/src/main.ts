/**
 * Starts the API as a Node web server (T19, Render). Everything else is built by
 * createServerFromEnv, which refuses to start with missing or invalid settings.
 */
import { serve } from '@hono/node-server';

import { renderClientIp } from './hosting/client-ip.ts';
import { createJsonLogger, describeError } from './logging/logger.ts';
import { readPort } from './port.ts';
import { createServerFromEnv } from './server.ts';

const logger = createJsonLogger();

try {
  const port = readPort(process.env);
  const server = await createServerFromEnv(process.env, { clientIp: renderClientIp, logger });
  const http = serve({ fetch: server.app.fetch, port }, () => {
    logger.info('server_started', { port });
  });

  // Render sends SIGTERM before replacing an instance: finish requests, close the pool.
  const shutdown = (signal: string) => {
    logger.info('server_stopping', { signal });
    http.close(() => {
      void server.close().finally(() => process.exit(0));
    });
  };
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
} catch (error) {
  // Bad settings: log why (never the values) and stop, so the deploy fails visibly.
  logger.error('startup_failed', describeError(error));
  process.exit(1);
}
