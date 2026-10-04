import { beforeAll } from 'vitest';

import { createSodiumCryptoService, DATA_KEY_BYTES, type CryptoService } from '../src/index.ts';

/** Shared set-up of the core tests (review 9 DUP-01). */

// The real crypto service and a data key, made by `useDataKey` before the tests of the
// calling file. Live bindings: a test file that imports them sees the made values.
export let crypto: CryptoService;
export let dataKey: Uint8Array;

/** Makes the real crypto service and a random data key once for the calling file. */
export function useDataKey(): void {
  beforeAll(async () => {
    crypto = await createSodiumCryptoService();
    dataKey = crypto.randomBytes(DATA_KEY_BYTES);
  });
}
