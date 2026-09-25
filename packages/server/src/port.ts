import { z } from 'zod';

/** Render's default when PORT is not set. */
const DEFAULT_PORT = 10_000;

const PortSchema = z.coerce.number().int().min(1).max(65_535);

/** The port to listen on, from the host's PORT setting. */
export function readPort(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env['PORT'];
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const parsed = PortSchema.safeParse(raw);
  if (!parsed.success) throw new Error('PORT must be a whole number from 1 to 65535');
  return parsed.data;
}
