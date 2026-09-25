import type { ErrorCode, ErrorResponse } from '@agentnomad/contracts';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** An error the API reports to the client as `{ error: { code, message } }`. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode;
  readonly currentRevision: number | undefined;

  constructor(
    status: ContentfulStatusCode,
    code: ErrorCode,
    message: string,
    currentRevision?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

export function errorJson(c: Context, error: ApiError): Response {
  const body: ErrorResponse = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.currentRevision !== undefined && { currentRevision: error.currentRevision }),
    },
  };
  return c.json(body, error.status);
}

/** Codes for errors Hono itself raises (bad JSON, body too large). */
function codeForStatus(status: number): ErrorCode {
  if (status === 413) return 'payload_too_large';
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status < 500) return 'bad_request';
  return 'internal_error';
}

/** Every uncaught error becomes the standard error body; details of 500s never leak. */
export function handleError(error: Error, c: Context): Response {
  if (error instanceof ApiError) return errorJson(c, error);
  if (error instanceof HTTPException && error.status < 500) {
    return errorJson(c, new ApiError(error.status, codeForStatus(error.status), error.message));
  }
  console.error(error);
  return errorJson(c, new ApiError(500, 'internal_error', 'Something went wrong on the server'));
}

export function handleNotFound(c: Context): Response {
  return errorJson(c, new ApiError(404, 'not_found', 'No such endpoint'));
}
