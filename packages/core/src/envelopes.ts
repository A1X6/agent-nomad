import type { AgentId, ScopeKey } from '@agentnomad/contracts';

import { DecryptionError, type Aead } from './crypto.ts';

/** The random key that encrypts every bundle. Only ever stored wrapped by the password key. */
export const DATA_KEY_BYTES = 32;

/** What a bundle's encryption is bound to. Opening it under any other context fails. */
export interface BundleContext {
  readonly formatVersion: number;
  readonly agent: AgentId;
  readonly scopeKey: ScopeKey;
}

/** ASCII text to bytes. Associated data is always ASCII, so no text encoder is needed. */
function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    if (code > 0x7f) throw new RangeError('Associated data must be ASCII');
    return code;
  });
}

/** Labels keep each kind of encrypted data apart: a wrapped key never opens as a bundle. */
const DATA_KEY_ASSOCIATED_DATA = ascii('agentnomad/data-key/v1');

/**
 * `agentnomad/bundle/v1/<formatVersion>/<agent>/<scopeKey>`. Unambiguous because agent ids
 * and scope keys cannot contain `/` (see the contracts schemas).
 */
export function bundleAssociatedData(context: BundleContext): Uint8Array {
  return ascii(
    `agentnomad/bundle/v1/${String(context.formatVersion)}/${context.agent}/${context.scopeKey}`,
  );
}

/** Locks the data key with the password key (72 bytes: nonce + key + tag). */
export function wrapDataKey(aead: Aead, dataKey: Uint8Array, passwordKey: Uint8Array): Uint8Array {
  if (dataKey.length !== DATA_KEY_BYTES) {
    throw new RangeError(`Data key must be ${String(DATA_KEY_BYTES)} bytes`);
  }
  return aead.seal(dataKey, passwordKey, DATA_KEY_ASSOCIATED_DATA);
}

/** Unlocks the data key. Throws DecryptionError for a wrong password key or changed bytes. */
export function unwrapDataKey(
  aead: Aead,
  wrapped: Uint8Array,
  passwordKey: Uint8Array,
): Uint8Array {
  const dataKey = aead.open(wrapped, passwordKey, DATA_KEY_ASSOCIATED_DATA);
  if (dataKey.length !== DATA_KEY_BYTES) throw new DecryptionError();
  return dataKey;
}

/** Encrypts a compressed bundle, bound to its format version, agent and scope. */
export function sealBundle(
  aead: Aead,
  plaintext: Uint8Array,
  dataKey: Uint8Array,
  context: BundleContext,
): Uint8Array {
  return aead.seal(plaintext, dataKey, bundleAssociatedData(context));
}

/** Decrypts a bundle. Fails if it was stored under a different format version, agent or scope. */
export function openBundle(
  aead: Aead,
  sealed: Uint8Array,
  dataKey: Uint8Array,
  context: BundleContext,
): Uint8Array {
  return aead.open(sealed, dataKey, bundleAssociatedData(context));
}
