/** Server-only text conversions; the shared byte helpers are in `@agentnomad/contracts`. */
import { fromBase64, toBase64 } from '@agentnomad/contracts';

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Unpadded base64url to bytes. Throws on anything else, rather than return wrong bytes. */
export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Not a base64url string');
  return fromBase64(text.replace(/-/g, '+').replace(/_/g, '/'));
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
