import { AsyncEntry } from '@napi-rs/keyring';

import type { SecretName, SecretStore } from './secret-store.ts';

/** Service name every agentnomad keychain entry is saved under. */
export const KEYCHAIN_SERVICE = 'agentnomad';

/** One keychain entry; the part of @napi-rs/keyring this store uses. */
export interface KeychainEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

/** Opens an entry; throws when no keychain is available (e.g. Linux without Secret Service). */
export type KeychainEntryFactory = (service: string, account: string) => KeychainEntry;

/**
 * The OS keychain through @napi-rs/keyring. On Linux the entry is pinned to Secret Service:
 * the library's own fallback, the kernel keyring, forgets everything on reboot (T04).
 */
export const osKeychain: KeychainEntryFactory = (service, account) =>
  new AsyncEntry(service, account, { linux: { store: 'secret-service' } });

/** Account label, e.g. `session-token@agentnomad-api.onrender.com`: one set per server. */
export const keychainAccount = (name: SecretName, server: string) => `${name}@${server}`;

/** SecretStore on the OS keychain (Credential Manager, macOS Keychain, Secret Service). */
export function createKeychainStore(
  server: string,
  openEntry: KeychainEntryFactory = osKeychain,
  service = KEYCHAIN_SERVICE,
): SecretStore {
  const entry = (name: SecretName) => openEntry(service, keychainAccount(name, server));
  return {
    backend: 'keychain',
    async get(name) {
      return (await entry(name).getPassword()) ?? null;
    },
    async set(name, value) {
      await entry(name).setPassword(value);
    },
    async delete(name) {
      await entry(name).deleteCredential();
    },
  };
}
