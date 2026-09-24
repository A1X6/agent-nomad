import type { KdfParams } from '@agentnomad/contracts';

/**
 * Decryption failed: wrong key, wrong associated data, or bytes that were changed.
 * Deliberately gives no detail, so it cannot help an attacker.
 */
export class DecryptionError extends Error {
  constructor() {
    super('Decryption failed: wrong key or the data was changed');
    this.name = 'DecryptionError';
  }
}

/**
 * Keys derived from the password. Argon2id produces one master key, which is split
 * into these two (T08).
 */
export interface DerivedKeys {
  /** Sent to the server, which hashes it again before storing it. Proves who you are. */
  readonly authKey: Uint8Array;
  /** Never leaves the PC. Locks and unlocks the data key. */
  readonly passwordKey: Uint8Array;
}

/** Turns a password into keys. Slow on purpose, so guessing passwords is expensive. */
export interface PasswordKdf {
  deriveKeys(password: string, salt: Uint8Array, params: KdfParams): Promise<DerivedKeys>;
}

/**
 * Authenticated encryption (XChaCha20-Poly1305 in T08). Used for bundles, project names
 * and wrapping the data key with the password key.
 */
export interface Aead {
  /**
   * Encrypts with a fresh random nonce and returns `nonce + ciphertext + tag` as one piece.
   * `associatedData` is not encrypted but is bound to the result: decrypting with different
   * associated data fails (e.g. a bundle moved to another agent or scope).
   */
  seal(plaintext: Uint8Array, key: Uint8Array, associatedData: Uint8Array): Uint8Array;
  /** Reverses `seal`. Throws if the key, the associated data or any byte is wrong. */
  open(sealed: Uint8Array, key: Uint8Array, associatedData: Uint8Array): Uint8Array;
}

/** Keyed hash, e.g. the project name hashed with a key derived from the data key (T12). */
export interface KeyedHash {
  keyedHash(message: Uint8Array, key: Uint8Array): Uint8Array;
}

/** Plain SHA-256, e.g. the content hash sent with a bundle upload. */
export interface Digest {
  sha256(data: Uint8Array): Uint8Array;
}

/** Cryptographically secure random bytes (salts, data keys). */
export interface RandomSource {
  randomBytes(length: number): Uint8Array;
}

/**
 * Everything crypto the app needs, built from one library (libsodium, T04). Consumers
 * depend on the smallest interface they need, e.g. `Aead` or `Digest`.
 */
export interface CryptoService extends PasswordKdf, Aead, KeyedHash, Digest, RandomSource {}
