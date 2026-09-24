import type { BundleKey } from '../db/repositories.ts';

/** One revision of one saved setup's encrypted bytes. */
export interface BlobRef extends BundleKey {
  readonly revision: number;
}

/**
 * Stores encrypted bundle bytes (T14). Postgres in v1, Cloudflare R2 later, with no change
 * to the API or CLI.
 *
 * Upload order, so a failed or rejected upload never damages the current copy:
 * 1. `put` the bytes under the new revision.
 * 2. `BundleRepository.putMeta` checks the revision and points to it.
 * 3. On a conflict, `delete` the new bytes; on success, `delete` the previous revision.
 */
export interface BlobStore {
  put(ref: BlobRef, bytes: Uint8Array): Promise<void>;
  /** `null` when no bytes are stored for that revision. */
  get(ref: BlobRef): Promise<Uint8Array | null>;
  /** Does nothing when the bytes are already gone. */
  delete(ref: BlobRef): Promise<void>;
}
