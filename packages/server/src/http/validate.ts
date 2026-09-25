import { validator } from 'hono/validator';
import type { z } from 'zod';

import { ApiError } from './errors.ts';

/** Parses with a contracts schema; a mismatch is a 400 naming the first issue. */
function parseOr400<TSchema extends z.ZodType>(schema: TSchema, value: unknown): z.infer<TSchema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new ApiError(400, 'bad_request', `${where}${issue?.message ?? 'Invalid request'}`);
  }
  return parsed.data;
}

export const jsonBody = <TSchema extends z.ZodType>(schema: TSchema) =>
  validator('json', (value): z.infer<TSchema> => parseOr400(schema, value));

export const validQuery = <TSchema extends z.ZodType>(schema: TSchema) =>
  validator('query', (value): z.infer<TSchema> => parseOr400(schema, value));

export const validParams = <TSchema extends z.ZodType>(schema: TSchema) =>
  validator('param', (value): z.infer<TSchema> => parseOr400(schema, value));

/** Header names arrive lowercase, matching API_HEADERS. */
export const validHeaders = <TSchema extends z.ZodType>(schema: TSchema) =>
  validator('header', (value): z.infer<TSchema> => parseOr400(schema, value));
