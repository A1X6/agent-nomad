import type { ErrorCode } from '@agentnomad/contracts';

export interface ApiErrorDetails {
  /** Set on `revision_conflict`: the revision now saved on the server. */
  readonly currentRevision?: number;
  /** Set on `rate_limited`: seconds until another attempt is allowed (Retry-After). */
  readonly retryAfterSeconds?: number;
}

/** The server answered with an error, e.g. wrong password, conflict or rate limit (T21). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly currentRevision: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, code: ErrorCode, message: string, details: ApiErrorDetails = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.currentRevision = details.currentRevision;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

/** Why the server could not be reached. */
export type NetworkFailure = 'timeout' | 'unreachable' | 'server_unavailable';

/** The server could not be reached, even after retrying. Nothing is known to have changed. */
export class NetworkError extends Error {
  readonly failure: NetworkFailure;

  constructor(failure: NetworkFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NetworkError';
    this.failure = failure;
  }
}

/**
 * A request that is never retried (register, account delete) got no clear answer: the
 * server may or may not have done it. Retrying blindly would report a misleading error
 * (e.g. "username taken" for the account just created), so the command explains instead.
 */
export class OutcomeUnknownError extends Error {
  readonly operation: 'register' | 'delete-account';

  constructor(operation: 'register' | 'delete-account', options?: ErrorOptions) {
    super(
      operation === 'register'
        ? 'Could not confirm the account was created. Try `agentnomad login`: if it works, the account exists.'
        : 'Could not confirm the account was deleted. Try `agentnomad login`: if it fails, the account is gone.',
      options,
    );
    this.name = 'OutcomeUnknownError';
    this.operation = operation;
  }
}

/** The server's answer did not match the API contract (wrong version or a proxy page). */
export class InvalidResponseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidResponseError';
  }
}

/** A command needs a session but none is stored on this PC. */
export class NotLoggedInError extends Error {
  constructor() {
    super('Not logged in. Run `agentnomad login` first.');
    this.name = 'NotLoggedInError';
  }
}
