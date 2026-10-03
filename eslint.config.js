// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * An agent's folder (and `agents/shared/`) never imports another agent's folder (ARCH-02):
 * a change made for one agent must not change another. `../adapter.ts`, `../shared/` and
 * generic code further up stay allowed.
 */
const otherAgentFolder = {
  regex: String.raw`^\.\./(?!shared/)[^./][^/]*/`,
  message: 'An agent uses agents/adapter.ts, agents/shared/ and generic code, never another agent.',
};

/** The pure Claude Code rule modules never walk files (SOLID-05, ARCH-04). */
const fileWalker = {
  group: ['**/file-gathering.ts'],
  message: 'This module is pure: it gets file contents, it does not read them.',
};

/** Settings parsing has no file access at all (SOLID-05, ARCH-04). */
const nodeModules = {
  group: ['node:*'],
  message: 'Settings parsing works on text only, with no file or process access.',
};

/** @param {readonly object[]} patterns */
const restrictedImports = (patterns) => ({
  'no-restricted-imports': ['error', { patterns: [...patterns] }],
});

/** `no-restricted-imports` does not see `import()`, so the pure modules have none. */
const noDynamicImport = {
  'no-restricted-syntax': [
    'error',
    { selector: 'ImportExpression', message: 'The pure modules load nothing at run time.' },
  ],
};

export default defineConfig(
  { ignores: ['**/dist/**', '**/coverage/**', 'brag-output/**'] },
  {
    files: ['**/*.{js,ts}'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root config files are not part of any package tsconfig,
          // so they are checked with the shared base settings instead.
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts'],
          defaultProject: 'tsconfig.base.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The agent boundary (T61): the commands and the shared env scan (ARCH-01) reach an
    // agent only through the adapter interfaces in `agents/adapter.ts`, so a second agent
    // needs no change here.
    files: ['packages/cli/src/{push,pull,cli,env}/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/agents/*/**'],
              message:
                'Commands use an agent only through the adapter interfaces (agents/adapter.ts).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/cli/src/agents/*/*.ts'],
    rules: restrictedImports([otherAgentFolder]),
  },
  {
    // Later blocks replace the rule's options, so each repeats the agent boundary.
    files: ['packages/cli/src/agents/claude-code/{restore-rules,command-review,auto-memory}.ts'],
    rules: { ...restrictedImports([otherAgentFolder, fileWalker]), ...noDynamicImport },
  },
  {
    files: ['packages/cli/src/agents/claude-code/settings-commands.ts'],
    rules: {
      ...restrictedImports([otherAgentFolder, fileWalker, nodeModules]),
      ...noDynamicImport,
    },
  },
  // Turns off rules that would fight with Prettier's formatting. Must stay last.
  prettier,
);
