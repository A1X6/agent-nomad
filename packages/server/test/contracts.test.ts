import {
  ErrorResponseSchema,
  RegisterRequestSchema,
  type ErrorResponse,
} from '@agentnomad/contracts';
import { describe, expect, it } from 'vitest';

describe('server uses the shared contracts', () => {
  it('rejects a register body missing the wrapped data key', () => {
    const result = RegisterRequestSchema.safeParse({ username: 'ahmed' });
    expect(result.success).toBe(false);
  });

  it('builds error bodies that match the shared error format', () => {
    const body: ErrorResponse = {
      error: { code: 'revision_conflict', message: 'A newer copy exists', currentRevision: 2 },
    };
    expect(ErrorResponseSchema.parse(body)).toEqual(body);
  });
});
