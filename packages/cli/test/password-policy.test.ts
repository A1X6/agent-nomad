import { beforeAll, describe, expect, it } from 'vitest';

import { STRONG } from './fakes.ts';
import { createPasswordChecker, loadZxcvbnChecker, type PasswordChecker } from '../src/index.ts';

let zxcvbn: PasswordChecker;
beforeAll(async () => {
  zxcvbn = await loadZxcvbnChecker();
});

describe('password policy', () => {
  it.each([
    'password123456',
    'qwertyuiop12',
    'ahmed1234567890',
    'Summer2026!!!',
    'aaaaaaaaaaaaaaaa',
    'agentnomad2026!',
    'short1!',
  ])('rejects %s', (password) => {
    expect(zxcvbn(password, ['ahmed'])).toBeDefined();
  });

  it.each([STRONG, 'correct horse battery staple', 'purple monkey dishwasher', 'k9$Lm2#vQ8!pZr'])(
    'accepts %s',
    (password) => {
      expect(zxcvbn(password, ['ahmed'])).toBeUndefined();
    },
  );

  it('counts characters, not bytes, and caps the length', () => {
    const accept = createPasswordChecker(() => ({ score: 4, warning: null, suggestions: [] }));
    expect(accept('ééééééééééé', [])).toContain('at least 12');
    expect(accept('éééééééééééé', [])).toBeUndefined();
    expect(accept('x'.repeat(257), [])).toContain('at most 256');
  });
});
