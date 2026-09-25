import { describe, expect, it } from 'vitest';

import type { RecordedRequest } from '../src/local-server.ts';
import { plaintextLeaks } from '../src/plaintext.ts';

const request = (body: string, headers = ''): RecordedRequest => ({
  method: 'PUT',
  url: 'http://127.0.0.1/bundles/claude-code/abc',
  headers,
  body: new TextEncoder().encode(body),
});

/** The check itself must catch a leak in every form it claims to, or its passing means nothing. */
describe('plaintext leak check', () => {
  const secret = 'Run the deploy script';

  it.each([
    ['as is, in the body', request(`{"content":"${secret}"}`)],
    ['in a header', request('', `x-note: ${secret}`)],
    ...[0, 1, 2].map((offset): [string, RecordedRequest] => [
      `base64 at offset ${String(offset)}`,
      request(Buffer.from('ab'.slice(0, offset) + secret + 'tail').toString('base64')),
    ]),
    ['base64url', request(Buffer.from(`??${secret}??`).toString('base64url'))],
  ])('finds it %s', (_, leaked) => {
    expect(plaintextLeaks([leaked], [secret])).toEqual([secret]);
  });

  it('finds nothing in unrelated or random data', () => {
    const random = request(
      Buffer.from(crypto.getRandomValues(new Uint8Array(4096))).toString('latin1'),
    );
    expect(plaintextLeaks([random, request('{"username":"e2e-user"}')], [secret])).toEqual([]);
  });
});
