import type * as z from 'zod';

/** JSON read with a schema: the value, or why it could not be read (DUP-04). */
export type JsonResult<T> = { readonly value: T } | { readonly problem: string };

/**
 * Parses JSON text (or UTF-8 bytes) and checks it with `schema`. Never throws: a failure
 * comes back as a short `problem` the caller can show, e.g. "not valid JSON".
 */
export function parseJsonWith<S extends z.ZodType>(
  schema: S,
  content: string | Uint8Array,
): JsonResult<z.infer<S>> {
  let json: unknown;
  try {
    json = JSON.parse(typeof content === 'string' ? content : new TextDecoder().decode(content));
  } catch {
    return { problem: 'not valid JSON' };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { value: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.map(String).join('.') ?? '';
  return { problem: `${where === '' ? '' : `${where}: `}${issue?.message ?? 'unexpected format'}` };
}

/** The value of a {@link JsonResult}, or `null` when it could not be read. */
export const valueOrNull = <T>(result: JsonResult<T>): T | null =>
  'value' in result ? result.value : null;
