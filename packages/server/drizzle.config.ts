import { existsSync } from 'node:fs';

import { defineConfig } from 'drizzle-kit';

import { readDatabaseEnv } from './src/db/env.ts';

// Local settings live in packages/server/.env (git-ignored). CI and hosts set real env vars.
if (existsSync('.env')) process.loadEnvFile('.env');

// `generate` and `check` work offline; only these commands connect to a database.
const needsDatabase = ['migrate', 'push', 'pull', 'studio'].some((command) =>
  process.argv.includes(command),
);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
  ...(needsDatabase && { dbCredentials: { url: readDatabaseEnv(process.env).DATABASE_URL } }),
});
