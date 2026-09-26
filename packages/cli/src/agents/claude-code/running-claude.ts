import { execFile } from 'node:child_process';

/** Lists the command lines (or program names) of running processes; `null` when unknown. */
export type ProcessLister = () => Promise<readonly string[] | null>;

/** Is Claude Code running? It rewrites `~/.claude.json` while open, so pull waits for it. */
export type ClaudeRunningCheck = () => Promise<boolean>;

const LIST_TIMEOUT_MS = 5_000;

function run(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      file,
      args,
      { timeout: LIST_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        done(error ? null : stdout);
      },
    );
  });
}

/**
 * The real process list: `tasklist` on Windows (program names), `ps` elsewhere (full
 * command lines, which also show an npm-installed Claude Code running under node).
 */
export function systemProcessLister(platform: NodeJS.Platform = process.platform): ProcessLister {
  return async () => {
    if (platform === 'win32') {
      const output = await run('tasklist', ['/FO', 'CSV', '/NH']);
      return output === null
        ? null
        : output
            .split(/\r?\n/)
            .map((line) => /^"([^"]+)"/.exec(line)?.[1] ?? '')
            .filter((name) => name !== '');
    }
    const output = await run('ps', ['-A', '-o', 'args=']);
    return output === null ? null : output.split('\n').filter((line) => line.trim() !== '');
  };
}

/**
 * True for a Claude Code process: the `claude` program (`claude.exe`, `/usr/local/bin/claude
 * --resume`) or the npm package running under node. Not for this CLI or unrelated names.
 */
export function isClaudeProcess(line: string): boolean {
  const trimmed = line.trim();
  if (/@anthropic-ai[\\/]claude-code/i.test(trimmed)) return true;
  const program = /^"([^"]+)"|^(\S+)/.exec(trimmed);
  const file = (program?.[1] ?? program?.[2] ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return file === 'claude' || file === 'claude.exe';
}

/**
 * Checks the process list for Claude Code. When the list cannot be read, answers "not
 * running" rather than blocking the pull forever; the user was already told to close it.
 */
export function createClaudeRunningCheck(
  list: ProcessLister = systemProcessLister(),
): ClaudeRunningCheck {
  return async () => (await list())?.some(isClaudeProcess) ?? false;
}
