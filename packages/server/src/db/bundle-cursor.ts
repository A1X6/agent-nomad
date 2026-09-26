import { z } from 'zod';

import { InvalidCursorError } from './repositories.ts';

/**
 * Position in a user's newest-first list: the last item's `updated_at` (as Postgres prints
 * it, so no microseconds are lost) and its id as the tie-breaker. Opaque to clients.
 */
export interface BundleCursor {
  readonly updatedAt: string;
  readonly id: string;
}

const CursorSchema = z.tuple([
  z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/),
  z.uuid(),
]);

export function encodeBundleCursor(cursor: BundleCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.id])).toString('base64url');
}

/** Throws InvalidCursorError for anything this server did not produce. */
export function decodeBundleCursor(encoded: string): BundleCursor {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = CursorSchema.safeParse(json);
  if (!parsed.success) throw new InvalidCursorError();
  const [updatedAt, id] = parsed.data;
  return { updatedAt, id };
}
