import * as z from 'zod';

import {
  KdfParamsSchema,
  LoginResponseSchema,
  PreloginResponseSchema,
  SessionResponseSchema,
} from './auth.ts';
import {
  BundleSummarySchema,
  ListBundlesResponseSchema,
  MAX_PAGE_ITEMS,
  PutBundleResponseSchema,
} from './bundles.ts';
import { ErrorResponseSchema, HealthResponseSchema } from './common.ts';

/**
 * How the CLI reads the server's answers (T57, ARCH-03): strict on what is sent, tolerant on
 * what is received. Each schema reuses the shape of the strict answer schema the server is
 * typed against, so a field is defined once; only unknown fields are treated differently:
 * dropped here instead of refused. The server deploys long before every CLI updates, so it can
 * add a field without breaking installed CLIs. A missing or wrongly typed known field is still
 * refused, and every bound (KDF settings, sizes, revisions) still applies.
 *
 * `z.object` drops unknown keys; a strict object nested inside it stays strict, so nested
 * objects are converted here too (a test checks none is left).
 */
export const ClientAnswerSchemas = {
  health: z.object(HealthResponseSchema.shape),
  prelogin: z.object({
    ...PreloginResponseSchema.shape,
    kdfParams: z.object(KdfParamsSchema.shape),
  }),
  session: z.object(SessionResponseSchema.shape),
  login: z.object(LoginResponseSchema.shape),
  listBundles: z.object({
    ...ListBundlesResponseSchema.shape,
    items: z.array(z.object(BundleSummarySchema.shape)).max(MAX_PAGE_ITEMS),
  }),
  putBundle: z.object(PutBundleResponseSchema.shape),
  /**
   * Any code is accepted, so the server can add one: the CLI acts on the codes it knows and
   * shows the server's message for the others.
   */
  error: z.object({
    error: z.object({
      ...ErrorResponseSchema.shape.error.shape,
      code: z.string().min(1).max(100),
    }),
  }),
} as const;
