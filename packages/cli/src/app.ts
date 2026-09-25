import { createSodiumCryptoService, type CryptoService } from '@agentnomad/core';

import type { AgentRegistry } from './agents/adapter.ts';
import { createAgentsCommand } from './agents/agents-command.ts';
import { createClaudeCodeAdapter } from './agents/claude-code/claude-code-adapter.ts';
import { claudeConfigDir, nodeDetectorSystem } from './agents/claude-code/detector.ts';
import {
  detectManagedSettings,
  managedSettingsNotice,
  nodeManagedSettingsSystem,
} from './agents/claude-code/managed-settings.ts';
import { createAgentRegistry } from './agents/registry.ts';
import type { ApiClient } from './api/api-client.ts';
import { resolveApiUrl } from './api/api-url.ts';
import { createHttpApiClient } from './api/http-api-client.ts';
import { createAuthCommands } from './auth/auth-commands.ts';
import { loadZxcvbnChecker } from './auth/password-policy.ts';
import { NOT_YET_AVAILABLE, type CommandHandlers } from './cli/commands.ts';
import { createEnvCommand } from './env/env-command.ts';
import { createSecretStore } from './secrets/create-secret-store.ts';
import type { SecretStore } from './secrets/secret-store.ts';
import type { Prompter, Reporter, Spinner } from './ui/prompter.ts';

export interface AppEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  /** The PC's host name, used as the device name of new sessions. */
  readonly hostname: string;
  /** The folder the command runs in; the project for project-scope commands. */
  readonly cwd: string;
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

  // Every supported agent; adding one means adding its adapter here (T28).
  const registry = lazy<AgentRegistry>(() =>
    createAgentRegistry([
      createClaudeCodeAdapter({
        env: app.env,
        homedir: app.homedir,
        platform: app.platform,
        onClaudeRunning: () =>
          app.prompter.select('Claude Code is running and rewrites ~/.claude.json while open.', [
            { value: 'retry', label: 'I closed Claude Code, continue' },
            { value: 'skip', label: 'Skip ~/.claude.json this time' },
          ]),
      }),
    ]),
  );

  return {
    ...NOT_YET_AVAILABLE,
    ...createAgentsCommand({
      registry,
      reporter: app.reporter,
      notices: async () => {
        const system = nodeDetectorSystem(app.env, app.homedir, app.platform);
        const found = await detectManagedSettings(
          nodeManagedSettingsSystem(app.env, claudeConfigDir(system), app.platform),
        );
        const notice = managedSettingsNotice(found, 'agents');
        return notice === null ? [] : [notice];
      },
    }),
    ...createEnvCommand({ registry, reporter: app.reporter, env: app.env, cwd: app.cwd }),
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
