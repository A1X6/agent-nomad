import { readFile, writeFile } from 'node:fs/promises';

import { it } from 'vitest';

import { startLocalServer, type LocalServer } from '../src/local-server.ts';
import { STEPS } from '../src/steps.ts';

/** Starts the local API on `database` (empty when none), hands it to `use`, always closes it. */
async function withServer(
  database: Uint8Array | undefined,
  use: (server: LocalServer) => Promise<void>,
): Promise<void> {
  const server = await startLocalServer(database);
  try {
    await use(server);
  } finally {
    await server.close();
  }
}

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
    await withServer(input ? await readFile(input) : undefined, async (server) => {
      // One PC per machine here, so the real OS keychain is used where there is one
      // (`E2E_KEYCHAIN=off` keeps a developer's own keychain out of it).
      await run({ server, keychain: process.env['E2E_KEYCHAIN'] !== 'off' });
      if (output) await writeFile(output, await server.dump());
    });
  });
} else {
  it(`all three steps on ${process.platform}, handing the database over between them`, async () => {
    let database: Uint8Array | undefined;
    for (const run of [STEPS['1'], STEPS['2'], STEPS['3']]) {
      await withServer(database, async (server) => {
        await run({ server, keychain: false });
        database = await server.dump();
      });
    }
  });
}
