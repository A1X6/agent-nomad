import * as z from 'zod';

import type { Prompter } from '../ui/prompter.ts';
import type { EnvScan } from './env-references.ts';

/**
 * Variable values the user chose to save, inside the (encrypted) bundle (T30). Never
 * written to disk as a file on restore; pull offers to add them to the shell profile.
 */
export const ENV_BUNDLE_PATH = '.agentnomad/env.json';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A value that could break the marked block in a shell profile (T38): a NUL byte, or a line
 * that looks like agentnomad's own block start or end, which the next update would misread.
 */
const SafeValue = z
  .string()
  .max(32_768)
  .refine((value) => !value.includes('\0'), 'A value must not contain a NUL byte')
  .refine(
    (value) => !/^# (>>>|<<<) agentnomad env (>>>|<<<)$/m.test(value),
    'A value must not contain an agentnomad block marker line',
  );

export const EnvSectionSchema = z.strictObject({
  variables: z.record(z.string().regex(NAME), SafeValue),
});
export type EnvSection = z.infer<typeof EnvSectionSchema>;

export const envSectionFile = (section: EnvSection) => ({
  path: ENV_BUNDLE_PATH,
  content: new TextEncoder().encode(`${JSON.stringify(section, null, 2)}\n`),
  executable: false,
});

/** Reads a bundle's env section; `null` when absent or damaged. */
export function parseEnvSection(content: Uint8Array): EnvSection | null {
  try {
    const parsed = EnvSectionSchema.safeParse(JSON.parse(new TextDecoder().decode(content)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface ChooseEnvValuesDeps {
  readonly scan: EnvScan;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly prompter: Pick<Prompter, 'multiselect'>;
}

/**
 * On push: which values to save with the setup. Only variables set on this PC can be
 * saved, and none are ticked until the user ticks them (opt-in).
 */
export async function chooseEnvValues(deps: ChooseEnvValuesDeps): Promise<EnvSection | null> {
  const available = deps.scan.variables.filter(
    (variable) => (deps.env[variable.name] ?? '') !== '',
  );
  if (available.length === 0) return null;
  const chosen = await deps.prompter.multiselect(
    'Save these values with your setup (encrypted; only you can read them)? Leave all unticked to save none.',
    available.map((variable) => ({
      value: variable.name,
      label: variable.name,
      hint: variable.usedBy.join('; '),
    })),
    { required: false, initial: [] },
  );
  if (chosen.length === 0) return null;
  const variables: Record<string, string> = {};
  for (const name of chosen) {
    const value = deps.env[name];
    if (value !== undefined) variables[name] = value;
  }
  return { variables };
}
