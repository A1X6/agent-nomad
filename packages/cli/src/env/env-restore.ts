import { isRedirectVariable } from '../pull/reviewed-settings.ts';
import type { Prompter, Reporter } from '../ui/prompter.ts';
import type { EnvSection } from './env-section.ts';
import { LOADER_VARIABLE } from './loader-variables.ts';
import type { EnvWriter } from './shell-profile.ts';

export interface RestoreEnvDeps {
  readonly section: EnvSection;
  /** This PC's environment: variables already set here are never overwritten. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly writer: EnvWriter;
  readonly prompter: Pick<Prompter, 'confirm'>;
  readonly reporter: Pick<Reporter, 'info' | 'success' | 'warn'>;
  /** `--yes`: add them without asking, except ones that load code or redirect traffic. */
  readonly assumeYes?: boolean;
  /** `--allow-commands`: add those too without asking (T44, T56). */
  readonly allowCommands?: boolean;
}

export interface RestoreEnvResult {
  readonly added: readonly string[];
  readonly alreadySet: readonly string[];
  readonly declined: boolean;
}

/**
 * Which saved variables this PC already has (T56): set in this process's environment, or
 * with the saved value already where the writer puts it (the shell profile block or the
 * Windows user variables), which a terminal opened before the last pull does not see yet.
 * Shared by the restore and pull's no-terminal pre-check.
 */
export async function splitEnvValues(
  variables: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>>,
  writer: Pick<EnvWriter, 'current'>,
): Promise<{ readonly alreadySet: string[]; readonly missing: string[] }> {
  const names = Object.keys(variables).sort();
  const unset = names.filter((name) => (env[name] ?? '') === '');
  const written = unset.length > 0 ? await writer.current(unset) : new Map<string, string>();
  const missing = unset.filter((name) => written.get(name) !== variables[name]);
  return { alreadySet: names.filter((name) => !missing.includes(name)), missing };
}

/**
 * On pull (T30): adds the saved variables that are missing on this PC to the shell profile
 * (or Windows user variables), after asking. Values are never shown. Variables that make a
 * shell or runtime load code (`NODE_OPTIONS`, `PROMPT_COMMAND`, …) or send programs'
 * requests elsewhere (`HTTPS_PROXY`, `ANTHROPIC_BASE_URL`, …) get their own question with
 * "no" as the default, and `--yes` alone never adds them (T44, T56).
 */
export async function restoreEnvValues(deps: RestoreEnvDeps): Promise<RestoreEnvResult> {
  const names = Object.keys(deps.section.variables);
  const { alreadySet, missing } = await splitEnvValues(
    deps.section.variables,
    deps.env,
    deps.writer,
  );
  if (missing.length === 0) {
    if (names.length > 0)
      deps.reporter.info('The saved environment variables are already set here.');
    return { added: [], alreadySet, declined: false };
  }
  const loaders = missing.filter((name) => LOADER_VARIABLE.test(name));
  const redirects = missing.filter((name) => !loaders.includes(name) && isRedirectVariable(name));
  const gated = [...loaders, ...redirects].sort();
  const plain = missing.filter((name) => !gated.includes(name));

  deps.reporter.info(
    [
      `Saved environment variables missing on this PC (values hidden):`,
      ...plain.map((name) => `  + ${name}`),
      ...loaders.map((name) => `  + ${name}  (makes programs load or run code)`),
      ...redirects.map((name) => `  + ${name}  (sends programs’ requests elsewhere)`),
      `They would be added to ${deps.writer.where}, as plain text on this PC.`,
    ].join('\n'),
  );
  const count = (list: readonly string[]) =>
    `${String(list.length)} variable${list.length === 1 ? '' : 's'}`;
  const toAdd: string[] = [];
  let declined = false;
  if (plain.length > 0) {
    if (deps.assumeYes || (await deps.prompter.confirm(`Add ${count(plain)}?`, true))) {
      toAdd.push(...plain);
    } else declined = true;
  }
  if (gated.length > 0) {
    const one = gated.length === 1;
    const what =
      redirects.length === 0
        ? `make${one ? 's' : ''} programs load or run code`
        : loaders.length === 0
          ? `send${one ? 's' : ''} programs’ requests elsewhere`
          : 'make programs run code or send their requests elsewhere';
    const allow =
      deps.allowCommands === true ||
      (!deps.assumeYes &&
        (await deps.prompter.confirm(
          `${gated.join(', ')} ${what}. Add ${one ? 'it' : 'them'} too?`,
          false,
        )));
    if (allow) toAdd.push(...gated);
    else {
      declined = true;
      if (deps.assumeYes) {
        deps.reporter.warn(
          `Not added: ${gated.join(', ')}. --yes never adds variables that make programs run code or send their requests elsewhere; add --allow-commands to accept them.`,
        );
      }
    }
  }
  if (toAdd.length === 0) return { added: [], alreadySet, declined };

  const values = Object.fromEntries(
    toAdd.map((name) => [name, deps.section.variables[name] ?? '']),
  );
  const { backup } = await deps.writer.write(values);
  deps.reporter.success(
    [
      `Added ${toAdd.join(', ')} to ${deps.writer.where}.`,
      ...(backup ? [`Backup of the old file: ${backup}`] : []),
      'Open a new terminal (and restart Claude Code) so they take effect.',
    ].join('\n'),
  );
  return { added: toAdd, alreadySet, declined };
}
