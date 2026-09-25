import { createSodiumCryptoService, type CryptoService } from '@agentnomad/core';

import type { ApiClient } from './api/api-client.ts';
import { resolveApiUrl } from './api/api-url.ts';
import { createHttpApiClient } from './api/http-api-client.ts';
import { createAuthCommands } from './auth/auth-commands.ts';
import { loadZxcvbnChecker } from './auth/password-policy.ts';
import { NOT_YET_AVAILABLE, type CommandHandlers } from './cli/commands.ts';
import { createSecretStore } from './secrets/create-secret-store.ts';
import type { SecretStore } from './secrets/secret-store.ts';
import type { Prompter, Reporter, Spinner } from './ui/prompter.ts';

export interface AppEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  /** The PC's host name, used as the device name of new sessions. */
  readonly hostname: string;
  readonly prompter: Prompter;
  readonly reporter: Reporter;
  readonly fetch?: typeof fetch;
}

/** Runs `create` once, on first use. */
function lazy<T>(create: () => T): () => T {
  let value: { readonly current: T } | undefined;
  return () => (value ??= { current: create() }).current;
}

/** A short, single-line device name for the server's session list. */
export function deviceNameOf(hostname: string): string {
  const name = Array.from(hostname)
    .filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, 64);
  return name || 'unknown device';
}

/**
 * The composition root: builds the real services and the command handlers from them.
 * Nothing (keychain, crypto, network) is touched until a command needs it, so `--help`
 * stays instant and never fails.
 */
export function createAppHandlers(app: AppEnvironment): CommandHandlers {
  const apiUrl = lazy(() => resolveApiUrl(app.env));
  const secrets = lazy<Promise<SecretStore>>(() =>
    createSecretStore({
      server: apiUrl().host,
      env: app.env,
      platform: app.platform,
      homedir: app.homedir,
    }),
  );
  const crypto = lazy<Promise<CryptoService>>(() => createSodiumCryptoService());

  const api = lazy<ApiClient>(() => {
    let waking: Spinner | undefined;
    return createHttpApiClient({
      baseUrl: apiUrl(),
      getSessionToken: async () => (await secrets()).get('session-token'),
      ...(app.fetch && { fetch: app.fetch }),
      wakeUp: {
        onWaking: () => {
          waking = app.reporter.spinner();
          waking.start('Waking up the server (it sleeps when idle; up to a minute)…');
        },
        onAwake: () => {
          waking?.stop('Server is awake.');
          waking = undefined;
        },
      },
    });
  });

  return {
    ...NOT_YET_AVAILABLE,
    ...createAuthCommands({
      prompter: app.prompter,
      reporter: app.reporter,
      api,
      secrets,
      crypto,
      passwordChecker: loadZxcvbnChecker,
      deviceName: deviceNameOf(app.hostname),
    }),
  };
}
