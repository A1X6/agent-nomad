import { describe, expect, it } from 'vitest';

import { isLoaderVariable } from '../src/index.ts';

describe('isLoaderVariable: variables that make programs run code (T44, T55)', () => {
  it.each([
    'PROMPT_COMMAND',
    'BASH_ENV',
    'ENV',
    'ZDOTDIR',
    'NODE_OPTIONS',
    'NODE_PATH',
    'PYTHONSTARTUP',
    'PYTHONPATH',
    'PYTHONHOME',
    'PERL5OPT',
    'PERL5LIB',
    'RUBYOPT',
    'JAVA_TOOL_OPTIONS',
    'JDK_JAVA_OPTIONS',
    '_JAVA_OPTIONS',
    'GIT_SSH_COMMAND',
    'GIT_EXTERNAL_DIFF',
    'GIT_ASKPASS',
    'GIT_EDITOR',
    'GIT_PAGER',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_PARAMETERS',
    'GIT_TEMPLATE_DIR',
    'XDG_CONFIG_HOME',
    'SSH_ASKPASS',
    'EDITOR',
    'VISUAL',
    'PAGER',
    'LESSOPEN',
    'LESSCLOSE',
    'BASH_FUNC_ls%%',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
  ])('%s is a loader', (name) => {
    expect(isLoaderVariable(name)).toBe(true);
  });

  it.each(['node_options', 'ld_preload', 'git_config_parameters'])(
    '%s is a loader in lower case too (Windows ignores case)',
    (name) => {
      expect(isLoaderVariable(name)).toBe(true);
    },
  );

  it.each(['DEBUG', 'HOME', 'EDITOR_THEME', 'MY_PAGER', 'NODE_ENV', 'XDG_DATA_HOME'])(
    '%s is not',
    (name) => {
      expect(isLoaderVariable(name)).toBe(false);
    },
  );
});
