import { describe, expect, it } from 'vitest';
import type * as z from 'zod';

import {
  ClientAnswerSchemas,
  ErrorResponseSchema,
  HealthResponseSchema,
  ListBundlesResponseSchema,
  LoginResponseSchema,
  MAX_BUNDLE_BYTES,
  PreloginResponseSchema,
  PutBundleResponseSchema,
  SessionResponseSchema,
} from '../src/index.ts';
import { kdfParams, summary as item, token } from './fixtures.ts';

/** Base64 of 16 and 72 zero bytes. */
const salt = 'A'.repeat(22) + '==';
const wrapped = 'A'.repeat(96);
const session = { sessionToken: token, expiresAt: '2026-12-24T00:00:00Z' };

type Answer = keyof typeof ClientAnswerSchemas;

/**
 * Every answer the CLI reads: a valid example, the strict schema the server is typed against,
 * and where nested objects sit (so an extra field is tried at every level).
 */
const ANSWERS: Record<
  Answer,
  {
    readonly strict: z.ZodType;
    readonly sample: Record<string, unknown>;
    readonly nested: readonly (readonly (string | number)[])[];
  }
> = {
  health: { strict: HealthResponseSchema, sample: { status: 'ok' }, nested: [] },
  prelogin: {
    strict: PreloginResponseSchema,
    sample: { kdfSalt: salt, kdfParams },
    nested: [['kdfParams']],
  },
  session: { strict: SessionResponseSchema, sample: session, nested: [] },
  login: {
    strict: LoginResponseSchema,
    sample: { ...session, wrappedDataKey: wrapped },
    nested: [],
  },
  listBundles: {
    strict: ListBundlesResponseSchema,
    sample: { items: [item], nextCursor: null },
    nested: [['items', 0]],
  },
  putBundle: {
    strict: PutBundleResponseSchema,
    sample: { revision: 2, updatedAt: '2026-09-24T13:00:00Z' },
    nested: [],
  },
  error: {
    strict: ErrorResponseSchema,
    sample: {
      error: { code: 'revision_conflict', message: 'Newer copy exists', currentRevision: 4 },
    },
    nested: [['error']],
  },
};

/** A deep copy of `value` with `extra: true` added to the object at `path`. */
function withExtra(value: Record<string, unknown>, path: readonly (string | number)[]): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(value));
  let target: unknown = copy;
  for (const key of path) target = (target as Record<string | number, unknown>)[key];
  (target as Record<string, unknown>)['extra'] = true;
  return copy;
}

describe('ClientAnswerSchemas: the CLI accepts answers with fields it does not know (ARCH-03)', () => {
  it('covers every answer the CLI reads', () => {
    expect(Object.keys(ClientAnswerSchemas).sort()).toEqual(Object.keys(ANSWERS).sort());
  });

  for (const [name, { strict, sample, nested }] of Object.entries(ANSWERS)) {
    const tolerant = ClientAnswerSchemas[name as Answer];

    it(`${name}: a valid answer parses on both sides to the same value`, () => {
      expect(strict.parse(sample)).toEqual(sample);
      expect(tolerant.parse(sample)).toEqual(sample);
    });

    for (const path of [[], ...nested]) {
      const where = path.length === 0 ? 'the top' : path.join('.');
      it(`${name}: one extra field at ${where} still parses on the client and is dropped`, () => {
        const answer = withExtra(sample, path);
        expect(tolerant.parse(answer)).toEqual(sample);
        // The server's own schema stays strict, so it never sends a field by accident.
        expect(strict.safeParse(answer).success).toBe(false);
      });
    }

    it(`${name}: a missing known field is still refused`, () => {
      const missing = Object.fromEntries(Object.entries(sample).slice(1));
      expect(tolerant.safeParse(missing).success).toBe(false);
    });
  }

  it('still refuses a known field of the wrong type', () => {
    expect(
      ClientAnswerSchemas.putBundle.safeParse({ revision: '2', updatedAt: '2026-09-24T13:00:00Z' })
        .success,
    ).toBe(false);
    expect(ClientAnswerSchemas.listBundles.safeParse({ items: {}, nextCursor: null }).success).toBe(
      false,
    );
  });

  it('keeps the security checks: KDF bounds, sizes and revision numbers', () => {
    const prelogin = (params: object) =>
      ClientAnswerSchemas.prelogin.safeParse({
        kdfSalt: salt,
        kdfParams: { ...kdfParams, ...params },
      }).success;
    expect(prelogin({ memoryKiB: 4 * 1_048_576 })).toBe(false);
    expect(prelogin({ passes: 1_000 })).toBe(false);
    expect(prelogin({ parallelism: 4 })).toBe(false);
    expect(ClientAnswerSchemas.prelogin.safeParse({ kdfSalt: 'c2hvcnQ=', kdfParams }).success).toBe(
      false,
    );

    const list = (summary: object) =>
      ClientAnswerSchemas.listBundles.safeParse({
        items: [{ ...item, ...summary }],
        nextCursor: null,
      }).success;
    expect(list({ sizeBytes: MAX_BUNDLE_BYTES + 1 })).toBe(false);
    expect(list({ revision: 0 })).toBe(false);
    expect(
      ClientAnswerSchemas.listBundles.safeParse({
        items: Array.from({ length: 101 }, () => item),
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      ClientAnswerSchemas.putBundle.safeParse({ revision: 0, updatedAt: '2026-09-24T13:00:00Z' })
        .success,
    ).toBe(false);
  });

  it('error: accepts a code it does not know, but still a short message', () => {
    const answer = { error: { code: 'storage_full', message: 'Your storage is full' } };
    expect(ClientAnswerSchemas.error.parse(answer)).toEqual(answer);
    expect(ErrorResponseSchema.safeParse(answer).success).toBe(false);
    expect(
      ClientAnswerSchemas.error.safeParse({ error: { code: 'x', message: 'm'.repeat(1001) } })
        .success,
    ).toBe(false);
    expect(ClientAnswerSchemas.error.safeParse({ error: { code: '', message: 'm' } }).success).toBe(
      false,
    );
  });

  it('has no strict object left anywhere inside a client schema', () => {
    const strictPaths: string[] = [];
    const walk = (schema: z.core.$ZodType, path: string) => {
      const def = schema._zod.def as unknown as Record<string, unknown> & { type: string };
      if (def.type === 'object') {
        const catchall = def['catchall'] as z.core.$ZodType | undefined;
        if (catchall?._zod.def.type === 'never') strictPaths.push(path || '(top)');
        for (const [key, child] of Object.entries(
          def['shape'] as Record<string, z.core.$ZodType>,
        )) {
          walk(child, `${path}.${key}`);
        }
      }
      for (const key of ['element', 'innerType', 'in', 'out'] as const) {
        const child = def[key] as z.core.$ZodType | undefined;
        if (child?._zod !== undefined) walk(child, `${path}[${key}]`);
      }
    };
    for (const [name, schema] of Object.entries(ClientAnswerSchemas)) walk(schema, name);
    expect(strictPaths).toEqual([]);
  });
});
