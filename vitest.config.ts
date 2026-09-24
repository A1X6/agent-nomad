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
      },
    })),
  },
});
