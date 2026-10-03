import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { parseJsonWith, valueOrNull } from '../src/system/json.ts';

describe('parseJsonWith: JSON with a schema, and why it failed (DUP-04)', () => {
  const Schema = z.object({ name: z.string() });

  it('reads text and UTF-8 bytes', () => {
    expect(parseJsonWith(Schema, '{"name":"a"}')).toEqual({ value: { name: 'a' } });
    expect(parseJsonWith(Schema, new TextEncoder().encode('{"name":"é"}'))).toEqual({
      value: { name: 'é' },
    });
  });

  it('says when the text is not JSON', () => {
    expect(parseJsonWith(Schema, '{')).toEqual({ problem: 'not valid JSON' });
  });

  it('names where the shape is wrong', () => {
    const result = parseJsonWith(Schema, '{"name":1}');
    expect('problem' in result && result.problem.startsWith('name: ')).toBe(true);
  });

  it('valueOrNull gives the value or null', () => {
    expect(valueOrNull(parseJsonWith(Schema, '{"name":"a"}'))).toEqual({ name: 'a' });
    expect(valueOrNull(parseJsonWith(Schema, '[]'))).toBeNull();
  });
});
