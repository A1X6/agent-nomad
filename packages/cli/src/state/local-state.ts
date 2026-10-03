import { readFile } from 'node:fs/promises';

import { ProjectNameSchema, UsernameSchema } from '@agentnomad/contracts';
import * as z from 'zod';

import { isMissing, writeFileAtomically } from '../system/files.ts';
import { pathKey } from '../system/paths.ts';

/** Suffix of the note that a pull did not restore everything (T46, BUG-05). */
const PARTIAL = '#partial';

/**
 * Key in the projects map that names the account the revisions belong to (T56). Kept in that
 * map so older versions, which refuse unknown keys, still read the file; it never matches a
 * project folder, which is always an absolute path.
 */
const ACCOUNT = '#account';

/** File name of the local state inside the agentnomad config folder. */
export const STATE_FILE = 'state.json';

const ServerStateSchema = z.strictObject({
  /**
   * Project folder on this PC → the name it is saved under (T33 folder map), and `#account`
   * → the username the revisions belong to (T56).
   */
  projects: z.record(z.string(), ProjectNameSchema),
  /**
   * `<agent>/<scopeKey>` → the revision this PC last pushed or pulled. A pull that did not
   * restore everything (declined commands, or differing files it left as they were) is also
   * noted as `<agent>/<scopeKey>#partial` (T46, BUG-05); kept in this map so older versions
   * still read the file. The note does not say which.
   */
  revisions: z.record(z.string(), z.int().min(1)),
});

const StateFileSchema = z.strictObject({
  version: z.literal(1),
  /** One section per server host, like the secret store (T22). */
  servers: z.record(z.string(), ServerStateSchema),
});
type StateFile = z.infer<typeof StateFileSchema>;

class LocalStateError extends Error {
  constructor(path: string, options?: ErrorOptions) {
    super(
      `agentnomad's local state file is damaged: ${path}. Delete it; you will be asked for project names again.`,
      options,
    );
    this.name = 'LocalStateError';
  }
}

/** The state file is there but could not be read (permissions, a locked file). */
class LocalStateReadError extends Error {
  constructor(path: string, options?: ErrorOptions) {
    const code =
      options?.cause instanceof Error && 'code' in options.cause
        ? ` (${String(options.cause.code)})`
        : '';
    super(
      `Could not read agentnomad's local state file ${path}${code}. Nothing was changed; check that it can be read, then try again.`,
      options,
    );
    this.name = 'LocalStateReadError';
  }
}

/**
 * What this PC remembers between commands (T33): the name each project folder was saved
 * under, and the last revision it pushed or pulled of each setup (so the server can refuse
 * an upload that would overwrite a newer copy). Nothing secret is kept here.
 */
export interface LocalState {
  projectNameFor(folder: string): Promise<string | null>;
  rememberProject(folder: string, name: string): Promise<void>;
  revisionOf(agent: string, scopeKey: string): Promise<number | null>;
  /** `partial`: the pull did not restore everything (T46, BUG-05). */
  setRevision(
    agent: string,
    scopeKey: string,
    revision: number,
    options?: { partial?: boolean },
  ): Promise<void>;
  /** Whether this PC's last pull of the setup did not restore everything (T46, BUG-05). */
  isPartial(agent: string, scopeKey: string): Promise<boolean>;
  /** Every revision this PC knows, by `<agent>/<scopeKey>` (T35 status). */
  knownRevisions(): Promise<Readonly<Record<string, number>>>;
  /**
   * After a login or register (T56): the revisions belong to this account. Another account,
   * or none remembered, starts with no revisions; project names are kept.
   */
  useAccount(username: string): Promise<void>;
  /** Forgets one setup (after it was deleted on the server). */
  forgetRevision(agent: string, scopeKey: string): Promise<void>;
  /** Forgets everything about this server (after the account was deleted). */
  forgetServer(): Promise<void>;
}

export interface LocalStateOptions {
  readonly path: string;
  /** The API server host; each server has its own state. */
  readonly server: string;
  readonly platform: NodeJS.Platform;
}

export function createLocalState(options: LocalStateOptions): LocalState {
  /** Windows paths ignore case, so `E:\Projects` and `e:\projects` are the same folder. */
  const folderKey = (folder: string) => pathKey(folder, options.platform);

  async function load(): Promise<StateFile> {
    let text: string;
    try {
      text = await readFile(options.path, 'utf8');
    } catch (error) {
      // Only a missing file is "no state yet"; anything else would be written over (BUG-06).
      if (isMissing(error)) {
        return { version: 1, servers: {} };
      }
      throw new LocalStateReadError(options.path, { cause: error });
    }
    try {
      return StateFileSchema.parse(JSON.parse(text));
    } catch (error) {
      throw new LocalStateError(options.path, { cause: error });
    }
  }

  async function update(
    change: (server: z.infer<typeof ServerStateSchema>) => void,
    remove = false,
  ): Promise<void> {
    const state = await load();
    const server = state.servers[options.server] ?? { projects: {}, revisions: {} };
    change(server);
    state.servers = remove
      ? Object.fromEntries(
          Object.entries(state.servers).filter(([host]) => host !== options.server),
        )
      : { ...state.servers, [options.server]: server };
    await writeFileAtomically(options.path, `${JSON.stringify(state, null, 2)}\n`, {
      dirMode: 0o700,
    });
  }

  const server = async () => (await load()).servers[options.server];

  return {
    async projectNameFor(folder) {
      return (await server())?.projects[folderKey(folder)] ?? null;
    },
    async rememberProject(folder, name) {
      await update((state) => {
        state.projects[folderKey(folder)] = ProjectNameSchema.parse(name);
      });
    },
    async revisionOf(agent, scopeKey) {
      return (await server())?.revisions[`${agent}/${scopeKey}`] ?? null;
    },
    async setRevision(agent, scopeKey, revision, setOptions = {}) {
      const key = `${agent}/${scopeKey}`;
      await update((state) => {
        state.revisions = Object.fromEntries(
          Object.entries(state.revisions).filter(([name]) => name !== `${key}${PARTIAL}`),
        );
        state.revisions[key] = revision;
        if (setOptions.partial === true) state.revisions[`${key}${PARTIAL}`] = 1;
      });
    },
    async isPartial(agent, scopeKey) {
      return (await server())?.revisions[`${agent}/${scopeKey}${PARTIAL}`] !== undefined;
    },
    async knownRevisions() {
      return Object.fromEntries(
        Object.entries((await server())?.revisions ?? {}).filter(([key]) => !key.endsWith(PARTIAL)),
      );
    },
    async useAccount(username) {
      if ((await server())?.projects[ACCOUNT] === username) return;
      await update((state) => {
        state.revisions = {};
        state.projects[ACCOUNT] = UsernameSchema.parse(username);
      });
    },
    async forgetRevision(agent, scopeKey) {
      const key = `${agent}/${scopeKey}`;
      await update((state) => {
        state.revisions = Object.fromEntries(
          Object.entries(state.revisions).filter(
            ([name]) => name !== key && name !== `${key}${PARTIAL}`,
          ),
        );
      });
    },
    async forgetServer() {
      await update(() => undefined, true);
    },
  };
}
