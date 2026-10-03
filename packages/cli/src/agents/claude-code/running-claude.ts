import { execFile } from 'node:child_process';

/** Lists the command lines (or program names) of running processes; `null` when unknown. */
export type ProcessLister = () => Promise<readonly string[] | null>;

/** Is Claude Code running? It rewrites `~/.claude.json` while open, so pull waits for it. */
export type ClaudeRunningCheck = () => Promise<boolean>;

/** Runs a program without a shell; its standard output, or `null` when it failed. */
export type RunForOutput = (
  file: string,
  args: readonly string[],
  options: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs: number;
  },
) => Promise<string | null>;

const LIST_TIMEOUT_MS = 10_000;

const runForOutput: RunForOutput = (file, args, options) =>
  new Promise((done) => {
    execFile(
      file,
      [...args],
      {
        env: { ...options.env },
        timeout: options.timeoutMs,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout) => {
        done(error ? null : stdout);
      },
    );
  });

/**
 * Every process's command line (its name when the command line is hidden, as for another
 * user's), as base64 UTF-8 so no console code page can change it.
 */
const COMMAND_LINES_SCRIPT =
  '$ErrorActionPreference = "Stop"; $lines = Get-CimInstance Win32_Process | ForEach-Object { if ($_.CommandLine) { $_.CommandLine } else { $_.Name } }; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($lines -join "`n")))';

const nonEmpty = (lines: readonly string[]) => lines.filter((line) => line.trim() !== '');

/**
 * The real process list, on the platform and with the environment that were injected. On
 * Windows: command lines through PowerShell, so an npm-installed Claude Code running under
 * `node.exe` is seen (BUG-08), else `tasklist` program names. Elsewhere: `ps` command lines.
 */
export function systemProcessLister(
  system: {
    readonly platform: NodeJS.Platform;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
  options: { readonly timeoutMs?: number; readonly run?: RunForOutput } = {},
): ProcessLister {
  const run = options.run ?? runForOutput;
  const common = { env: system.env, timeoutMs: options.timeoutMs ?? LIST_TIMEOUT_MS };
  return async () => {
    if (system.platform === 'win32') {
      const encoded = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', COMMAND_LINES_SCRIPT],
        common,
      );
      const trimmed = encoded?.trim() ?? '';
      if (trimmed !== '' && /^[A-Za-z0-9+/]+=*$/.test(trimmed)) {
        return nonEmpty(Buffer.from(trimmed, 'base64').toString('utf8').split('\n'));
      }
      const output = await run('tasklist', ['/FO', 'CSV', '/NH'], common);
      return output === null
        ? null
        : nonEmpty(output.split(/\r?\n/).map((line) => /^"([^"]+)"/.exec(line)?.[1] ?? ''));
    }
    const output = await run('ps', ['-A', '-o', 'args='], common);
    return output === null ? null : nonEmpty(output.split('\n'));
  };
}

/**
 * True for a Claude Code process: the `claude` program (`claude.exe`, `/usr/local/bin/claude
 * --resume`, also under a folder with a space in its name) or the npm package running under
 * node. The Claude app (`Claude.exe`, `Claude.app/…/Claude`) counts too: its Code tab runs
 * Claude Code, which shares `~/.claude.json` (BUG-13). Not this CLI or unrelated names.
 */
export function isClaudeProcess(line: string): boolean {
  const trimmed = line.trim();
  if (/@anthropic-ai[\\/]claude-code/i.test(trimmed)) return true;
  return /(?:^|[\\/])claude(?:\.exe)?(?:["\s]|$)/i.test(trimmed);
}

/**
 * Checks the process list for Claude Code. When the list cannot be read, answers "not
 * running" rather than blocking the pull forever; the user was already told to close it.
 */
export function createClaudeRunningCheck(list: ProcessLister): ClaudeRunningCheck {
  return async () => (await list())?.some(isClaudeProcess) ?? false;
}
