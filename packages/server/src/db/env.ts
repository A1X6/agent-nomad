import { z } from 'zod';

/** Database settings, read from the environment (`packages/server/.env` locally). */
export const DatabaseEnvSchema = z.object({
  DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: 'DATABASE_URL must be a postgres:// or postgresql:// connection string',
  }),
});

export type DatabaseEnv = z.infer<typeof DatabaseEnvSchema>;

/** Smallest server secret accepted, in bytes (256 bits). */
export const MIN_SERVER_SECRET_BYTES = 32;

function decodedLength(base64: string): number {
  try {
    return atob(base64).length;
  } catch {
    return 0;
  }
}

/**
 * Everything the API server needs. SERVER_SECRET keys the auth-key hashes and fake prelogin
 * salts: it must never change or leak, or no existing user can log in.
 */
export const ServerEnvSchema = DatabaseEnvSchema.extend({
  SERVER_SECRET: z
    .base64({ error: 'SERVER_SECRET must be base64 (generate: openssl rand -base64 32)' })
    .refine(
      // Zod runs this even when the base64 check already failed, so decode defensively.
      (value) => decodedLength(value) >= MIN_SERVER_SECRET_BYTES,
      `SERVER_SECRET must be at least ${String(MIN_SERVER_SECRET_BYTES)} random bytes`,
    ),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

/**
 * Validates the database settings. Throws a readable error that names the setting but never
 * prints its value, since the connection string contains the database password.
 */
export function readDatabaseEnv(env: Readonly<Record<string, string | undefined>>): DatabaseEnv {
  return parseEnv(DatabaseEnvSchema, env, 'database');
}

/** Validates the API server settings, with the same never-print-values rule. */
export function readServerEnv(env: Readonly<Record<string, string | undefined>>): ServerEnv {
  return parseEnv(ServerEnvSchema, env, 'server');
}

function parseEnv<T>(
  schema: z.ZodType<T>,
  env: Readonly<Record<string, string | undefined>>,
  label: string,
): T {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid ${label} settings:\n${problems.join('\n')}`);
  }
  return result.data;
}
