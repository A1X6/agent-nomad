import { BUNDLE_FORMAT_VERSION, GLOBAL_SCOPE_KEY } from '../src/index.ts';

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

/** One saved setup as `GET /bundles` lists it: the global setup, which has no name. */
export const summary = {
  agent: 'claude-code',
  scopeKey: GLOBAL_SCOPE_KEY,
  nameEnc: null,
  revision: 3,
  formatVersion: BUNDLE_FORMAT_VERSION,
  sizeBytes: 2048,
  updatedAt: '2026-09-24T13:00:00Z',
};
