import { join } from 'node:path';

import { configDir, type ConfigDirInput } from '../config/config-dir.ts';
import { createFileStore, SECRETS_FILE } from './file-store.ts';
import { createKeychainStore, osKeychain, type KeychainEntryFactory } from './keychain-store.ts';
import type { SecretStore } from './secret-store.ts';

export interface CreateSecretStoreOptions extends ConfigDirInput {
  /** The API server these secrets belong to (its URL host, e.g. `localhost:3000`). */
  readonly server: string;
  readonly keychain?: KeychainEntryFactory;
}

/**
 * The OS keychain when it works on this PC, otherwise the user-only file (T22). The
 * keychain is tried once by reading the session token: that fails fast where there is no
 * keychain (Linux without Secret Service, WSL, SSH sessions). Check `backend` to tell the
 * user when the file is used.
 */
export async function createSecretStore(options: CreateSecretStoreOptions): Promise<SecretStore> {
  const keychain = createKeychainStore(options.server, options.keychain ?? osKeychain);
  try {
    await keychain.get('session-token');
    return keychain;
  } catch {
    return createFileStore({
      path: join(configDir(options), SECRETS_FILE),
      server: options.server,
      platform: options.platform,
    });
  }
}
