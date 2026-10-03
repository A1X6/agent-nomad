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

/** `updated_at` as Postgres prints it, e.g. `2026-09-25 10:00:00.123456+00`. */
const TIME =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(\.\d{1,6})?[+-](?<offsetHours>\d{2})(:(?<offsetMinutes>\d{2}))?$/;

/** Postgres refuses a time zone offset beyond 15:59. */
const MAX_OFFSET_HOURS = 15;

/**
 * A real moment Postgres can cast to timestamptz: the shape above, a date that exists on the
 * calendar, a time of day and a time zone offset in range. Without this, a well-formed but
 * impossible time (month 13) reached the database and failed as a 500 (BUG-07).
 */
function isRealTime(text: string): boolean {
  const groups = TIME.exec(text)?.groups;
  if (!groups) return false;
  const value = (name: string) => Number(groups[name] ?? 0);
  const [year, month, day] = [value('year'), value('month'), value('day')];
  // Date rolls an impossible day over (February 30 becomes March 2), so compare back.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    value('hour') <= 23 &&
    value('minute') <= 59 &&
    value('second') <= 59 &&
    value('offsetHours') <= MAX_OFFSET_HOURS &&
    value('offsetMinutes') <= 59
  );
}

const CursorSchema = z.tuple([z.string().refine(isRealTime), z.uuid()]);

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
