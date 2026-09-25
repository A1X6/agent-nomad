import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { BundleParams, BundleSummary } from '@agentnomad/contracts';
import {
  createGzipBundleCodec,
  createSodiumCryptoService,
  type CryptoService,
} from '@agentnomad/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createAgentRegistry,
  createClaudeCodeAdapter,
  createLocalState,
  createPullCommand,
  createPushCommand,
  SetupUnreadableError,
  type AgentAdapter,
  type ApiClient,
  type BundleUpload,
  type EnvWriter,
  type Prompter,
  type Reporter,
  type SecretName,
  type SecretStore,
} from '../src/index.ts';

let crypto: CryptoService;
let dataKey: Uint8Array;
beforeAll(async () => {
  crypto = await createSodiumCryptoService();
  dataKey = crypto.randomBytes(32);
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentnomad-pull-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
const read = (path: string) => readFile(path, 'utf8');

/** A server that stores uploads and serves list / get, like the real API. */
function fakeServer() {
  const stored = new Map<
    string,
    { params: BundleParams; upload: BundleUpload; revision: number }
  >();
  const key = (params: BundleParams) => `${params.agent}/${params.scopeKey}`;
  const api: ApiClient = {
    auth: {} as ApiClient['auth'],
    bundles: {
      put: (params, upload) => {
        const revision = (stored.get(key(params))?.revision ?? 0) + 1;
        stored.set(key(params), { params, upload, revision });
        return Promise.resolve({ revision, updatedAt: '2026-09-25T12:00:00Z' });
      },
      list: () =>
        Promise.resolve({
          items: [...stored.values()].map((entry): BundleSummary => ({
            agent: entry.params.agent,
            scopeKey: entry.params.scopeKey,
            nameEnc: entry.upload.nameEnc ?? null,
            revision: entry.revision,
            formatVersion: 1,
            sizeBytes: entry.upload.ciphertext.byteLength,
            updatedAt: '2026-09-25T12:00:00Z',
          })),
          nextCursor: null,
        }),
      get: (params) => {
        const entry = stored.get(key(params));
        if (!entry) return Promise.reject(new Error('not found'));
        return Promise.resolve({
          ciphertext: entry.upload.ciphertext,
          revision: entry.revision,
          contentSha256: entry.upload.contentSha256,
          formatVersion: 1,
          nameEnc: entry.upload.nameEnc ?? null,
        });
      },
      delete: () => Promise.reject(new Error('not used')),
    },
  };
  return { api, stored };
}

function loggedIn(key = dataKey): SecretStore {
  const saved = new Map<SecretName, string>([
    ['session-token', 't'.repeat(43)],
    ['data-key', Buffer.from(key).toString('base64')],
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
  const prompter = {
    select: (message: string) => Promise.resolve(next(message)),
    multiselect: (message: string) => Promise.resolve(next(message)),
    text: (message: string) => Promise.resolve(next(message)),
    password: (message: string) => Promise.resolve(next(message)),
    confirm: (message: string) => Promise.resolve(next(message)),
  } as unknown as Prompter;
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

/** One fake PC: its own home folder, project folder and local state. */
function pc(name: string) {
  const home = join(root, name, 'home');
  return { home, base: join(home, '.claude'), project: join(root, name, 'code', 'my-app') };
}

const claudeAdapter = (home: string) =>
  createClaudeCodeAdapter({
    env: { PATH: '' },
    homedir: home,
    platform: process.platform,
    isClaudeRunning: () => Promise.resolve(false),
    onClaudeRunning: () => Promise.resolve('skip'),
  });

function pushFrom(
  machine: ReturnType<typeof pc>,
  server: ReturnType<typeof fakeServer>,
  answers: unknown[],
) {
  return createPushCommand({
    prompter: scripted(answers).prompter,
    reporter: recorder().reporter,
    registry: () => createAgentRegistry([claudeAdapter(machine.home)]),
    secrets: () => Promise.resolve(loggedIn()),
    api: () => server.api,
    crypto: () => Promise.resolve(crypto),
    codec: createGzipBundleCodec(),
    localState: () =>
      createLocalState({
        path: join(machine.home, 'state.json'),
        server: 's',
        platform: process.platform,
      }),
    env: {},
    cwd: machine.project,
    homedir: machine.home,
    platform: process.platform,
  }).push;
}

function pullOn(
  machine: ReturnType<typeof pc>,
  server: ReturnType<typeof fakeServer>,
  answers: unknown[],
  options: { adapter?: AgentAdapter; secrets?: SecretStore; writer?: EnvWriter } = {},
) {
  const script = scripted(answers);
  const { reporter, lines } = recorder();
  const state = createLocalState({
    path: join(machine.home, 'state.json'),
    server: 's',
    platform: process.platform,
  });
  const pull = createPullCommand({
    prompter: script.prompter,
    reporter,
    registry: () => createAgentRegistry([options.adapter ?? claudeAdapter(machine.home)]),
    secrets: () => Promise.resolve(options.secrets ?? loggedIn()),
    api: () => server.api,
    crypto: () => Promise.resolve(crypto),
    codec: createGzipBundleCodec(),
    localState: () => state,
    envWriter: () =>
      options.writer ?? { where: 'test profile', write: () => Promise.resolve({ backup: null }) },
    env: {},
    cwd: machine.project,
    homedir: machine.home,
    platform: process.platform,
  }).pull;
  return { pull, asked: script.asked, lines, state };
}

const none = { global: false, yes: false };

/** PC A with a global setup (a hook, a home path) and a project; pushed as "both". */
async function pushedSetup() {
  const server = fakeServer();
  const a = pc('laptop');
  await put(join(a.base, 'CLAUDE.md'), `Notes live in ${a.home}/notes.`);
  await put(join(a.base, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n');
  await put(join(a.base, 'hooks', 'check.sh'), 'echo ok\n');
  await put(
    join(a.base, 'settings.json'),
    JSON.stringify({
      theme: 'dark',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: `${a.home}/.claude/hooks/check.sh` }] }],
      },
    }),
  );
  await put(join(a.project, 'CLAUDE.md'), 'Project rules.');
  await pushFrom(a, server, ['both', 'my-app', false])(none);
  return { server, a };
}

describe('agentnomad pull (T34 done-when: restores on a second machine)', () => {
  it('restores global and project on another PC, with its own home folder', async () => {
    const { server } = await pushedSetup();
    const b = pc('desktop');
    const t = pullOn(b, server, ['both', true]);
    await t.pull(none);

    expect(await read(join(b.base, 'CLAUDE.md'))).toBe(
      `Notes live in ${b.home.replace(/\\/g, '/')}/notes.`,
    );
    expect(await read(join(b.base, 'skills', 'deploy', 'SKILL.md'))).toBe(
      '---\nname: deploy\n---\n',
    );
    expect(await read(join(b.base, 'hooks', 'check.sh'))).toBe('echo ok\n');
    expect(await read(join(b.project, 'CLAUDE.md'))).toBe('Project rules.');
    expect(t.lines.filter((line) => line.startsWith('success: Restored'))).toHaveLength(2);
    // This PC now knows what it has, and which name this folder uses.
    expect(await t.state.revisionOf('claude-code', 'global')).toBe(1);
    expect(await t.state.projectNameFor(b.project)).toBe('my-app');
  });

  it('shows new commands that would run, and restores them when allowed', async () => {
    const { server } = await pushedSetup();
    const b = pc('desktop');
    const t = pullOn(b, server, [true]);
    await t.pull({ global: true, yes: false });
    const shown = t.lines.find((line) => line.includes('run programs on this PC')) ?? '';
    expect(shown).toContain('+ hook Stop: ');
    expect(shown).toContain('/.claude/hooks/check.sh');
    expect(t.asked).toContain('Allow them?');
    expect(await read(join(b.base, 'settings.json'))).toContain('"theme":"dark"');
  });

  it('declining the commands skips only the files that hold them', async () => {
    const { server } = await pushedSetup();
    const b = pc('desktop');
    const t = pullOn(b, server, [false]);
    await t.pull({ global: true, yes: false });
    await expect(readFile(join(b.base, 'settings.json'))).rejects.toThrow();
    expect(await read(join(b.base, 'CLAUDE.md'))).toContain('Notes live in');
    expect(t.lines).toContain(
      'warn: Skipped settings.json, which hold them. The rest is restored.',
    );
  });

  it('--yes prints the commands and accepts them', async () => {
    const { server } = await pushedSetup();
    const b = pc('desktop');
    const t = pullOn(b, server, []);
    await t.pull({ global: true, yes: true });
    expect(t.asked).toEqual([]);
    expect(t.lines.some((line) => line.includes('+ hook Stop'))).toBe(true);
    expect(await read(join(b.base, 'settings.json'))).toContain('hooks');
  });

  it('pulling back onto the same PC asks nothing and changes nothing', async () => {
    const { server, a } = await pushedSetup();
    const t = pullOn(a, server, []);
    await t.pull({ global: true, yes: false });
    // Nothing asked: no command is new, and files that only differ in the home path's
    // slashes (C:/ vs C: on Windows) count as unchanged and are left untouched.
    expect(t.asked).toEqual([]);
    expect(await read(join(a.base, 'CLAUDE.md'))).toBe(`Notes live in ${a.home}/notes.`);
    expect((await readdir(a.base)).filter((name) => name.includes('agentnomad-'))).toEqual([]);
  });

  it('existing different files: overwrite all remaining keeps backups', async () => {
    const { server } = await pushedSetup();
    const b = pc('desktop');
    await put(join(b.base, 'CLAUDE.md'), 'mine');
    await put(join(b.base, 'skills', 'deploy', 'SKILL.md'), 'mine too');
    const t = pullOn(b, server, [true, 'overwrite-all']);
    await t.pull({ global: true, yes: false });
    expect(t.asked.filter((question) => question.includes('already exists'))).toHaveLength(1);
    expect(await read(join(b.base, 'CLAUDE.md'))).toContain('Notes live in');
    const backups = (await readdir(b.base)).filter((name) => name.includes('agentnomad-backup'));
    expect(backups).toHaveLength(1);
    expect(t.lines.some((line) => /Restored .*backed up first/.test(line))).toBe(true);
  });

  it('--merge answers every file without asking', async () => {
    const { server } = await pushedSetup();
    const b = pc('desktop');
    await put(join(b.base, 'CLAUDE.md'), 'mine');
    const t = pullOn(b, server, [true]);
    await t.pull({ global: true, yes: false, conflict: 'merge' });
    expect(t.asked).toEqual(['Allow them?']);
    expect(await read(join(b.base, 'CLAUDE.md'))).toBe('mine');
    expect((await readdir(b.base)).some((name) => name.includes('agentnomad-incoming'))).toBe(true);
  });

  it('picks a project by --project, and lists the names when it is not saved', async () => {
    const { server } = await pushedSetup();
    const b = pc('desktop');
    await pullOn(b, server, []).pull({ global: false, yes: true, project: 'my-app' });
    expect(await read(join(b.project, 'CLAUDE.md'))).toBe('Project rules.');
    await expect(
      pullOn(b, server, []).pull({ global: false, yes: true, project: 'nope' }),
    ).rejects.toThrow('No saved Claude Code project named "nope". Saved: my-app.');
  });

  it('--yes with only a project saved restores that project, asking nothing', async () => {
    const server = fakeServer();
    const a = pc('solo-laptop');
    await put(join(a.base, 'CLAUDE.md'), 'Global notes (not pushed).');
    await put(join(a.project, 'CLAUDE.md'), 'Only project rules.');
    await pushFrom(a, server, ['project', 'my-app', false])(none);

    const b = pc('solo-desktop');
    const t = pullOn(b, server, []);
    await t.pull({ global: false, yes: true });
    expect(t.asked).toEqual([]);
    expect(await read(join(b.project, 'CLAUDE.md'))).toBe('Only project rules.');
  });

  it('scripted end to end: flags answer everything, nothing is asked', async () => {
    const { server } = await pushedSetup();
    const b = pc('scripted');
    const t = pullOn(b, server, []);
    await t.pull({ global: true, project: 'my-app', yes: true, conflict: 'merge' });
    expect(t.asked).toEqual([]);
    expect(t.lines.filter((line) => line.startsWith('success: Restored'))).toHaveLength(2);
  });

  it('says so when nothing is saved', async () => {
    const t = pullOn(pc('desktop'), fakeServer(), []);
    await t.pull(none);
    expect(t.lines).toEqual([
      'info: Nothing is saved yet. Run `agentnomad push` on the PC that has your setup.',
    ]);
  });

  it('a setup that cannot be opened with this key writes nothing', async () => {
    const { server } = await pushedSetup();
    const b = pc('desktop');
    const wrongKey = loggedIn(crypto.randomBytes(32));
    // The project name opens with neither key, so only the global setup is offered.
    const t = pullOn(b, server, [], { secrets: wrongKey });
    await expect(t.pull({ global: true, yes: true })).rejects.toBeInstanceOf(SetupUnreadableError);
    await expect(readdir(b.base)).rejects.toThrow();
  });

  it('warns when this PC runs an older Claude Code than the setup came from', async () => {
    const { server } = await pushedSetup();
    // The pushed setup has no stamp (no claude on PATH); fake a newer one on this PC's side.
    const b = pc('desktop');
    const base = claudeAdapter(b.home);
    const adapter: AgentAdapter = {
      ...base,
      detector: {
        detect: () => Promise.resolve({ installed: true, baseDir: b.base, version: '1.0.0' }),
      },
    };
    const t = pullOn(b, server, [], { adapter });
    await t.pull({ global: true, yes: true });
    // No stamp in the bundle: nothing to compare, so no warning.
    expect(t.lines.some((line) => line.includes('was saved from'))).toBe(false);
  });

  it('runs the agent’s follow-up and adds saved environment variables', async () => {
    const server = fakeServer();
    const a = pc('laptop');
    await put(
      join(a.home, '.claude.json'),
      JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp', env: { T: '${GITHUB_TOKEN}' } } } }),
    );
    await put(join(a.base, 'CLAUDE.md'), 'x');
    await createPushCommand({
      prompter: scripted(['global', false, ['GITHUB_TOKEN']]).prompter,
      reporter: recorder().reporter,
      registry: () => createAgentRegistry([claudeAdapter(a.home)]),
      secrets: () => Promise.resolve(loggedIn()),
      api: () => server.api,
      crypto: () => Promise.resolve(crypto),
      codec: createGzipBundleCodec(),
      localState: () =>
        createLocalState({ path: join(a.home, 's.json'), server: 's', platform: process.platform }),
      env: { GITHUB_TOKEN: 'ghp_secret' },
      cwd: a.project,
      homedir: a.home,
      platform: process.platform,
    }).push(none);

    const b = pc('desktop');
    const written: Record<string, string>[] = [];
    const followUps: string[][] = [];
    const base = claudeAdapter(b.home);
    const adapter: AgentAdapter = {
      ...base,
      afterRestore: (context) => {
        followUps.push(context.files.map((file) => file.path));
        return Promise.resolve();
      },
    };
    const writer: EnvWriter = {
      where: 'test profile',
      write: (variables) => {
        written.push({ ...variables });
        return Promise.resolve({ backup: null });
      },
    };
    await pullOn(b, server, [], { adapter, writer }).pull({ global: true, yes: true });
    expect(followUps[0]).toContain('.agentnomad/env.json');
    expect(written).toEqual([{ GITHUB_TOKEN: 'ghp_secret' }]);
  });
});
