import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { configDir } from '../src/index.ts';

const posix = process.platform !== 'win32';

describe('configDir', () => {
  it('uses %APPDATA% on Windows', () => {
    expect(
      configDir({
        platform: 'win32',
        homedir: 'C:\\Users\\a',
        env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' },
      }),
    ).toMatch(/AppData[\\/]Roaming[\\/]agentnomad$/);
  });

  it('uses XDG_CONFIG_HOME when absolute, else ~/.config', () => {
    const home = posix ? '/home/a' : 'C:\\home\\a';
    const xdg = posix ? '/xdg' : 'C:\\xdg';
    expect(configDir({ platform: 'linux', homedir: home, env: { XDG_CONFIG_HOME: xdg } })).toBe(
      join(xdg, 'agentnomad'),
    );
    expect(configDir({ platform: 'darwin', homedir: home, env: { XDG_CONFIG_HOME: 'rel' } })).toBe(
      join(home, '.config', 'agentnomad'),
    );
  });
});
