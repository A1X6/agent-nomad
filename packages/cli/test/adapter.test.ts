import { describe, expect, it } from 'vitest';

import { reviewCovers } from '../src/index.ts';

/*
 * The one function `agents/adapter.ts` exports besides its interfaces (review 16 BP-03); the
 * interfaces themselves are proved by `agent-boundary.test.ts`.
 */
describe('reviewCovers: which files a reviewed entry stands for (T96)', () => {
  it.each([
    ['settings.json', 'settings.json', true],
    ['settings.json', 'settings.json.bak', false],
    ['skills/my-mod/', 'skills/my-mod/hooks/register.ts', true],
    // A sibling whose path starts like the folder's is another folder.
    ['skills/my-mod/', 'skills/my-mod-2/SKILL.md', false],
    // The folder's own path can only be a stray file of a tampered bundle: dropped with the plugin.
    ['skills/my-mod/', 'skills/my-mod', true],
  ])('%s covers %s: %s', (file, path, covered) => {
    expect(reviewCovers(file, path)).toBe(covered);
  });
});
