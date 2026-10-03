import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

const packages = ['contracts', 'core', 'cli', 'server'];

export default defineConfig({
  // Workspace packages resolve to their TypeScript source in tests (the "agentnomad-source"
  // export condition), so tests never run against a stale or missing dist/ build.
  ssr: { resolve: { conditions: ['agentnomad-source', ...defaultServerConditions] } },
  test: {
    // One test project per package. Only TypeScript tests under test/ are run,
    // never the compiled copies that `tsc --build` writes to dist/.
    projects: packages.map((name) => ({
      test: {
        name: `@agentnomad/${name}`,
        include: [`packages/${name}/test/**/*.test.ts`],
        // Server tests start an in-memory Postgres (PGlite) with every migration for each
        // test, which a slow or busy CI runner can take seconds to do (QA-12).
        ...(name === 'server' && { testTimeout: 15_000, hookTimeout: 30_000 }),
      },
    })),
    // T64: off in `pnpm test`; `pnpm test:coverage` turns it on. A report only, no threshold.
    coverage: {
      provider: 'v8',
      include: packages.map((name) => `packages/${name}/src/**/*.ts`),
      reporter: ['text-summary', 'text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
    },
  },
});
