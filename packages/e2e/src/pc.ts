import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The CLI to run: the workspace build (`pnpm test:e2e` builds it first), or, with
 * `E2E_CLI`, another entry file, such as the npm package installed globally (T40).
 */
const BIN =
  process.env['E2E_CLI'] ?? fileURLToPath(new URL('../../cli/dist/src/bin.js', import.meta.url));

/**
 * Loaded into the CLI when several "PCs" share one machine: the OS keychain is one per
 * user, so they would share one login. Without it, each PC keeps its login in its own
 * config folder (the CLI's file fallback), and the real keychain is never touched.
 */
const NO_KEYCHAIN_HOOKS = `export async function resolve(specifier, context, next) {
  if (specifier === '@napi-rs/keyring') {
    return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export class AsyncEntry { constructor() { throw new Error("no keychain in this test"); } }') };
  }
  return next(specifier, context);
}`;
const NO_KEYCHAIN = `data:text/javascript,${encodeURIComponent(
  `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(NO_KEYCHAIN_HOOKS)}`)});`,
)}`;

/** Settings that would point the CLI at the real user's setup instead of this PC's. */
const INHERITED_OUT = /^(XDG_CONFIG_HOME|CLAUDE_CONFIG_DIR|CLAUDE_CODE_.*|AGENTNOMAD_.*)$/i;

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** One simulated PC: its own home folder, config folder and project, all in a temp folder. */
export interface Pc {
  readonly name: string;
  readonly home: string;
  /** The project folder, as the CLI sees it (symlinks resolved, e.g. macOS /private/var). */
  readonly project: string;
  /** Runs `agentnomad <args>` here with no terminal; `input` is piped to stdin. */
  run(args: readonly string[], input?: string): Promise<RunResult>;
  remove(): Promise<void>;
}

/** Terminal colour and cursor codes (ESC [ … letter), in case any reach a pipe. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const stripAnsi = (text: string) => text.replace(ANSI, '');

export async function newPc(
  name: string,
  options: { apiUrl: string; keychain: boolean },
): Promise<Pc> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `agentnomad-e2e-${name}-`)));
  const home = join(root, 'home');
  const project = join(root, 'code', 'demo');
  // `.git` makes the project a repository root, as auto memory expects (T26).
  await Promise.all([
    mkdir(join(home, '.claude'), { recursive: true }),
    mkdir(join(root, 'appdata'), { recursive: true }),
    mkdir(join(project, '.git'), { recursive: true }),
  ]);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !INHERITED_OUT.test(key)) env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(root, 'appdata'),
    AGENTNOMAD_API_URL: options.apiUrl,
  });

  return {
    name,
    home,
    project,
    run: (args, input = '') =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [...(options.keychain ? [] : ['--import', NO_KEYCHAIN]), BIN, ...args],
          { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        child.on('error', reject);
        child.on('close', (code) => {
          resolve({ code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) });
        });
        child.stdin.end(input);
      }),
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

export async function write(path: string, content: string, executable = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, executable ? { mode: 0o755 } : {});
}

export const read = (path: string) => readFile(path, 'utf8');

export async function isExecutable(path: string): Promise<boolean> {
  return ((await stat(path)).mode & 0o111) !== 0;
}

/** A path with forward slashes, for comparing Windows and POSIX forms of the same path. */
export const forward = (path: string) => path.replace(/\\/g, '/');
