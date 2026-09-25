import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Not part of `pnpm test`: these run the built CLI (`pnpm test:e2e` builds it first).
export default defineConfig({
  // Workspace packages resolve to their TypeScript source, like the unit tests.
  ssr: { resolve: { conditions: ['agentnomad-source', ...defaultServerConditions] } },
  test: {
    name: '@agentnomad/e2e',
    include: ['test/**/*.test.ts'],
    // Each step runs real commands (key derivation, compression, a local API): minutes, not ms.
    testTimeout: 10 * 60_000,
  },
});
