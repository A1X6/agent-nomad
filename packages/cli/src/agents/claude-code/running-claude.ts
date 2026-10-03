import { runProgram } from '../../system/run-program.ts';

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

const runForOutput: RunForOutput = async (file, args, options) => {
  const { stdout, error } = await runProgram(file, args, {
    env: options.env,
    timeoutMs: options.timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return error ? null : stdout;
};

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
 * The folders before a program at the start of an unquoted command line (`ps` prints no
 * quotes): a space goes on with the path (`/Users/John Smith/…`) unless an argument starts
 * after it (`-x`, `/x`, `"x`, `C:\x`).
 */
const LEADING_FOLDERS = String.raw`(?:[^\s"]|\s(?![-/"]|[A-Za-z]:[\\/]))*[\\/]`;

/** The first word of a command line (quoted or not) when it is the file `name`, any folder. */
const firstWordIs = (name: string) =>
  new RegExp(
    String.raw`^(?:"(?:[^"]*[\\/])?(?:${name})"|(?:${LEADING_FOLDERS})?(?:${name}))(?=\s|$)`,
    'i',
  );

const CLAUDE_PROGRAM = firstWordIs(String.raw`claude(?:\.exe)?`);
/** Interpreters and launchers that run a script: npm's `bin/claude` is a node script. */
const LAUNCHER = firstWordIs(String.raw`(?:node|bun|deno|sh|bash|zsh|env)(?:\.exe)?`);
const ENV = /(?:^|[\\/"])env(?:\.exe)?"?$/i;
const CLAUDE_SCRIPT = firstWordIs(String.raw`claude(?:\.exe|\.cmd|\.js)?`);
/** The script argument, quoted or not: unquoted, a space goes on as in LEADING_FOLDERS. */
const SCRIPT_ARGUMENT = /^(?:"[^"]*"|(?:[^\s"]|\s(?![-/"]|[A-Za-z]:[\\/]))*)/;
const NPM_PACKAGE = /@anthropic-ai[\\/]claude-code(?:[\\/]|$)/i;

/** The command line after its first word and the options that follow it. */
function afterFirstWord(line: string, first: string, assignments = false): string {
  let rest = line.slice(first.length).trimStart();
  const option = assignments ? /^(?:-|[A-Za-z_][A-Za-z0-9_]*=)\S*\s*/ : /^-\S*\s*/;
  for (let match = option.exec(rest); match !== null; match = option.exec(rest)) {
    rest = rest.slice(match[0].length);
  }
  return rest;
}

/**
 * True for a Claude Code process: the `claude` program (`claude.exe`, `/usr/local/bin/claude
 * --resume`, also under a folder with a space in its name), or an interpreter or launcher
 * (`node`, `bun`, `deno`, `sh`, `bash`, `zsh`, `env`) whose script is `claude`, `claude.js`,
 * `claude.cmd`, `claude.exe` or in the npm package: npm links `bin/claude` to a node script,
 * so `ps` shows `node /usr/local/bin/claude`. The Claude app (`Claude.exe`,
 * `Claude.app/…/Claude`) counts too: its Code tab runs Claude Code, which shares
 * `~/.claude.json` (BUG-13). Only the program and its script count (UX-02): not an editor open
 * on a `claude` folder, `npm install -g @anthropic-ai/claude-code`, this CLI or unrelated
 * names. Any launcher with such a script counts, so the check leans toward "running": a
 * missed Claude Code would let pull merge `~/.claude.json` under it.
 */
export function isClaudeProcess(line: string): boolean {
  const trimmed = line.trim();
  if (CLAUDE_PROGRAM.test(trimmed)) return true;
  const launcher = LAUNCHER.exec(trimmed)?.[0];
  if (launcher === undefined) return false;
  let rest = afterFirstWord(trimmed, launcher, ENV.test(launcher));
  if (ENV.test(launcher)) {
    // env starts the program named next (`env node …`), or Claude Code itself.
    if (CLAUDE_PROGRAM.test(rest)) return true;
    rest = afterFirstWord(rest, /^(?:"[^"]*"|\S*)/.exec(rest)?.[0] ?? '');
  }
  return CLAUDE_SCRIPT.test(rest) || NPM_PACKAGE.test(SCRIPT_ARGUMENT.exec(rest)?.[0] ?? '');
}

/**
 * Checks the process list for Claude Code. When the list cannot be read, answers "not
 * running" rather than blocking the pull forever; the user was already told to close it.
 */
export function createClaudeRunningCheck(list: ProcessLister): ClaudeRunningCheck {
  return async () => (await list())?.some(isClaudeProcess) ?? false;
}
