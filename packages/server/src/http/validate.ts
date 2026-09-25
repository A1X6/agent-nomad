import { validator } from 'hono/validator';
import type { z } from 'zod';

import { ApiError } from './errors.ts';

/** Validates a JSON body against a contracts schema; a mismatch is a 400 with the first issue. */
export function jsonBody<T extends z.ZodType>(schema: T) {
  return validator('json', (value): z.infer<T> => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
      throw new ApiError(400, 'bad_request', `${where}${issue?.message ?? 'Invalid request'}`);
    }
    return parsed.data;
  });
}
