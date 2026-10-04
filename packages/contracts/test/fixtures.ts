/** Shared set-up of the contracts tests (review 9 DUP-01). */

/** A session token: base64url of 32 bytes. */
export const token = 'A'.repeat(43);

/** The default Argon2id settings, written out as the wire carries them. */
export const kdfParams = {
  algorithm: 'argon2id',
  version: 19,
  memoryKiB: 65536,
  passes: 3,
  parallelism: 1,
};
