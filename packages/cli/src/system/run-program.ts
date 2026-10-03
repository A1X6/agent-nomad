import { execFile } from 'node:child_process';

export interface RunProgramOptions {
  /** The program is stopped after this long, and the run counts as failed. */
  readonly timeoutMs: number;
  /** Its whole environment; without it, the CLI's own. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  /** Windows: pass the arguments as they are, with no quoting added. */
  readonly verbatim?: boolean;
  /** Largest output kept, in bytes; Node's default without it. */
  readonly maxBuffer?: number;
}

export interface ProgramResult {
  /** The exit code; 1 when it did not start, was stopped or gave no code. */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Why it failed (did not start, timed out, exited non-zero), `null` when it succeeded. */
  readonly error: Error | null;
}

/** Runs a program without a shell (Node's `execFile`). Never rejects: a failure is in the result. */
export function runProgram(
  file: string,
  args: readonly string[],
  options: RunProgramOptions,
): Promise<ProgramResult> {
  return new Promise((done) => {
    execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs,
        windowsHide: true,
        encoding: 'utf8',
        ...(options.env !== undefined && { env: { ...options.env } }),
        ...(options.cwd !== undefined && { cwd: options.cwd }),
        ...(options.verbatim !== undefined && { windowsVerbatimArguments: options.verbatim }),
        ...(options.maxBuffer !== undefined && { maxBuffer: options.maxBuffer }),
      },
      (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        done({ exitCode, stdout, stderr, error });
      },
    );
  });
}
