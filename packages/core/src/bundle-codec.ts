import type { Bundle } from '@agentnomad/contracts';

/** Bytes that are not a valid bundle this version of agentnomad can read. */
export class BundleFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleFormatError';
  }
}

/**
 * Turns a bundle into compressed bytes and back (T09). Encryption happens after
 * `encode` and before `decode`; this layer never sees keys.
 */
export interface BundleCodec {
  /** Bundle to compressed bytes. */
  encode(bundle: Bundle): Promise<Uint8Array>;
  /**
   * Compressed bytes to a validated bundle. Rejects anything that is not a valid bundle,
   * including an unsupported `formatVersion`.
   */
  decode(bytes: Uint8Array): Promise<Bundle>;
}
