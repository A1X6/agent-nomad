import { KdfParamsSchema, type KdfParams } from '@agentnomad/contracts';
import sodium from 'libsodium-wrappers-sumo';

import { DecryptionError, type CryptoService, type DerivedKeys } from './crypto.ts';

const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** XChaCha20-Poly1305: 192-bit nonce, so random nonces never realistically repeat. */
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
/** Keyed BLAKE2b accepts keys of 16 to 64 bytes. */
const MIN_HASH_KEY_BYTES = 16;
const MAX_HASH_KEY_BYTES = 64;

/**
 * Splits the Argon2id master key into subkeys. Context and ids are part of the key format:
 * changing them would lock every existing user out.
 */
const KDF_CONTEXT = 'agentnm1';
const AUTH_KEY_ID = 1;
const PASSWORD_KEY_ID = 2;

function requireLength(name: string, data: Uint8Array, length: number): void {
  if (data.length !== length) {
    throw new RangeError(`${name} must be ${String(length)} bytes, got ${String(data.length)}`);
  }
}

function deriveKeys(password: string, salt: Uint8Array, params: KdfParams): DerivedKeys {
  // Re-checked here: the settings arrive from the server at prelogin.
  const checked = KdfParamsSchema.parse(params);
  requireLength('Salt', salt, SALT_BYTES);
  // NFC: the same password typed on macOS, Windows or Linux becomes the same bytes.
  const master = sodium.crypto_pwhash(
    KEY_BYTES,
    password.normalize('NFC'),
    salt,
    checked.passes,
    checked.memoryKiB * 1024,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  try {
    return {
      authKey: sodium.crypto_kdf_derive_from_key(KEY_BYTES, AUTH_KEY_ID, KDF_CONTEXT, master),
      passwordKey: sodium.crypto_kdf_derive_from_key(
        KEY_BYTES,
        PASSWORD_KEY_ID,
        KDF_CONTEXT,
        master,
      ),
    };
  } finally {
    sodium.memzero(master);
  }
}

function seal(plaintext: Uint8Array, key: Uint8Array, associatedData: Uint8Array): Uint8Array {
  requireLength('Key', key, KEY_BYTES);
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    associatedData,
    null,
    nonce,
    key,
  );
  const sealed = new Uint8Array(NONCE_BYTES + ciphertext.length);
  sealed.set(nonce);
  sealed.set(ciphertext, NONCE_BYTES);
  return sealed;
}

function open(sealed: Uint8Array, key: Uint8Array, associatedData: Uint8Array): Uint8Array {
  requireLength('Key', key, KEY_BYTES);
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new DecryptionError();
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      sealed.subarray(NONCE_BYTES),
      associatedData,
      sealed.subarray(0, NONCE_BYTES),
      key,
    );
  } catch {
    throw new DecryptionError();
  }
}

function keyedHash(message: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length < MIN_HASH_KEY_BYTES || key.length > MAX_HASH_KEY_BYTES) {
    throw new RangeError(
      `Hash key must be ${String(MIN_HASH_KEY_BYTES)}–${String(MAX_HASH_KEY_BYTES)} bytes`,
    );
  }
  return sodium.crypto_generichash(KEY_BYTES, message, key);
}

/**
 * The CryptoService backed by libsodium (docs/decisions/0001-libraries.md). Waits for the
 * WebAssembly module to load, so call it once and reuse the result.
 */
export async function createSodiumCryptoService(): Promise<CryptoService> {
  await sodium.ready;
  return {
    // Promise-based so a slower or off-thread implementation can replace it later;
    // errors (bad settings or salt) become rejections.
    deriveKeys: (password, salt, params) =>
      Promise.resolve().then(() => deriveKeys(password, salt, params)),
    seal,
    open,
    keyedHash,
    sha256: (data) => sodium.crypto_hash_sha256(data),
    randomBytes: (length) => sodium.randombytes_buf(length),
  };
}
