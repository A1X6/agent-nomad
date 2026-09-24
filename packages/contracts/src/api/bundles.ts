import * as z from 'zod';

import { AgentIdSchema } from '../bundle.ts';
import { base64UpTo, Sha256HexSchema, TimestampSchema } from '../primitives.ts';
import { API_HEADERS, MAX_BUNDLE_BYTES, MAX_NAME_ENC_BYTES } from './common.ts';

/** `global`, or the keyed hash of a project name (32 bytes, lowercase hex). Never the name itself. */
export const ScopeKeySchema = z
  .string()
  .regex(
    /^(global|[0-9a-f]{64})$/,
    'Scope key must be "global" or a 64-character lowercase hex hash',
  );

/** Path params of GET, PUT and DELETE /bundles/:agent/:scopeKey. */
export const BundleParamsSchema = z.strictObject({
  agent: AgentIdSchema,
  scopeKey: ScopeKeySchema,
});

const NameEncSchema = base64UpTo(MAX_NAME_ENC_BYTES);

/** Header value holding a whole number, parsed to a number (no signs, decimals or leading zeros). */
const headerInt = (min: 0 | 1) =>
  z
    .string()
    .regex(min === 0 ? /^(0|[1-9]\d{0,9})$/ : /^[1-9]\d{0,9}$/, 'Must be a whole number')
    .transform(Number)
    .pipe(z.int().max(2_147_483_647));

/**
 * GET /bundles query. Values arrive as strings from the URL. Unknown query params are dropped.
 */
export const ListBundlesQuerySchema = z.object({
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,512}$/, 'Invalid cursor')
    .optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/, 'Limit must be a whole number')
    .transform(Number)
    .pipe(z.int().max(100))
    .default(50),
});

/** One saved setup in the list. Metadata only: the ciphertext is never listed. */
export const BundleSummarySchema = z.strictObject({
  agent: AgentIdSchema,
  scopeKey: ScopeKeySchema,
  /** Encrypted project name; `null` for the global scope. */
  nameEnc: NameEncSchema.nullable(),
  revision: z.int().min(1),
  formatVersion: z.int().min(1),
  sizeBytes: z.int().min(1).max(MAX_BUNDLE_BYTES),
  updatedAt: TimestampSchema,
});

export const ListBundlesResponseSchema = z.strictObject({
  items: z.array(BundleSummarySchema).max(100),
  /** Pass back as `cursor` for the next page; `null` on the last page. */
  nextCursor: z.string().nullable(),
});

/**
 * PUT /bundles/:agent/:scopeKey headers. The body is the raw ciphertext
 * (`application/octet-stream`, at most MAX_BUNDLE_BYTES), with its nonce at the start.
 * Unrelated headers such as content-type are ignored.
 */
export const PutBundleRequestHeadersSchema = z.object({
  [API_HEADERS.expectedRevision]: headerInt(0),
  [API_HEADERS.contentSha256]: Sha256HexSchema,
  [API_HEADERS.formatVersion]: headerInt(1),
  [API_HEADERS.nameEnc]: NameEncSchema.optional(),
});

/** PUT succeeded: the stored revision (also returned for an idempotent retry). */
export const PutBundleResponseSchema = z.strictObject({
  revision: z.int().min(1),
  updatedAt: TimestampSchema,
});

/** GET /bundles/:agent/:scopeKey response headers; the body is the raw ciphertext. */
export const GetBundleResponseHeadersSchema = z.object({
  [API_HEADERS.revision]: headerInt(1),
  [API_HEADERS.contentSha256]: Sha256HexSchema,
  [API_HEADERS.formatVersion]: headerInt(1),
  [API_HEADERS.nameEnc]: NameEncSchema.optional(),
});

export type ScopeKey = z.infer<typeof ScopeKeySchema>;
export type BundleParams = z.infer<typeof BundleParamsSchema>;
export type ListBundlesQuery = z.infer<typeof ListBundlesQuerySchema>;
export type BundleSummary = z.infer<typeof BundleSummarySchema>;
export type ListBundlesResponse = z.infer<typeof ListBundlesResponseSchema>;
export type PutBundleRequestHeaders = z.infer<typeof PutBundleRequestHeadersSchema>;
export type PutBundleResponse = z.infer<typeof PutBundleResponseSchema>;
export type GetBundleResponseHeaders = z.infer<typeof GetBundleResponseHeadersSchema>;
