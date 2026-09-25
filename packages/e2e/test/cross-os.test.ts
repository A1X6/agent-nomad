import { readFile, writeFile } from 'node:fs/promises';

import { it } from 'vitest';

import { startLocalServer } from '../src/local-server.ts';
import { STEPS } from '../src/steps.ts';

/**
 * T37. In CI each step runs on another OS (`E2E_STEP`, the database handed over as a file
 * in `E2E_DB_IN` / `E2E_DB_OUT`): macOS → Windows → macOS and Linux → Windows → Linux.
 * Without `E2E_STEP` all three run here, one after the other, each on a fresh "PC".
 */
const step = process.env['E2E_STEP'];

if (step !== undefined) {
  it(`step ${step} on ${process.platform}`, async () => {
    const run = STEPS[step as keyof typeof STEPS] as (typeof STEPS)[keyof typeof STEPS] | undefined;
    if (!run) throw new Error(`E2E_STEP must be 1, 2 or 3, not "${step}".`);
    const input = process.env['E2E_DB_IN'];
    const output = process.env['E2E_DB_OUT'];
    const server = await startLocalServer(input ? await readFile(input) : undefined);
    try {
      // One PC per machine here, so the real OS keychain is used where there is one
      // (`E2E_KEYCHAIN=off` keeps a developer's own keychain out of it).
      await run({ server, keychain: process.env['E2E_KEYCHAIN'] !== 'off' });
      if (output) await writeFile(output, await server.dump());
    } finally {
      await server.close();
    }
  });
} else {
  it(`all three steps on ${process.platform}, handing the database over between them`, async () => {
    let database: Uint8Array | undefined;
    for (const run of [STEPS['1'], STEPS['2'], STEPS['3']]) {
      const server = await startLocalServer(database);
      try {
        await run({ server, keychain: false });
        database = await server.dump();
      } finally {
        await server.close();
      }
    }
  });
}
