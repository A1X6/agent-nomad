/** Server-only text conversions; the shared byte helpers are in `@agentnomad/contracts`. */
import { toBase64 } from '@agentnomad/contracts';

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
