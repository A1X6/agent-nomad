import { toBase64Url, toHex, utf8 } from '../encoding.ts';

/** 32 random bytes = 256 bits, well above OWASP's 128-bit minimum for custom session ids. */
const SESSION_TOKEN_BYTES = 32;

/** A new session token (base64url, 43 characters, matches SessionTokenSchema). */
export function newSessionToken(randomBytes: (length: number) => Uint8Array): string {
  return toBase64Url(randomBytes(SESSION_TOKEN_BYTES));
}

/**
 * What the database stores for a token. The token is 256 random bits, so a plain SHA-256
 * cannot be reversed or guessed; no slow hash is needed.
 */
export async function hashSessionToken(token: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(token))));
}
