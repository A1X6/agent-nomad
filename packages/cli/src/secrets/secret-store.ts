/** The secrets kept on this PC between commands. */
export type SecretName = 'session-token' | 'data-key';

/**
 * Keeps secrets on this PC (T22): the OS keychain, or a user-only file where no keychain
 * is available (e.g. Linux without Secret Service).
 */
export interface SecretStore {
  /** Where secrets are kept, so the CLI can tell the user when the file fallback is used. */
  readonly backend: 'keychain' | 'file';
  /** `null` when the secret is not stored (e.g. not logged in). */
  get(name: SecretName): Promise<string | null>;
  set(name: SecretName, value: string): Promise<void>;
  /** Does nothing when the secret is not stored. */
  delete(name: SecretName): Promise<void>;
}
