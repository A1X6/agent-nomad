// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

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
    // The agent boundary (T61): the commands reach an agent only through the adapter
    // interfaces in `agents/adapter.ts`, so a second agent needs no change here.
    files: ['packages/cli/src/{push,pull,cli}/**/*.ts'],
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
  // Turns off rules that would fight with Prettier's formatting. Must stay last.
  prettier,
);
