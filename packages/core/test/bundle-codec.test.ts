import type { Bundle } from '@agentnomad/contracts';
import { gzipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  BundleFormatError,
  MAX_DECOMPRESSED_BUNDLE_BYTES,
  createGzipBundleCodec,
} from '../src/index.ts';

const codec = createGzipBundleCodec();

const bundle: Bundle = {
  formatVersion: 1,
  agent: 'claude-code',
  scope: { kind: 'project', name: 'my-saas-app' },
  sourceOs: 'darwin',
  agentVersion: '2.1.282',
  revision: 1,
  files: [
    {
      path: 'settings.json',
      encoding: 'utf8',
      content: '{"hooks":{"cmd":"{{HOME}}/.claude/hook.sh"}}',
      executable: false,
    },
    {
      path: 'CLAUDE.md',
      encoding: 'utf8',
      content: '# Notes ✓ ünïcödé 日本語\r\n',
      executable: false,
    },
    { path: 'hook.sh', encoding: 'utf8', content: '#!/bin/sh\necho hi\n', executable: true },
    { path: 'logo.png', encoding: 'base64', content: 'iVBORw0KGgo=', executable: false },
  ],
};

/** gzip bytes for any JSON value, to build invalid bundles the codec must reject. */
const gzipJson = (value: unknown): Uint8Array => gzipSync(strToU8(JSON.stringify(value)));

describe('encode and decode', () => {
  it('round-trips a bundle exactly, including Unicode and base64 files', async () => {
    const bytes = await codec.encode(bundle);
    expect(await codec.decode(bytes)).toEqual(bundle);
  });

  it('produces gzip (magic bytes 1f 8b)', async () => {
    const bytes = await codec.encode(bundle);
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
  });

  it('compresses typical config text', async () => {
    const big: Bundle = {
      ...bundle,
      files: [
        {
          path: 'CLAUDE.md',
          encoding: 'utf8',
          content: 'Use pnpm. Run tests before committing.\n'.repeat(500),
          executable: false,
        },
      ],
    };
    const json = JSON.stringify(big);
    expect((await codec.encode(big)).length).toBeLessThan(json.length / 10);
  });

  it('is deterministic: the same bundle always gives the same bytes', async () => {
    expect(await codec.encode(bundle)).toEqual(await codec.encode(bundle));
  });

  it('refuses to encode an invalid bundle', async () => {
    const bad = { ...bundle, files: [{ ...bundle.files[0], path: '../escape' }] } as Bundle;
    await expect(codec.encode(bad)).rejects.toThrow();
  });
});

describe('decode rejects anything that is not a valid bundle', () => {
  it.each<[string, Uint8Array]>([
    ['empty input', new Uint8Array()],
    ['random bytes', new Uint8Array(64).fill(7)],
    ['gzip of plain text', gzipSync(strToU8('hello'))],
    ['gzip of JSON that is not a bundle', gzipJson({ hello: 'world' })],
    [
      'a bundle with a traversal path',
      gzipJson({ ...bundle, files: [{ ...bundle.files[0], path: '../x' }] }),
    ],
  ])('%s', async (_, bytes) => {
    await expect(codec.decode(bytes)).rejects.toThrow(BundleFormatError);
  });

  it('rejects a truncated bundle', async () => {
    const bytes = await codec.encode(bundle);
    await expect(codec.decode(bytes.slice(0, bytes.length - 10))).rejects.toThrow(
      BundleFormatError,
    );
  });

  it('explains an unsupported format version so the user knows to update', async () => {
    await expect(codec.decode(gzipJson({ ...bundle, formatVersion: 2 }))).rejects.toThrow(
      /format version 2/,
    );
  });
});

describe('decompression bomb protection', () => {
  // 1 MB more than the limit, made of zeros: compresses to a few dozen KB.
  const bomb = gzipSync(new Uint8Array(MAX_DECOMPRESSED_BUNDLE_BYTES + 1024 * 1024));

  it('limits decompressed bundles to 64 MB', () => {
    expect(MAX_DECOMPRESSED_BUNDLE_BYTES).toBe(64 * 1024 * 1024);
  });

  it('rejects a bomb from its size label before decompressing', async () => {
    await expect(codec.decode(bomb)).rejects.toThrow(/too large/);
  });

  it('still stops a bomb whose size label lies', async () => {
    const lying = bomb.slice();
    // gzip stores the original size in its last 4 bytes; claim it is only 100 bytes.
    new DataView(lying.buffer).setUint32(lying.length - 4, 100, true);
    await expect(codec.decode(lying)).rejects.toThrow(/too large/);
  });
});
