import type { RecordedRequest } from './local-server.ts';

/**
 * The forms a leaked string could take in a request: as is, and base64 or base64url encoded
 * at any of the three byte alignments (only the part that does not depend on its
 * neighbours is kept, so it is found inside a longer encoded value too).
 */
function encodedForms(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8');
  const forms = [secret];
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64');
    // Characters touched by the zero prefix or the padding depend on what surrounds it.
    const core = encoded.slice(offset === 0 ? 0 : 4, -4);
    if (core.length >= 8) forms.push(core, core.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return forms;
}

/**
 * Which secrets appear in any request (T38: no plaintext leaves the PC). Every URL, header
 * and body is searched, bodies both as UTF-8 text and byte for byte.
 */
export function plaintextLeaks(
  requests: readonly RecordedRequest[],
  secrets: readonly string[],
): string[] {
  const leaks = new Set<string>();
  for (const request of requests) {
    const body = Buffer.from(request.body);
    const text = [request.method, request.url, request.headers, body.toString('utf8')].join('\n');
    for (const secret of secrets) {
      if (body.includes(Buffer.from(secret, 'utf8'))) leaks.add(secret);
      if (encodedForms(secret).some((form) => text.includes(form))) leaks.add(secret);
    }
  }
  return [...leaks];
}
