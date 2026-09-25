import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BundleParams } from '@agentnomad/contracts';
import {
  createGzipBundleCodec,
  createSodiumCryptoService,
  decryptProjectName,
  openBundle,
  scopeKeyFor,
  type BundleCodec,
  type CryptoService,
} from '@agentnomad/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ApiError,
  createAgentRegistry,
  createLocalState,
  createPushCommand,
  NotLoggedInPushError,
  type AgentAdapter,
  type ApiClient,
  type BundleUpload,
  type CollectedFile,
  type Prompter,
  type Reporter,
  type SecretName,
  type SecretStore,
} from '../src/index.ts';

const posix = process.platform !== 'win32';
const HOME = posix ? '/home/ahmed' : 'C:\\Users\\ahmed';
const PROJECT = posix ? '/home/ahmed/work/my-app' : 'C:\\Users\\ahmed\\work\\my-app';

let crypto: CryptoService;
let dataKey: Uint8Array;
beforeAll(async () => {
  crypto = await createSodiumCryptoService();
  dataKey = crypto.randomBytes(32);
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentnomad-push-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const text = (path: string, content: string, executable = false): CollectedFile => ({
  path,
  content: new TextEncoder().encode(content),
  executable,
});

function fakeAdapter(
  options: {
    global?: CollectedFile[];
    project?: CollectedFile[];
    unknown?: string[];
    notices?: string[];
  } = {},
): AgentAdapter {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    detector: {
      detect: () =>
        Promise.resolve({ installed: true, baseDir: `${HOME}/.claude`, version: '2.1.282' }),
    },
    collector: {
      collect: (target) =>
        Promise.resolve(
          target.kind === 'global'
            ? (options.global ?? [text('CLAUDE.md', `Scripts in ${HOME}/scripts`)])
            : (options.project ?? [text('CLAUDE.md', 'project rules')]),
        ),
    },
    restorer: {
      restore: () => Promise.resolve({ written: [], skipped: [], backups: [], warnings: [] }),
    },
    inspector: {
      unknownEntries: () => Promise.resolve(options.unknown ?? []),
      notices: () => Promise.resolve(options.notices ?? []),
    },
  };
}

/** A server that keeps uploads by agent and scope key and enforces revisions like the real one. */
function fakeServer() {
  const stored = new Map<string, { upload: BundleUpload; revision: number }>();
  const puts: { params: BundleParams; upload: BundleUpload }[] = [];
  const key = (params: BundleParams) => `${params.agent}/${params.scopeKey}`;
  const api: ApiClient = {
    auth: {} as ApiClient['auth'],
    bundles: {
      list: () => Promise.reject(new Error('not used')),
      get: () => Promise.reject(new Error('not used')),
      delete: () => Promise.reject(new Error('not used')),
      put: (params, upload) => {
        puts.push({ params, upload });
        const current = stored.get(key(params))?.revision ?? 0;
        if (upload.expectedRevision !== current) {
          return Promise.reject(
            new ApiError(
              409,
              'revision_conflict',
              'newer',
              current > 0 ? { currentRevision: current } : {},
            ),
          );
        }
        stored.set(key(params), { upload, revision: current + 1 });
        return Promise.resolve({ revision: current + 1, updatedAt: '2026-09-25T12:00:00Z' });
      },
    },
  };
  return { api, stored, puts };
}

function loggedIn(): SecretStore {
  const saved = new Map<SecretName, string>([
    ['session-token', 't'.repeat(43)],
    ['data-key', Buffer.from(dataKey).toString('base64')],
  ]);
  return {
    backend: 'keychain',
    get: (name) => Promise.resolve(saved.get(name) ?? null),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  };
}

function scripted(answers: unknown[]) {
  const asked: string[] = [];
  const next = (message: string): unknown => {
    asked.push(message);
    if (answers.length === 0) throw new Error(`No answer scripted for "${message}"`);
    return answers.shift();
  };
  const prompter: Prompter = {
    select: <T extends string>(message: string) => Promise.resolve(next(message) as T),
    multiselect: <T extends string>(message: string) => Promise.resolve(next(message) as T[]),
    text: (message) => Promise.resolve(next(message) as string),
    password: (message) => Promise.resolve(next(message) as string),
    confirm: (message) => Promise.resolve(next(message) as boolean),
  };
  return { prompter, asked };
}

function recorder() {
  const lines: string[] = [];
  const reporter: Reporter = {
    info: (m) => lines.push(`info: ${m}`),
    success: (m) => lines.push(`success: ${m}`),
    warn: (m) => lines.push(`warn: ${m}`),
    error: (m) => lines.push(`error: ${m}`),
    spinner: () => ({ start: () => undefined, stop: () => undefined }),
  };
  return { reporter, lines };
}

function setup(
  answers: unknown[],
  options: {
    adapter?: AgentAdapter;
    server?: ReturnType<typeof fakeServer>;
    secrets?: SecretStore;
    cwd?: string;
    env?: Record<string, string>;
    /** Which PC: each PC has its own local state file. */
    pc?: string;
    codec?: BundleCodec;
  } = {},
) {
  const server = options.server ?? fakeServer();
  const script = scripted(answers);
  const { reporter, lines } = recorder();
  const state = createLocalState({
    path: join(dir, `${options.pc ?? 'this-pc'}.json`),
    server: 'api.test',
    platform: process.platform,
  });
  const command = createPushCommand({
    prompter: script.prompter,
    reporter,
    registry: () => createAgentRegistry([options.adapter ?? fakeAdapter()]),
    secrets: () => Promise.resolve(options.secrets ?? loggedIn()),
    api: () => server.api,
    crypto: () => Promise.resolve(crypto),
    codec: options.codec ?? createGzipBundleCodec(),
    localState: () => state,
    env: options.env ?? {},
    cwd: options.cwd ?? PROJECT,
    homedir: HOME,
    platform: process.platform,
  });
  return { command, server, script, lines, state };
}

const noFlags = { global: false, yes: false };

/** What the server received, decrypted with the owner's key. */
async function received(
  server: ReturnType<typeof fakeServer>,
  scope: { kind: 'global' } | { kind: 'project'; name: string },
) {
  const scopeKey = scopeKeyFor(crypto, dataKey, scope);
  const entry = server.stored.get(`claude-code/${scopeKey}`);
  if (!entry) throw new Error('nothing stored');
  const plain = openBundle(crypto, entry.upload.ciphertext, dataKey, {
    formatVersion: 1,
    agent: 'claude-code',
    scopeKey,
  });
  return {
    bundle: await createGzipBundleCodec().decode(plain),
    upload: entry.upload,
    revision: entry.revision,
  };
}

describe('agentnomad push', () => {
  it('saves the global setup: encrypted, stamped, with portable paths', async () => {
    const t = setup(['global', false]);
    await t.command.push(noFlags);

    const { bundle, upload, revision } = await received(t.server, { kind: 'global' });
    expect(bundle).toMatchObject({
      agent: 'claude-code',
      scope: { kind: 'global' },
      agentVersion: '2.1.282',
    });
    expect(bundle.files).toEqual([
      {
        path: 'CLAUDE.md',
        executable: false,
        encoding: 'utf8',
        content: 'Scripts in {{HOME}}/scripts',
      },
    ]);
    expect(upload.expectedRevision).toBe(0);
    expect(upload.nameEnc).toBeUndefined();
    expect(Buffer.from(crypto.sha256(upload.ciphertext)).toString('hex')).toBe(
      upload.contentSha256,
    );
    expect(revision).toBe(1);
    expect(t.lines.at(-1)).toMatch(
      /^success: Saved the Claude Code global setup: 1 file, \d+ B \(revision 1\)\.$/,
    );
  });

  it('never sends a readable byte of the setup', async () => {
    const t = setup(['global', false], {
      adapter: fakeAdapter({ global: [text('CLAUDE.md', 'SECRET-PLAN-XYZ')] }),
    });
    await t.command.push(noFlags);
    const sent = t.server.puts
      .map((put) => Buffer.from(put.upload.ciphertext).toString('latin1'))
      .join('');
    expect(sent).not.toContain('SECRET-PLAN-XYZ');
  });

  it('saves a project under an encrypted name; the server only sees a keyed hash', async () => {
    const t = setup(['project', 'my-app', false]);
    await t.command.push(noFlags);
    expect(t.script.asked).toContain(
      'Name this project (you will pick it by this name on other PCs)',
    );

    const { bundle, upload } = await received(t.server, { kind: 'project', name: 'my-app' });
    expect(bundle.scope).toEqual({ kind: 'project', name: 'my-app' });
    const scopeKey = scopeKeyFor(crypto, dataKey, { kind: 'project', name: 'my-app' });
    const sealedName = new Uint8Array(Buffer.from(upload.nameEnc ?? '', 'base64'));
    expect(
      decryptProjectName(crypto, sealedName, dataKey, { agent: 'claude-code', scopeKey }),
    ).toBe('my-app');
    expect(JSON.stringify(t.server.puts.map((put) => put.params))).not.toContain('my-app');
    expect(await t.state.projectNameFor(PROJECT)).toBe('my-app');
  });

  it('a second push from the same folder asks no name and moves to the next revision', async () => {
    const server = fakeServer();
    await setup(['both', 'my-app', false], { server }).command.push(noFlags);
    const second = setup(['both', false], { server });
    await second.command.push(noFlags);
    expect(second.script.asked).not.toContain(
      'Name this project (you will pick it by this name on other PCs)',
    );
    expect((await received(server, { kind: 'global' })).revision).toBe(2);
    expect((await received(server, { kind: 'project', name: 'my-app' })).revision).toBe(2);
  });

  it('flags skip the questions: --global --project name --yes', async () => {
    const t = setup([]);
    await t.command.push({ global: true, project: 'renamed', yes: true, agents: ['claude-code'] });
    expect(t.script.asked).toEqual([]);
    expect(t.server.stored.size).toBe(2);
    expect(await t.state.projectNameFor(PROJECT)).toBe('renamed');
  });

  it('never offers the home folder as a project', async () => {
    const t = setup([false], { cwd: HOME });
    await t.command.push(noFlags);
    expect(t.script.asked).toEqual([
      'Include memory (what Claude learned: subagent and auto memory)?',
    ]);
    expect(t.server.stored.size).toBe(1);
  });

  it('asks before replacing a newer copy from another PC; no keeps it', async () => {
    const server = fakeServer();
    await setup(['global', false], { server, pc: 'laptop' }).command.push(noFlags);
    await setup(['global', false], { server, pc: 'laptop' }).command.push(noFlags);

    // The desktop never pulled, so it only knows "nothing saved yet".
    const desktop = setup(['global', false, false], { server, pc: 'desktop' });
    await desktop.command.push(noFlags);
    expect(desktop.script.asked.at(-1)).toBe(
      "A newer copy of the Claude Code global setup (revision 2) was saved from another PC. Replace it with this PC's setup?",
    );
    expect((await received(server, { kind: 'global' })).revision).toBe(2);
    expect(desktop.lines.at(-1)).toContain('Run `agentnomad pull` first');
  });

  it('--yes never overwrites a newer copy', async () => {
    const server = fakeServer();
    await setup(['global', false], { server, pc: 'laptop' }).command.push(noFlags);
    const desktop = setup([], { server, pc: 'desktop' });
    await desktop.command.push({ global: true, yes: true });
    expect(desktop.script.asked).toEqual([]);
    expect(desktop.lines.some((line) => line.includes('Run `agentnomad pull` first'))).toBe(true);
    expect((await received(server, { kind: 'global' })).revision).toBe(1);
  });

  it('replaces the newer copy when the user says yes, and remembers the new revision', async () => {
    const server = fakeServer();
    await setup(['global', false], { server, pc: 'laptop' }).command.push(noFlags);
    const desktop = setup(['global', false, true], { server, pc: 'desktop' });
    await desktop.command.push(noFlags);
    expect((await received(server, { kind: 'global' })).revision).toBe(2);
    expect(await desktop.state.revisionOf('claude-code', 'global')).toBe(2);
  });

  it('shows unknown-file and managed-settings notices, and offers env values', async () => {
    const adapter = fakeAdapter({
      global: [
        text(
          '.mcp.json',
          JSON.stringify({ mcpServers: { gh: { env: { T: '${GITHUB_TOKEN}' } } } }),
        ),
      ],
      unknown: ['snippets/'],
      notices: ['Your organization manages some Claude Code settings on this PC.'],
    });
    const t = setup(['global', false, ['GITHUB_TOKEN']], {
      adapter,
      env: { GITHUB_TOKEN: 'ghp_x' },
    });
    await t.command.push(noFlags);
    expect(t.lines).toContain(
      'warn: Your organization manages some Claude Code settings on this PC.',
    );
    expect(t.lines.some((line) => line.includes('does not know this yet: snippets/'))).toBe(true);
    const { bundle } = await received(t.server, { kind: 'global' });
    expect(bundle.files.map((file) => file.path)).toContain('.agentnomad/env.json');
  });

  it('keeps binary files byte for byte', async () => {
    const png = {
      path: 'skills/logo.png',
      content: new Uint8Array([0x89, 0x50, 0, 255, 1]),
      executable: false,
    };
    const t = setup(['global', false], { adapter: fakeAdapter({ global: [png] }) });
    await t.command.push(noFlags);
    const { bundle } = await received(t.server, { kind: 'global' });
    expect(bundle.files[0]).toEqual({
      path: 'skills/logo.png',
      executable: false,
      encoding: 'base64',
      content: 'iVAA/wE=',
    });
  });

  it('refuses a setup over 5 MB with a clear message, uploading nothing', async () => {
    // A codec that returns 6 MB at once, instead of compressing 6 MB for real (slow).
    const codec: BundleCodec = {
      encode: () => Promise.resolve(new Uint8Array(6 * 1024 * 1024)),
      decode: () => Promise.reject(new Error('not used')),
    };
    const t = setup(['global', false], { codec });
    await t.command.push(noFlags);
    expect(t.server.puts).toEqual([]);
    expect(t.lines.at(-1)).toBe(
      'error: The Claude Code global setup is 6.0 MB after compression and encryption; the limit is 5 MB. Remove large files (e.g. images in skills) and try again.',
    );
  });

  it('needs a login first', async () => {
    const empty: SecretStore = {
      backend: 'keychain',
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    await expect(setup([], { secrets: empty }).command.push(noFlags)).rejects.toBeInstanceOf(
      NotLoggedInPushError,
    );
  });
});
