import {
  API_HEADERS,
  API_ROUTES,
  PutBundleRequestHeadersSchema,
  type PutBundleRequestHeaders,
} from '@agentnomad/contracts';
import { describe, expect, it } from 'vitest';

describe('CLI uses the shared contracts', () => {
  it('builds PUT headers that the server-side schema accepts', () => {
    const headers: Record<string, string> = {
      [API_HEADERS.expectedRevision]: '3',
      [API_HEADERS.contentSha256]: 'f'.repeat(64),
      [API_HEADERS.formatVersion]: '1',
    };
    const parsed: PutBundleRequestHeaders = PutBundleRequestHeadersSchema.parse(headers);
    expect(parsed[API_HEADERS.expectedRevision]).toBe(3);
  });

  it('builds bundle URLs from the shared routes', () => {
    expect(API_ROUTES.bundle('claude-code', 'global')).toBe('/bundles/claude-code/global');
  });
});
