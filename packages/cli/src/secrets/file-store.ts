import { chmod, readFile, rm, stat } from 'node:fs/promises';
import { dirname, win32 } from 'node:path';

import * as z from 'zod';

import { isMissing, writeFileAtomically } from '../system/files.ts';
import { runProgram } from '../system/run-program.ts';
import type { SecretName, SecretStore } from './secret-store.ts';

/** File name of the fallback store inside the config folder. */
export const SECRETS_FILE = 'secrets.json';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const SecretsSchema = z.strictObject({
  'session-token': z.string().min(1).optional(),
  'data-key': z.string().min(1).optional(),
});

const SecretsFileSchema = z.strictObject({
  version: z.literal(1),
  /** One set of secrets per server, keyed by host (e.g. `agentnomad-api.onrender.com`). */
  servers: z.record(z.string().min(1), SecretsSchema),
});

type SecretsFile = z.infer<typeof SecretsFileSchema>;

export interface FileStoreOptions {
  /** Full path of the secrets file. */
  readonly path: string;
  readonly server: string;
  readonly platform?: NodeJS.Platform;
  /** The CLI's environment; Windows finds its tools through `SystemRoot`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Windows: gives only the current user access to a file (T46), since file modes there
   * only control writing. Injectable for tests.
   */
  readonly restrictAccess?: (file: string) => Promise<void>;
}

/** Runs a Windows tool without a shell; its standard output, or a rejection. */
async function run(command: string, args: readonly string[]): Promise<string> {
  const { stdout, error } = await runProgram(command, args, { timeoutMs: 10_000 });
  if (error) throw new Error(`${command} failed: ${error.message}`, { cause: error });
  return stdout;
}

/**
 * The principals in an `icacls <file>` listing, as icacls names them. The first entry
 * follows the file name on the same line; the rest are indented below it.
 */
export function aclPrincipals(listing: string, file: string): string[] {
  const principals: string[] = [];
  for (const line of listing.split(/\r?\n/)) {
    const entry = (line.startsWith(file) ? line.slice(file.length) : line).trim();
    const principal = /^(.+?):\(/.exec(entry)?.[1];
    if (principal !== undefined) principals.push(principal);
  }
  return principals;
}

/**
 * The principals to take off the file: everyone but the current user, and only when
 * exactly one entry is recognisably the current user (by name or SID). Otherwise none, so
 * a user that icacls names differently from `whoami` never loses their own access.
 */
export function principalsToRemove(
  principals: readonly string[],
  user: { readonly name: string; readonly sid: string },
): string[] {
  const isUser = (principal: string) =>
    principal.toLowerCase() === user.name.toLowerCase() ||
    principal.toUpperCase() === user.sid.toUpperCase();
  if (principals.filter(isUser).length !== 1) return [];
  return principals.filter((principal) => !isUser(principal));
}

/**
 * Windows: removes inherited access, grants the current user (by SID, from `whoami`)
 * full control and removes every other principal's explicit access, so the file stays
 * private wherever the config folder is (T46). Explicit entries appear where the folder
 * passes nothing down: the file then gets the creator's default access list, which for an
 * elevated administrator also names SYSTEM and Administrators.
 */
export function windowsOwnerOnly(
  env: Readonly<Record<string, string | undefined>>,
): (file: string) => Promise<void> {
  return async (file) => {
    // By full path: Git for Windows puts a Unix `whoami` earlier on PATH.
    const system32 = win32.join(env['SystemRoot'] ?? 'C:\\Windows', 'System32');
    const csv = await run(win32.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
    const match = /^"([^"]*)","(S-1-[0-9-]+)"/.exec(csv.trim());
    if (match === null) throw new Error('Could not find the current user.');
    const [, name = '', sid = ''] = match;
    const icacls = win32.join(system32, 'icacls.exe');
    await run(icacls, [file, '/inheritance:r', '/grant:r', `*${sid}:F`]);
    const others = async () =>
      principalsToRemove(aclPrincipals(await run(icacls, [file]), file), { name, sid });
    const extra = await others();
    if (extra.length === 0) return;
    // A principal icacls cannot name is shown as its bare SID, which icacls takes with `*`.
    const sids = extra.map((principal) =>
      /^S-1-[0-9-]+$/i.test(principal) ? `*${principal}` : principal,
    );
    await run(icacls, [file, '/remove', ...sids]);
    const left = await others();
    if (left.length > 0) throw new Error(`Could not remove access for ${left.join(', ')}.`);
  };
}

export class SecretsFileError extends Error {
  constructor(path: string, options?: ErrorOptions) {
    super(`The secrets file is damaged: ${path}. Delete it and log in again.`, options);
    this.name = 'SecretsFileError';
  }
}

/**
 * SecretStore in a file only this user can read, for PCs without a keychain (servers,
 * WSL, SSH). The secrets are not encrypted here: the file permissions are the protection,
 * like an SSH private key without a passphrase.
 */
export function createFileStore(options: FileStoreOptions): SecretStore {
  const { path, server } = options;
  const posix = (options.platform ?? process.platform) !== 'win32';
  const restrictAccess =
    options.restrictAccess ?? (posix ? null : windowsOwnerOnly(options.env ?? {}));

  /** On macOS/Linux, takes back access others were given to the file or its folder. */
  async function lockDown(): Promise<void> {
    if (!posix) return;
    for (const [target, mode] of [
      [dirname(path), DIR_MODE],
      [path, FILE_MODE],
    ] as const) {
      const { mode: current } = await stat(target);
      if ((current & 0o077) !== 0) await chmod(target, mode);
    }
  }

  async function load(): Promise<SecretsFile> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (isMissing(error)) return { version: 1, servers: {} };
      throw error;
    }
    await lockDown();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new SecretsFileError(path, { cause: error });
    }
    const parsed = SecretsFileSchema.safeParse(json);
    if (!parsed.success) throw new SecretsFileError(path, { cause: parsed.error });
    return parsed.data;
  }

  /** Writes a new file next to the old one, then swaps it in, so a crash never leaves half a file. */
  async function save(file: SecretsFile): Promise<void> {
    if (Object.keys(file.servers).length === 0) {
      await rm(path, { force: true });
      return;
    }
    await writeFileAtomically(path, `${JSON.stringify(file, null, 2)}\n`, {
      mode: FILE_MODE,
      dirMode: DIR_MODE,
      ...(options.platform !== undefined && { platform: options.platform }),
      // Before it takes the real name, so the secrets are never readable by others. Best
      // effort: without the tools the folder's own permissions still apply.
      beforeRename: async (temp) => {
        await restrictAccess?.(temp).catch(() => undefined);
      },
    });
    await lockDown();
  }

  return {
    backend: 'file',
    async get(name) {
      return (await load()).servers[server]?.[name] ?? null;
    },
    async set(name, value) {
      const file = await load();
      file.servers[server] = { ...file.servers[server], [name]: value };
      await save(file);
    },
    async setMany(values) {
      const file = await load();
      file.servers[server] = { ...file.servers[server], ...values };
      await save(file);
    },
    async delete(name: SecretName) {
      const file = await load();
      const secrets = file.servers[server];
      if (secrets?.[name] === undefined) return;
      const rest = Object.fromEntries(Object.entries(secrets).filter(([key]) => key !== name));
      if (Object.keys(rest).length === 0) {
        file.servers = Object.fromEntries(
          Object.entries(file.servers).filter(([host]) => host !== server),
        );
      } else {
        file.servers[server] = rest;
      }
      await save(file);
    },
  };
}
