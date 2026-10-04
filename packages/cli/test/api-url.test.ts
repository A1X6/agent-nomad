import { describe, expect, it } from 'vitest';

import { resolveApiUrl } from '../src/index.ts';

describe('resolveApiUrl', () => {
  it('uses the hosted API by default', () => {
    expect(resolveApiUrl({}).href).toBe('https://agentnomad-api.onrender.com/');
  });

  it('accepts https and local http', () => {
    expect(resolveApiUrl({ AGENTNOMAD_API_URL: 'https://example.com' }).host).toBe('example.com');
    expect(resolveApiUrl({ AGENTNOMAD_API_URL: 'http://localhost:3000' }).port).toBe('3000');
  });

  it.each([
    'not a url',
    'http://example.com',
    'ftp://example.com',
    'https://user:pw@example.com',
    'https://example.com/api',
    'https://example.com/?x=1',
  ])('refuses %s', (value) => {
    expect(() => resolveApiUrl({ AGENTNOMAD_API_URL: value })).toThrow('AGENTNOMAD_API_URL');
  });
});
