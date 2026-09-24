import { defineConfig } from 'vitest/config';

const packages = ['contracts', 'core', 'cli', 'server'];

export default defineConfig({
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
