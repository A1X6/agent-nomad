import { describe, expect, it } from 'vitest';

import { fakeApi } from './fakes.ts';
import { listAllBundles } from '../src/index.ts';

describe('listing saved setups stops on a server that never ends (T46)', () => {
  it('refuses a cursor it has already seen', async () => {
    let calls = 0;
    const api = fakeApi({
      bundles: {
        list: () => {
          calls += 1;
          return Promise.resolve({ items: [], nextCursor: 'same' });
        },
      },
    });
    await expect(listAllBundles(api)).rejects.toThrow('kept sending more pages');
    expect(calls).toBe(2);
  });
});
