import * as z from 'zod';

/** True when `text` contains an ASCII control character (e.g. a newline or NUL). */
export function hasControlCharacter(text: string): boolean {
  return Array.from(text).some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

/** Number of bytes a valid, padded base64 string decodes to. */
function decodedBase64Length(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** Base64 that decodes to exactly `bytes` bytes (keys, salts). */
export function base64OfLength(bytes: number) {
  return z
    .base64()
    .refine((value) => decodedBase64Length(value) === bytes, `Must be ${String(bytes)} bytes`);
}

/** Base64 of at most `maxBytes` bytes (encrypted names). */
export function base64UpTo(maxBytes: number) {
  return z
    .base64()
    .min(1)
    .refine(
      (value) => decodedBase64Length(value) <= maxBytes,
      `Must be at most ${String(maxBytes)} bytes`,
    );
}

/** Lowercase hex SHA-256 digest. */
export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Must be a lowercase hex SHA-256');

/** ISO 8601 UTC timestamp, e.g. `2026-09-24T13:00:00Z`. */
export const TimestampSchema = z.iso.datetime();

/** Short human-readable text such as a device name: 1–64 characters, one line. */
export const ShortTextSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((text) => !hasControlCharacter(text), 'Must be a single line of text');
