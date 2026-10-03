/**
 * Byte conversions with web-standard APIs only, so they run on any host and in every package
 * (DUP-01). `atob` and `btoa` exist in every Node this project supports and in browsers; this
 * package has no Node or DOM types, so they are declared here as Node declares them.
 */
declare global {
  function atob(data: string): string;
  function btoa(data: string): string;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Hex in either case to bytes. Throws on anything else, rather than return wrong bytes. */
export function fromHex(text: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(text)) throw new Error('Not a hex string');
  const pairs = text.match(/../g) ?? [];
  return Uint8Array.from(pairs, (pair) => parseInt(pair, 16));
}

/** Same length and same bytes. Not constant-time; never for secrets. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
