import { z } from 'zod';

/** Database settings, read from the environment (`packages/server/.env` locally). */
export const DatabaseEnvSchema = z.object({
  DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: 'DATABASE_URL must be a postgres:// or postgresql:// connection string',
  }),
});

export type DatabaseEnv = z.infer<typeof DatabaseEnvSchema>;

/**
 * Validates the database settings. Throws a readable error that names the setting but never
 * prints its value, since the connection string contains the database password.
 */
export function readDatabaseEnv(env: Readonly<Record<string, string | undefined>>): DatabaseEnv {
  const result = DatabaseEnvSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid database settings:\n${problems.join('\n')}`);
  }
  return result.data;
}
