import { describe, expect, it } from 'vitest';

import { createApp, deviceNameOf } from '../src/index.ts';
import { recordingReporter, scriptedPrompter } from './fakes.ts';

describe('deviceNameOf', () => {
  it('device names are one short line', () => {
    expect(deviceNameOf('LAPTOP-01')).toBe('LAPTOP-01');
    expect(deviceNameOf('a\nb')).toBe('ab');
    expect(deviceNameOf('x'.repeat(100))).toHaveLength(64);
    expect(deviceNameOf('  ')).toBe('unknown device');
  });
});

describe('createApp', () => {
  it('offers no part flags, and still runs, where the agents cannot be built (ARCH-02)', () => {
    // A home folder of `/` makes the agents throw; only the commands that need them fail.
    const { handlers, optionalParts } = createApp({
      env: {},
      platform: 'linux',
      homedir: '/',
      hostname: 'pc',
      cwd: '/',
      prompter: scriptedPrompter([]).prompter,
      reporter: recordingReporter().reporter,
    });
    expect(optionalParts).toEqual([]);
    expect(Object.keys(handlers)).toContain('login');
  });
});
