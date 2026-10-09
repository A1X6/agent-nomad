import { describe, expect, it } from 'vitest';

import { reviewCovers } from '../src/index.ts';

/*
 * The one function `agents/adapter.ts` exports besides its interfaces (review 16 BP-03); the
 * interfaces themselves are proved by `agent-boundary.test.ts`.
 */
describe('reviewCovers: which files a reviewed entry stands for (T96)', () => {
  it('a file covers itself; a folder covers what is inside it, not a sibling with the same prefix', () => {
    expect(reviewCovers('settings.json', 'settings.json')).toBe(true);
    expect(reviewCovers('settings.json', 'settings.json.bak')).toBe(false);
    expect(reviewCovers('skills/my-mod/', 'skills/my-mod/hooks/register.ts')).toBe(true);
    expect(reviewCovers('skills/my-mod/', 'skills/my-mod-2/SKILL.md')).toBe(false);
    // The folder's own path can only be a stray file of a tampered bundle: dropped with the plugin.
    expect(reviewCovers('skills/my-mod/', 'skills/my-mod')).toBe(true);
  });
});
