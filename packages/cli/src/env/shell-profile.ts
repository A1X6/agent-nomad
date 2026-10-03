import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';

import { BACKUP_MARKER, backupStamp } from '@agentnomad/core';

import { isMissing, writeFileAtomically, writeTargetOf } from '../system/files.ts';
import { runProgram } from '../system/run-program.ts';

/** Adds variables where new terminals (and the programs they start) will see them. */
export interface EnvWriter {
  /** Where they go, for the question and the summary, e.g. `~/.zshrc`. */
  readonly where: string;
  /**
   * The values already there for these names (T56): agentnomad's block in the profile, or the
   * Windows user variables. A name whose saved value is here counts as set, even when the
   * terminal running the pull started before it was added.
   */
  current(names: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** Adds or updates the variables, and writes nothing when none changes; returns the backup made, if any. */
  write(variables: Readonly<Record<string, string>>): Promise<{ readonly backup: string | null }>;
}

export type ShellKind = 'posix' | 'fish';

export const BLOCK_START = '# >>> agentnomad env >>>';
export const BLOCK_END = '# <<< agentnomad env <<<';

/** `it's` → `'it'\''s'`: safe in sh, bash and zsh whatever the value holds. */
export const quotePosix = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** fish single quotes only treat `\\` and `\'` specially. */
const quoteFish = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function unquotePosix(quoted: string): string {
  return [...quoted.matchAll(/'([^']*)'|\\(.)/g)].map((part) => part[1] ?? part[2] ?? '').join('');
}
function unquoteFish(quoted: string): string {
  return quoted.slice(1, -1).replace(/\\([\\'])/g, '$1');
}

const LINE = {
  posix: /^export ([A-Za-z_][A-Za-z0-9_]*)=((?:'[^']*'|\\')+)$/gm,
  fish: /^set -gx ([A-Za-z_][A-Za-z0-9_]*) ('(?:[^'\\]|\\[\\'])*')$/gm,
};

/** The variables in an existing agentnomad block. */
export function readBlock(text: string, kind: ShellKind): Map<string, string> {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END, start);
  const variables = new Map<string, string>();
  if (start === -1 || end === -1) return variables;
  const block = text.slice(start + BLOCK_START.length, end);
  for (const match of block.matchAll(LINE[kind])) {
    const [, name, quoted] = match;
    if (name && quoted)
      variables.set(name, kind === 'posix' ? unquotePosix(quoted) : unquoteFish(quoted));
  }
  return variables;
}

/** The profile with the agentnomad block added, or replaced with the merged variables. */
export function upsertBlock(
  text: string,
  variables: Readonly<Record<string, string>>,
  kind: ShellKind,
): string {
  const merged = readBlock(text, kind);
  for (const [name, value] of Object.entries(variables)) merged.set(name, value);
  const lines = [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) =>
      kind === 'posix'
        ? `export ${name}=${quotePosix(value)}`
        : `set -gx ${name} ${quoteFish(value)}`,
    );
  const block = [
    BLOCK_START,
    '# Added by agentnomad pull. Values are plain text on this PC.',
    ...lines,
    BLOCK_END,
  ].join('\n');

  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END, start);
  if (start !== -1 && end !== -1) {
    return text.slice(0, start) + block + text.slice(end + BLOCK_END.length);
  }
  const separator = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${separator}${block}\n`;
}

/** The profile file a new terminal reads, from `$SHELL` (zsh, bash, fish; sh-style otherwise). */
export function shellProfileFor(
  shell: string | undefined,
  homedir: string,
  platform: NodeJS.Platform,
): { readonly path: string; readonly kind: ShellKind; readonly label: string } {
  const name = posix.basename(shell ?? '');
  if (name === 'fish') {
    return {
      path: posix.join(homedir, '.config', 'fish', 'config.fish'),
      kind: 'fish',
      label: '~/.config/fish/config.fish',
    };
  }
  if (name === 'zsh' || (name === '' && platform === 'darwin')) {
    return { path: posix.join(homedir, '.zshrc'), kind: 'posix', label: '~/.zshrc' };
  }
  if (name === 'bash' && platform === 'darwin') {
    // macOS Terminal starts login shells, which read .bash_profile, not .bashrc.
    return { path: posix.join(homedir, '.bash_profile'), kind: 'posix', label: '~/.bash_profile' };
  }
  if (name === 'bash')
    return { path: posix.join(homedir, '.bashrc'), kind: 'posix', label: '~/.bashrc' };
  return { path: posix.join(homedir, '.profile'), kind: 'posix', label: '~/.profile' };
}

/** macOS and Linux: an agentnomad block in the shell profile, backed up first. */
export function createShellProfileWriter(
  profile: { readonly path: string; readonly kind: ShellKind; readonly label: string },
  now: () => Date = () => new Date(),
): EnvWriter {
  return {
    where: profile.label,
    async current(names) {
      let text: string;
      try {
        text = await readFile(await writeTargetOf(profile.path), 'utf8');
      } catch (error) {
        if (isMissing(error)) return new Map();
        throw error;
      }
      const block = readBlock(text, profile.kind);
      return new Map([...block].filter(([name]) => names.includes(name)));
    },
    async write(variables) {
      const target = await writeTargetOf(profile.path);
      let existing: string | null;
      // A new profile holds saved values, so only this user may read it (T46).
      let mode = 0o600;
      try {
        existing = await readFile(target, 'utf8');
        mode = (await stat(target)).mode & 0o777;
      } catch (error) {
        // Only a missing file is started fresh; any other error must not replace the profile.
        if (!isMissing(error)) throw error;
        existing = null;
      }
      const updated = upsertBlock(existing ?? '', variables, profile.kind);
      // Same block as before (T56): no backup and no write, so a repeated pull leaves no trace.
      if (updated === existing) return { backup: null };
      await mkdir(posix.dirname(target), { recursive: true });
      let backup: string | null = null;
      if (existing !== null) {
        backup = `${target}${BACKUP_MARKER}${backupStamp(now())}`;
        await writeFile(backup, existing, { mode });
      }
      await writeFileAtomically(target, updated, { mode });
      return { backup };
    },
  };
}

/** Runs one PowerShell statement; names and values travel as environment variables, not arguments. */
export type PowerShellRunner = (
  script: string,
  env: Readonly<Record<string, string>>,
) => Promise<string>;

/** The real PowerShell, started with the CLI's (injected) environment plus the statement's. */
export function realPowerShell(
  baseEnv: Readonly<Record<string, string | undefined>>,
): PowerShellRunner {
  return async (script, env) => {
    const { stdout, error } = await runProgram(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...baseEnv, ...env }, timeoutMs: 30_000 },
    );
    if (error) throw new Error(`PowerShell failed: ${error.message}`, { cause: error });
    return stdout;
  };
}

/**
 * Windows: the user's environment variables (like "Edit environment variables for your
 * account"). Values never appear on a command line, where other programs could see them.
 */
export function createWindowsEnvWriter(run: PowerShellRunner): EnvWriter {
  async function current(names: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (names.length === 0) return new Map();
    // Names in, values out as base64 UTF-8 JSON, so no console code page can change them.
    const output = await run(
      '$found = @{}; foreach ($name in ($env:AGENTNOMAD_ENV_NAMES -split "`n")) { $value = [Environment]::GetEnvironmentVariable($name, \'User\'); if ($null -ne $value) { $found[$name] = $value } }; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $found -Compress)))',
      { AGENTNOMAD_ENV_NAMES: names.join('\n') },
    );
    const parsed: unknown = JSON.parse(Buffer.from(output.trim(), 'base64').toString('utf8'));
    const found = new Map<string, string>();
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [name, value] of Object.entries(parsed)) {
        if (names.includes(name) && typeof value === 'string') found.set(name, value);
      }
    }
    return found;
  }
  return {
    where: 'your Windows user environment variables',
    current,
    async write(variables) {
      // A user variable that already has the value is left as it is (T56).
      const here = await current(Object.keys(variables));
      const changed = Object.entries(variables).filter(([name, value]) => here.get(name) !== value);
      if (changed.length === 0) return { backup: null };
      // One PowerShell for all of them (PERF-02): names and values as numbered variables.
      const env: Record<string, string> = { AGENTNOMAD_ENV_COUNT: String(changed.length) };
      changed.forEach(([name, value], index) => {
        env[`AGENTNOMAD_ENV_NAME_${String(index)}`] = name;
        env[`AGENTNOMAD_ENV_VALUE_${String(index)}`] = value;
      });
      await run(
        'for ($i = 0; $i -lt [int]$env:AGENTNOMAD_ENV_COUNT; $i++) { [Environment]::SetEnvironmentVariable([Environment]::GetEnvironmentVariable("AGENTNOMAD_ENV_NAME_$i"), [Environment]::GetEnvironmentVariable("AGENTNOMAD_ENV_VALUE_$i"), \'User\') }',
        env,
      );
      return { backup: null };
    },
  };
}
