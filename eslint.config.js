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

/** The text-rule modules have no file or process access at all (SOLID-05, ARCH-04). */
const nodeModules = {
  group: ['node:*'],
  message: 'This module works on text only (settings, plugins): no file or process access.',
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
    // The agent boundary (T61): every generic folder (the commands, the shared env scan and
    // what they build on) reaches an agent only through the adapter interfaces in
    // `agents/adapter.ts`, so a second agent needs no change here. Only `app.ts` and
    // `index.ts` name an agent's folder.
    files: [
      'packages/cli/src/{api,auth,cli,commands,config,env,pull,push,secrets,state,system,ui}/**/*.ts',
    ],
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
    // The generic files of `agents/` itself (`adapter.ts`, `registry.ts`, ...) keep the same
    // boundary (ARCH-01). From there an agent's folder is `./<id>/`, which the pattern above
    // does not see; `./shared/` stays allowed.
    files: ['packages/cli/src/agents/*.ts'],
    rules: restrictedImports([
      {
        regex: String.raw`^\./(?!shared/)[^./][^/]*/`,
        message:
          'Generic agent code uses an agent only through the adapter interfaces (agents/adapter.ts).',
      },
    ]),
  },
  {
    files: ['packages/cli/src/agents/*/*.ts'],
    rules: restrictedImports([otherAgentFolder]),
  },
  {
    // Later blocks replace the rule's options, so each repeats the agent boundary. Auto memory
    // reads the memory folder itself, so it keeps only the walker rule.
    files: ['packages/cli/src/agents/claude-code/auto-memory.ts'],
    rules: { ...restrictedImports([otherAgentFolder, fileWalker]), ...noDynamicImport },
  },
  {
    // The pure text-rule modules and the shared path rules they use, one list (review 15 BP-01,
    // review 17 ARCH-02).
    files: [
      'packages/cli/src/agents/claude-code/{restore-rules,command-review,settings-commands,skills-dir-plugins}.ts',
      'packages/cli/src/agents/shared/bundle-paths.ts',
    ],
    rules: {
      ...restrictedImports([otherAgentFolder, fileWalker, nodeModules]),
      ...noDynamicImport,
    },
  },
  // Turns off rules that would fight with Prettier's formatting. Must stay last.
  prettier,
);
