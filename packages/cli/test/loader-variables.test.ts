import { describe, expect, it } from 'vitest';

import { LOADER_VARIABLE } from '../src/index.ts';

describe('LOADER_VARIABLE: variables that make programs run code (T44, T55)', () => {
  it.each([
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'NODE_PATH',
    'PYTHONHOME',
    'JAVA_TOOL_OPTIONS',
    'JDK_JAVA_OPTIONS',
    '_JAVA_OPTIONS',
    'GIT_ASKPASS',
    'SSH_ASKPASS',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_EDITOR',
    'GIT_PAGER',
    'EDITOR',
    'VISUAL',
    'PAGER',
    'LESSOPEN',
    'LESSCLOSE',
    'BASH_FUNC_ls%%',
  ])('%s is a loader', (name) => {
    expect(LOADER_VARIABLE.test(name)).toBe(true);
  });

  it.each(['DEBUG', 'HOME', 'GIT_AUTHOR_NAME', 'EDITOR_THEME', 'MY_PAGER', 'NODE_ENV'])(
    '%s is not',
    (name) => {
      expect(LOADER_VARIABLE.test(name)).toBe(false);
    },
  );
});
