import * as z from 'zod';

import { RESERVED_DIR } from '../agents/adapter.ts';
import type { EnvValuesChoice } from '../cli/commands.ts';
import { ENV_VALUES_ALL, ENV_VALUES_NONE, QUESTION_REASON } from '../cli/help-text.ts';
import { parseJsonWith, valueOrNull } from '../system/json.ts';
import type { Prompter } from '../ui/prompter.ts';
import type { EnvScan } from './env-references.ts';

/**
 * Variable values the user chose to save, inside the (encrypted) bundle (T30). Never
 * written to disk as a file on restore; pull offers to add them to the shell profile.
 */
export const ENV_BUNDLE_PATH = `${RESERVED_DIR}/env.json`;

/** An environment variable name a setup can save: letters, digits and `_`, no digit first. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  variables: z.record(z.string().regex(ENV_NAME), SafeValue),
});
export type EnvSection = z.infer<typeof EnvSectionSchema>;

export const envSectionFile = (section: EnvSection) => ({
  path: ENV_BUNDLE_PATH,
  content: new TextEncoder().encode(`${JSON.stringify(section, null, 2)}\n`),
  executable: false,
});

/** Reads a bundle's env section; `null` when absent or damaged. */
export const parseEnvSection = (content: Uint8Array): EnvSection | null =>
  valueOrNull(parseJsonWith(EnvSectionSchema, content));

export interface ChooseEnvValuesDeps {
  readonly scan: EnvScan;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly prompter: Pick<Prompter, 'multiselect'>;
  /** `--env-values`: the answer, instead of asking (T115). */
  readonly choice?: EnvValuesChoice;
  /** `--yes` without `--env-values`: save none, without asking. */
  readonly assumeYes?: boolean;
}

/**
 * On push: which values to save with the setup. Only variables the setup uses and this PC
 * has set can be saved, and none are ticked until the user ticks them (opt-in);
 * `--env-values` answers instead (a name the setup does not use, or this PC has not set, is
 * not saved), and `--yes` alone saves none.
 */
export async function chooseEnvValues(deps: ChooseEnvValuesDeps): Promise<EnvSection | null> {
  const available = deps.scan.variables.filter(
    (variable) => (deps.env[variable.name] ?? '') !== '',
  );
  if (available.length === 0 || deps.choice === ENV_VALUES_NONE) return null;
  const { choice } = deps;
  let chosen: readonly string[];
  if (choice === ENV_VALUES_ALL) chosen = available.map((variable) => variable.name);
  else if (choice !== undefined) {
    chosen = available.map((variable) => variable.name).filter((name) => choice.includes(name));
  } else if (deps.assumeYes === true) return null;
  else {
    chosen = await deps.prompter.multiselect(
      `Save these environment variable values with your setup? ${QUESTION_REASON.envValuesPush}`,
      available.map((variable) => ({
        value: variable.name,
        label: variable.name,
        hint: variable.usedBy.join('; '),
      })),
      { required: false, initial: [] },
    );
  }
  if (chosen.length === 0) return null;
  const variables: Record<string, string> = {};
  for (const name of chosen) {
    const value = deps.env[name];
    if (value !== undefined) variables[name] = value;
  }
  return { variables };
}
