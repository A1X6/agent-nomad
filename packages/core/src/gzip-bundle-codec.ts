import { BUNDLE_FORMAT_VERSION, BundleSchema, type Bundle } from '@agentnomad/contracts';
import { Gunzip, gzipSync, strFromU8, strToU8 } from 'fflate';

import { BundleFormatError, type BundleCodec } from './bundle-codec.ts';

/**
 * Largest bundle accepted after decompression. Far above any real setup, far below what
 * could exhaust memory; guards against decompression bombs.
 */
export const MAX_DECOMPRESSED_BUNDLE_BYTES = 64 * 1024 * 1024;

/** Compressed input is fed in pieces this size, so a bomb is caught while it expands. */
const INPUT_CHUNK_BYTES = 16 * 1024;
/** gzip header (10 bytes) + trailer (CRC and size, 8 bytes). */
const MIN_GZIP_BYTES = 18;

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= MIN_GZIP_BYTES && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Original size stored in the last 4 bytes of a gzip stream (little-endian, modulo 4 GiB). */
function declaredSize(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    bytes.byteLength - 4,
    true,
  );
}

const tooLarge = () =>
  new BundleFormatError(
    `Bundle is too large to open (over ${String(MAX_DECOMPRESSED_BUNDLE_BYTES / 1024 / 1024)} MB)`,
  );

/**
 * Decompresses with a hard size limit. The declared size is checked first; the running
 * total is checked too, because the declared size can be forged.
 */
function gunzipLimited(bytes: Uint8Array): Uint8Array {
  if (declaredSize(bytes) > MAX_DECOMPRESSED_BUNDLE_BYTES) throw tooLarge();

  const chunks: Uint8Array[] = [];
  // Updated inside the stream callback, so kept on an object TypeScript cannot narrow away.
  const state = { total: 0, finished: false };
  const stream = new Gunzip((chunk, final) => {
    state.total += chunk.length;
    if (state.total > MAX_DECOMPRESSED_BUNDLE_BYTES) throw tooLarge();
    chunks.push(chunk);
    if (final) state.finished = true;
  });

  try {
    for (let offset = 0; offset < bytes.length; offset += INPUT_CHUNK_BYTES) {
      const end = Math.min(offset + INPUT_CHUNK_BYTES, bytes.length);
      stream.push(bytes.subarray(offset, end), end === bytes.length);
    }
  } catch (error) {
    if (error instanceof BundleFormatError) throw error;
    throw new BundleFormatError('Bundle is not valid gzip data');
  }
  if (!state.finished) throw new BundleFormatError('Bundle is incomplete');

  const output = new Uint8Array(state.total);
  let position = 0;
  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.length;
  }
  return output;
}

/** Turns decompressed bytes into a validated bundle, explaining unsupported versions. */
function parseBundle(bytes: Uint8Array): Bundle {
  let data: unknown;
  try {
    data = JSON.parse(strFromU8(bytes));
  } catch {
    throw new BundleFormatError('Bundle is not valid JSON');
  }

  if (typeof data === 'object' && data !== null && 'formatVersion' in data) {
    const version = data.formatVersion;
    if (version !== BUNDLE_FORMAT_VERSION) {
      throw new BundleFormatError(
        `Bundle uses format version ${String(version)}, which this version of agentnomad ` +
          'cannot read. Update agentnomad and try again.',
      );
    }
  }

  const result = BundleSchema.safeParse(data);
  if (!result.success) throw new BundleFormatError('Bundle failed validation');
  return result.data;
}

/**
 * BundleCodec using JSON + gzip (fflate, pure JavaScript, so core needs no Node APIs).
 * Output is deterministic: the gzip header carries no timestamp.
 */
export function createGzipBundleCodec(): BundleCodec {
  return {
    encode: (bundle) =>
      Promise.resolve().then(() => {
        const checked = BundleSchema.parse(bundle);
        return gzipSync(strToU8(JSON.stringify(checked)), { level: 9, mtime: 0 });
      }),
    decode: (bytes) =>
      Promise.resolve().then(() => {
        if (!isGzip(bytes)) throw new BundleFormatError('Bundle is not valid gzip data');
        return parseBundle(gunzipLimited(bytes));
      }),
  };
}
