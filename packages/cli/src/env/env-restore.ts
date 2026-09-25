import type { Prompter, Reporter } from '../ui/prompter.ts';
import type { EnvSection } from './env-section.ts';
import type { EnvWriter } from './shell-profile.ts';

export interface RestoreEnvDeps {
  readonly section: EnvSection;
  /** This PC's environment: variables already set here are never overwritten. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly writer: EnvWriter;
  readonly prompter: Pick<Prompter, 'confirm'>;
  readonly reporter: Pick<Reporter, 'info' | 'success'>;
  /** `--yes`: add them without asking. */
  readonly assumeYes?: boolean;
}

export interface RestoreEnvResult {
  readonly added: readonly string[];
  readonly alreadySet: readonly string[];
  readonly declined: boolean;
}

/**
 * On pull (T30): adds the saved variables that are missing on this PC to the shell profile
 * (or Windows user variables), after asking. Values are never shown.
 */
export async function restoreEnvValues(deps: RestoreEnvDeps): Promise<RestoreEnvResult> {
  const names = Object.keys(deps.section.variables).sort();
  const alreadySet = names.filter((name) => (deps.env[name] ?? '') !== '');
  const missing = names.filter((name) => !alreadySet.includes(name));
  if (missing.length === 0) {
    if (names.length > 0)
      deps.reporter.info('The saved environment variables are already set here.');
    return { added: [], alreadySet, declined: false };
  }

  deps.reporter.info(
    [
      `Saved environment variables missing on this PC (values hidden):`,
      ...missing.map((name) => `  + ${name}`),
      `They would be added to ${deps.writer.where}, as plain text on this PC.`,
    ].join('\n'),
  );
  if (
    !deps.assumeYes &&
    !(await deps.prompter.confirm(
      `Add ${String(missing.length)} variable${missing.length === 1 ? '' : 's'}?`,
      true,
    ))
  ) {
    return { added: [], alreadySet, declined: true };
  }

  const values = Object.fromEntries(
    missing.map((name) => [name, deps.section.variables[name] ?? '']),
  );
  const { backup } = await deps.writer.write(values);
  deps.reporter.success(
    [
      `Added ${missing.join(', ')} to ${deps.writer.where}.`,
      ...(backup ? [`Backup of the old file: ${backup}`] : []),
      'Open a new terminal (and restart Claude Code) so they take effect.',
    ].join('\n'),
  );
  return { added: missing, alreadySet, declined: false };
}
