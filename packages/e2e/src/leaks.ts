import { expect } from 'vitest';

import type { LocalServer } from './local-server.ts';
import { forward, type Pc } from './pc.ts';
import { looksCompressedOnly, plaintextLeaks } from './plaintext.ts';

/** The account a test logs in with: its username is sent readable, its password never. */
interface Account {
  readonly username: string;
  readonly password: string;
}

/** What only the PCs of a test know, gathered while they are logged in (T48). */
export interface Known {
  readonly account: Account;
  readonly dataKey: string;
  readonly tokens: readonly string[];
  readonly homes: readonly string[];
}

/** What `pcs`, logged in to `account`, know: the first one's data key, every session token. */
export async function secretsOf(account: Account, ...pcs: Pc[]): Promise<Known> {
  const dataKey = await pcs[0]?.secret('data-key');
  if (!dataKey) throw new Error('The PC is not logged in: no data key to look for.');
  const tokens: string[] = [];
  for (const pc of pcs) {
    const token = await pc.secret('session-token');
    if (token) tokens.push(token);
  }
  return { account, dataKey, tokens, homes: pcs.map((pc) => pc.home) };
}

/**
 * T38: nothing readable left the PC. Every request the server received (URL, headers, body)
 * is searched for the password, the data key, the home folders and `readable`: what the test
 * pushed (file contents, commands, memory, names). Only the username and device name are sent
 * readable, and a session token only in the Authorization header.
 */
export function expectNoLeaks(
  server: LocalServer,
  known: Known,
  readable: readonly string[],
): void {
  expect(server.requests.length).toBeGreaterThan(0);
  const secrets = [
    // T48: what only this PC may know, and where it keeps it.
    known.dataKey,
    Buffer.from(known.dataKey, 'base64').toString('hex'),
    ...known.homes.flatMap((home) => [home, forward(home)]),
    known.account.password,
    ...readable,
  ];
  expect(plaintextLeaks(server.requests, secrets)).toEqual([]);
  expect(plaintextLeaks(server.requests, known.tokens, 'authorization')).toEqual([]);
  // Every upload is encrypted, not just compressed (T48).
  for (const upload of server.requests.filter((request) => request.method === 'PUT')) {
    expect(looksCompressedOnly(upload.body)).toBe(false);
  }
  // Control: the username is sent readable (register, login), so the search does see bodies.
  const { username } = known.account;
  expect(plaintextLeaks(server.requests, [username])).toEqual([username]);
}
