import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { readFirstLine } from '../src/index.ts';

describe('--password-stdin', () => {
  const piped = (...chunks: string[]) => Readable.from(chunks.map((chunk) => Buffer.from(chunk)));

  it.each([
    ['a line ending', ['secret-pass\n'], 'secret-pass'],
    ['a Windows line ending', ['secret-pass\r\n'], 'secret-pass'],
    ['no line ending', ['secret-pass'], 'secret-pass'],
    ['only the first line', ['first\nsecond\n'], 'first'],
    ['split into chunks', ['sec', 'ret-', 'pass\n'], 'secret-pass'],
    ['spaces kept', ['  pass with spaces  \n'], '  pass with spaces  '],
    ['nothing', [], ''],
  ])('reads the password: %s', async (_, chunks, expected) => {
    expect(await readFirstLine(piped(...chunks))).toBe(expected);
  });

  it('refuses a terminal, where it would wait silently', async () => {
    const terminal = Object.assign(piped('x\n'), { isTTY: true });
    await expect(readFirstLine(terminal)).rejects.toThrow('reads the password from a pipe');
  });

  it('refuses a huge input', async () => {
    await expect(readFirstLine(piped('x'.repeat(70 * 1024)))).rejects.toThrow('too long');
  });
});
