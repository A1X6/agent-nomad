import { describe, expect, it } from 'vitest';

import { fromBase64, fromHex, sameBytes, toBase64, toHex } from '../src/index.ts';

const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index);

describe('byte encodings (BP-03)', () => {
  it.each([
    ['no bytes', new Uint8Array()],
    ['every byte value', allBytes],
  ])('round-trips %s through base64 and hex', (_, bytes) => {
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });

  it('writes lowercase hex, two characters per byte', () => {
    expect(toHex(Uint8Array.from([0, 10, 255]))).toBe('000aff');
  });

  it('reads hex in either case', () => {
    expect(fromHex('0aFF')).toEqual(Uint8Array.from([10, 255]));
  });

  it.each([
    ['an odd number of characters', 'abc'],
    ['a pair that is not hex', 'zz'],
    ['a space', '0a ff'],
    ['a sign', '+a'],
  ])('refuses hex with %s', (_, text) => {
    expect(() => fromHex(text)).toThrow('Not a hex string');
  });

  it('compares bytes by length and content', () => {
    expect(sameBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 2]))).toBe(true);
    expect(sameBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 3]))).toBe(false);
    expect(sameBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 0]))).toBe(false);
  });
});
