import { ApiError } from '../api/api-errors.ts';

/** "45 seconds", "1 minute", "4 minutes" (rounded up, so the user never retries too early). */
export function describeWait(seconds: number): string {
  if (seconds < 60) {
    const whole = Math.max(1, Math.ceil(seconds));
    return `${String(whole)} second${whole === 1 ? '' : 's'}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
}

/** The one line shown when a command fails. Most errors already carry a plain message. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'rate_limited') {
    return error.retryAfterSeconds === undefined
      ? 'Too many attempts. Wait a while and try again.'
      : `Too many attempts. Try again in ${describeWait(error.retryAfterSeconds)}.`;
  }
  if (error instanceof ApiError && error.code === 'internal_error') {
    return 'Something went wrong on the server. Try again later.';
  }
  return error instanceof Error ? error.message : String(error);
}
