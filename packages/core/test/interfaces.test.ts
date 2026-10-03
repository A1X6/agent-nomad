import { describe, expectTypeOf, it } from 'vitest';

import type { Aead, CryptoService, Digest, MergeStrategy, PlannedWrite } from '../src/index.ts';

// Type-only checks (QA-14): `tsc --build` fails when a contract changes shape.
describe('core interfaces', () => {
  it('a full CryptoService can be passed where only Aead or Digest is needed', () => {
    expectTypeOf<CryptoService>().toExtend<Aead>();
    expectTypeOf<CryptoService>().toExtend<Digest>();
  });

  it('merge strategies return planned writes instead of touching the disk', () => {
    expectTypeOf<ReturnType<MergeStrategy['resolve']>>().toEqualTypeOf<readonly PlannedWrite[]>();
  });
});
