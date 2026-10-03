import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  createGzipBundleCodec,
  createSodiumCryptoService,
  decryptProjectName,
  openBundle,
  scopeKeyFor,
  type BundleCodec,
  type CryptoService,
} from '@agentnomad/core';
import { afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  collected,
  fakeBundleServer,
  memorySecretStore,
  recordingReporter,
  scriptedPrompter,
  storedOn,
} from './fakes.ts';
import { stubRestorer } from './stub-restorer.ts';
import {
  CLAUDE_ENV_REFERENCES,
  createAgentRegistry,
  createClaudeCodeAdapter,
  createLocalState,
  createPushApplier,
  createPushCommand,
  createPushPlanner,
  NotLoggedInError,
  ProjectFolderError,
  PromptCancelledError,
  SetupsNotDoneError,
  type AgentAdapter,
  type CollectedFile,
  type Prompter,
  type PushApplyDeps,
  type PushDeps,
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
const loggedIn = () => memorySecretStore({ loggedIn: dataKey });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentnomad-push-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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
    memoryDescription: 'what Claude learned: subagent and auto memory',
    detector: {
      detect: () =>
        Promise.resolve({ installed: true, baseDir: `${HOME}/.claude`, version: '2.1.282' }),
    },
    collector: {
      collect: (target) =>
        Promise.resolve(
          target.kind === 'global'
            ? (options.global ?? [collected('CLAUDE.md', `Scripts in ${HOME}/scripts`)])
            : (options.project ?? [collected('CLAUDE.md', 'project rules')]),
        ),
    },
    restorer: stubRestorer(),
    envReferences: CLAUDE_ENV_REFERENCES,
    inspector: {
      unknownEntries: () => Promise.resolve(options.unknown ?? []),
      notices: () => Promise.resolve(options.notices ?? []),
    },
  };
}

function setup(
  answers: unknown[],
  options: {
    adapter?: AgentAdapter;
    server?: ReturnType<typeof fakeBundleServer>;
    secrets?: SecretStore;
    cwd?: string;
    env?: Record<string, string>;
    /** Which PC: each PC has its own local state file. */
    pc?: string;
    codec?: BundleCodec;
    prompter?: Prompter;
  } = {},
) {
  const server = options.server ?? fakeBundleServer();
  const script = scriptedPrompter(answers);
  const { reporter, lines } = recordingReporter();
  const state = createLocalState({
    path: join(dir, `${options.pc ?? 'this-pc'}.json`),
    server: 'api.test',
    platform: process.platform,
  });
  // What apply gets: everything but the prompter.
  const applyDeps: PushApplyDeps = {
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
  };
  const deps: PushDeps = { ...applyDeps, prompter: options.prompter ?? script.prompter };
  const command = createPushCommand(deps);
  return { command, deps, applyDeps, server, script, lines, state };
}

const noFlags = { global: false, yes: false };

/** What the server received, decrypted with the owner's key. */
async function received(
  server: ReturnType<typeof fakeBundleServer>,
  scope: { kind: 'global' } | { kind: 'project'; name: string },
) {
  const scopeKey = scopeKeyFor(crypto, dataKey, scope);
  const entry = storedOn(server, scopeKey);
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
    // The revision is sealed inside, so a server cannot relabel an old copy (T38).
    expect(bundle.revision).toBe(revision);
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
      adapter: fakeAdapter({ global: [collected('CLAUDE.md', 'SECRET-PLAN-XYZ')] }),
    });
    await t.command.push(noFlags);
    const sent = t.server.puts
      .map((put) => Buffer.from(put.upload.ciphertext).toString('latin1'))
      .join('');
    expect(sent).not.toContain('SECRET-PLAN-XYZ');
    // Gzip alone already hides the marker: the upload must not be a plain gzip stream either.
    for (const put of t.server.puts) expect(() => gunzipSync(put.upload.ciphertext)).toThrow();
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

  it('a typed project name is remembered only once the project is saved (UX-03)', async () => {
    // Cancelled at the memory question, after the name was typed.
    const t = setup(['project', 'my-typo', new Error('cancelled')]);
    await expect(t.command.push(noFlags)).rejects.toThrow('cancelled');
    expect(t.server.puts).toEqual([]);
    expect(await t.state.projectNameFor(PROJECT)).toBeNull();
  });

  it('a second push from the same folder asks no name and moves to the next revision', async () => {
    const server = fakeBundleServer();
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

  describe('claude.ai skills (T42)', () => {
    // Claude Code's own optional part (its texts), with what this fake PC has.
    const claudePart = createClaudeCodeAdapter({
      env: { PATH: '' },
      homedir: HOME,
      platform: process.platform,
      isClaudeRunning: () => Promise.resolve(false),
    }).optionalParts?.[0];

    function withAccountSkills(names: string[], problem: string | null = null) {
      const seen: boolean[] = [];
      const base = fakeAdapter();
      if (claudePart === undefined) throw new Error('no account skills part');
      const adapter: AgentAdapter = {
        ...base,
        collector: {
          collect: (target, options) => {
            seen.push(options.include?.has('account-skills') === true);
            return base.collector.collect(target, options);
          },
        },
        optionalParts: [{ ...claudePart, available: () => Promise.resolve({ names, problem }) }],
      };
      return { adapter, seen };
    }

    it('says when they cannot be read, and that they were not saved', async () => {
      const broken = withAccountSkills([], 'The synced skills folder could not be read.');
      const t = setup([], { adapter: broken.adapter });
      await t.command.push({ global: true, yes: false, memory: false });
      expect(t.lines).toContain(
        'warn: The synced skills folder could not be read. Your claude.ai skills were not saved.',
      );
      expect(t.script.asked).toEqual([]);
    });

    it('--account-skills with none here says so', async () => {
      const none = withAccountSkills([]);
      const t = setup([], { adapter: none.adapter });
      await t.command.push({
        global: true,
        yes: true,
        parts: new Map([['account-skills', true]]),
      });
      expect(t.lines).toContain('info: No claude.ai skills of your own were found on this PC.');
    });

    it('asks about them only when there are some; no by default', async () => {
      const some = withAccountSkills(['my-skill']);
      const t = setup([false], { adapter: some.adapter });
      await t.command.push({ global: true, yes: false, memory: false });
      expect(t.script.asked).toEqual([
        'Also save a copy of your 1 claude.ai skill (my-skill)? Your claude.ai account already syncs them; the copy is for PCs without that account.',
      ]);
      expect(some.seen).toEqual([false]);

      const none = withAccountSkills([]);
      const quiet = setup([], { adapter: none.adapter, pc: 'no-account-skills' });
      await quiet.command.push({ global: true, yes: false, memory: false });
      expect(quiet.script.asked).toEqual([]);
    });

    it('--account-skills includes them without asking, for the global setup only', async () => {
      const some = withAccountSkills(['my-skill']);
      const t = setup(['my-app'], { adapter: some.adapter });
      await t.command.push({
        global: true,
        project: 'my-app',
        yes: true,
        memory: false,
        parts: new Map([['account-skills', true]]),
      });
      expect(t.script.asked).toEqual([]);
      expect(some.seen).toEqual([true, false]);
    });

    it('--yes alone leaves them out without asking', async () => {
      const some = withAccountSkills(['my-skill']);
      const t = setup([], { adapter: some.adapter });
      await t.command.push({ global: true, yes: true });
      expect(t.script.asked).toEqual([]);
      expect(some.seen).toEqual([false]);
    });
  });

  it.each([
    [true, true],
    [false, false],
  ])('--memory=%s answers the memory question from a script', async (memory, expected) => {
    const seen: boolean[] = [];
    const base = fakeAdapter();
    const adapter: AgentAdapter = {
      ...base,
      collector: {
        collect: (target, options) => {
          seen.push(options.includeMemory);
          return base.collector.collect(target, options);
        },
      },
    };
    const t = setup([], { adapter });
    await t.command.push({ global: true, yes: true, memory });
    expect(t.script.asked).toEqual([]);
    expect(seen).toEqual([expected]);
  });

  it('never offers the home folder as a project', async () => {
    const t = setup([false], { cwd: HOME });
    await t.command.push(noFlags);
    expect(t.script.asked).toEqual([
      'Include memory (what Claude learned: subagent and auto memory)?',
    ]);
    expect(t.server.stored.size).toBe(1);
  });

  it.each([
    ['the home folder', HOME, { project: 'home' }],
    ['the home folder, with --global too', HOME, { global: true, project: 'home' }],
    ["Claude Code's own folder", join(HOME, '.claude'), { project: 'dot-claude' }],
  ])('refuses --project in %s, saving nothing (BUG-05)', async (_, cwd, flags) => {
    const t = setup([], { cwd });
    const push = t.command.push({ global: false, yes: true, ...flags });
    await expect(push).rejects.toThrow(ProjectFolderError);
    await expect(push).rejects.toThrow("Run the command again from the project's folder.");
    expect(t.server.stored.size).toBe(0);
    expect(await t.state.projectNameFor(cwd)).toBeNull();
  });

  it("never offers Claude Code's own folder as a project (BUG-05)", async () => {
    const t = setup([false], { cwd: join(HOME, '.claude') });
    await t.command.push(noFlags);
    expect(t.script.asked).toEqual([
      'Include memory (what Claude learned: subagent and auto memory)?',
    ]);
    expect(t.server.stored.size).toBe(1);
  });

  it('asks before replacing a newer copy from another PC; no keeps it', async () => {
    const server = fakeBundleServer();
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
    const server = fakeBundleServer();
    await setup(['global', false], { server, pc: 'laptop' }).command.push(noFlags);
    const desktop = setup([], { server, pc: 'desktop' });
    await expect(desktop.command.push({ global: true, yes: true })).rejects.toThrow(
      'Not saved:\n  - the Claude Code global setup: a newer copy exists',
    );
    expect(desktop.script.asked).toEqual([]);
    expect(desktop.lines.some((line) => line.includes('Run `agentnomad pull` first'))).toBe(true);
    expect((await received(server, { kind: 'global' })).revision).toBe(1);
  });

  it('replaces the newer copy when the user says yes, and remembers the new revision', async () => {
    const server = fakeBundleServer();
    await setup(['global', false], { server, pc: 'laptop' }).command.push(noFlags);
    const desktop = setup(['global', false, true], { server, pc: 'desktop' });
    await desktop.command.push(noFlags);
    const saved = await received(server, { kind: 'global' });
    expect(saved.revision).toBe(2);
    // Encrypted again for the revision it became, not the one first tried (T38).
    expect(saved.bundle.revision).toBe(2);
    expect(await desktop.state.revisionOf('claude-code', 'global')).toBe(2);
  });

  it('shows unknown-file and managed-settings notices, and offers env values', async () => {
    const adapter = fakeAdapter({
      global: [
        collected(
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
    await expect(t.command.push(noFlags)).rejects.toThrow(
      'Not saved:\n  - the Claude Code global setup: 6.0 MB, over the 5.0 MB limit',
    );
    expect(t.server.puts).toEqual([]);
    expect(t.lines.at(-1)).toBe(
      'error: The Claude Code global setup is 6.0 MB after compression and encryption; the limit is 5.0 MB. Remove large files (e.g. images in skills) and try again.',
    );
  });

  it('--yes skips a newer copy, saves the other setups, then exits with code 1 (BUG-03)', async () => {
    const server = fakeBundleServer();
    await setup(['global', false], { server, pc: 'laptop' }).command.push(noFlags);
    const desktop = setup([], { server, pc: 'desktop' });
    const pushed = desktop.command.push({ global: true, project: 'my-app', yes: true });
    await expect(pushed).rejects.toBeInstanceOf(SetupsNotDoneError);
    await expect(pushed).rejects.toThrow(
      'Not saved:\n  - the Claude Code global setup: a newer copy exists',
    );
    // The project, planned after the refused global setup, was still saved.
    expect((await received(server, { kind: 'project', name: 'my-app' })).revision).toBe(1);
    expect((await received(server, { kind: 'global' })).revision).toBe(1);
  });

  it('a partial last pull names no cause it cannot know, such as a kept file (UX-01)', async () => {
    const server = fakeBundleServer();
    await setup(['global', false], { server, pc: 'laptop' }).command.push(noFlags);
    // The note a pull leaves when it kept a differing file as it was; state.json does not
    // say why a pull was partial, so push must not blame declined commands.
    const desktop = setup([], { server, pc: 'desktop' });
    await desktop.state.setRevision('claude-code', 'global', 1, { partial: true });

    await expect(desktop.command.push({ global: true, yes: true, memory: false })).rejects.toThrow(
      'Not saved:\n  - the Claude Code global setup: its last pull here did not restore everything',
    );
    expect(desktop.lines.some((line) => line.includes('Run `agentnomad pull` first'))).toBe(true);
    expect(desktop.lines.join('\n')).not.toMatch(/--allow-commands|commands you declined/);

    const asked = setup([true], { server, pc: 'desktop' });
    await asked.command.push({ global: true, yes: false, memory: false });
    expect(asked.script.asked).toEqual([
      "This PC's last pull of the Claude Code global setup did not restore everything, so pushing now may drop parts of the saved copy (and of your other PCs on their next pull). Push anyway?",
    ]);
    expect((await received(server, { kind: 'global' })).revision).toBe(2);
  });

  it('--yes skips a copy deleted on the server; a yes from the user saves it again', async () => {
    const server = fakeBundleServer();
    const t = setup(['global', false], { server });
    await t.command.push(noFlags);
    server.stored.clear();
    await expect(t.command.push({ global: true, yes: true })).rejects.toThrow(
      'the Claude Code global setup: it was deleted on the server',
    );
    const again = setup(['global', false, true], { server });
    await again.command.push(noFlags);
    expect(again.script.asked.at(-1)).toBe(
      'The saved Claude Code global setup was deleted since this PC last had it. Save it again?',
    );
    expect((await received(server, { kind: 'global' })).revision).toBe(1);
  });

  it('the plan step asks every question and uploads nothing; apply uploads and asks nothing (T59)', async () => {
    const server = fakeBundleServer();
    await setup(['global', false], { server, pc: 'laptop' }).command.push(noFlags);
    const desktop = setup(['global', false, true], { server, pc: 'desktop' });
    const keys = { secrets: loggedIn(), crypto, dataKey };

    const plan = await createPushPlanner(desktop.deps).plan(noFlags, keys);
    expect(desktop.script.asked).toEqual([
      'Claude Code: what to save?',
      'Include memory (what Claude learned: subagent and auto memory)?',
      "A newer copy of the Claude Code global setup (revision 1) was saved from another PC. Replace it with this PC's setup?",
    ]);
    expect(plan.uploads.map((upload) => [upload.setup, upload.expectedRevision])).toEqual([
      ['Claude Code global setup', 1],
    ]);
    expect(server.puts).toHaveLength(1);

    // The apply step's deps have no prompter at all: it cannot ask.
    expectTypeOf<PushApplyDeps>().not.toHaveProperty('prompter');
    const outcomes = await createPushApplier(desktop.applyDeps).apply(plan, keys);
    expect(outcomes).toEqual([{ setup: 'Claude Code global setup', result: 'done' }]);
    expect((await received(server, { kind: 'global' })).revision).toBe(2);
    expect(desktop.script.asked).toHaveLength(3);
  });

  it('apply never asks: a copy saved from another PC after the plan is not done (T59)', async () => {
    const server = fakeBundleServer();
    const t = setup(['global', false], { server });
    const keys = { secrets: loggedIn(), crypto, dataKey };
    const plan = await createPushPlanner(t.deps).plan(noFlags, keys);
    // Another PC saves while this push is between its plan and its upload.
    await setup(['global', false], { server, pc: 'laptop' }).command.push(noFlags);

    const outcomes = await createPushApplier(t.applyDeps).apply(plan, keys);
    expect(outcomes).toEqual([
      { setup: 'Claude Code global setup', result: 'not-done', reason: 'a newer copy exists' },
    ]);
    expect(t.lines.at(-1)).toBe(
      'warn: Skipped the Claude Code global setup: a newer copy was saved from another PC while this push ran. Run `agentnomad pull` first to keep its changes.',
    );
    expect((await received(server, { kind: 'global' })).revision).toBe(1);
  });

  describe('the data key is wiped on every path (BP-01)', () => {
    /** Every 32-byte array zeroed with fill(0) while `run` ran. */
    async function wipedKeys(run: () => Promise<unknown>): Promise<Uint8Array[]> {
      const fill = vi.spyOn(Uint8Array.prototype, 'fill');
      try {
        await run().catch(() => undefined);
        return fill.mock.calls.flatMap((call, index) => {
          const array = fill.mock.contexts[index] as Uint8Array;
          return call[0] === 0 && array.length === 32 ? [array] : [];
        });
      } finally {
        fill.mockRestore();
      }
    }
    /** Answers `answers` in order, then cancels the next question (Ctrl+C). */
    const cancelling = (answers: unknown[]): Prompter => {
      const script = scriptedPrompter(answers);
      const cancelled = () => Promise.reject(new PromptCancelledError());
      return {
        ...script.prompter,
        select: (message, choices) =>
          answers.length > 0 ? script.prompter.select(message, choices) : cancelled(),
        confirm: (message) => (answers.length > 0 ? script.prompter.confirm(message) : cancelled()),
      };
    };

    it('Ctrl+C at the first question', async () => {
      const t = setup([], { prompter: cancelling([]) });
      const wiped = await wipedKeys(() => t.command.push(noFlags));
      expect(wiped).toHaveLength(1);
      expect(wiped[0]?.every((byte) => byte === 0)).toBe(true);
      expect(t.server.puts).toEqual([]);
    });

    it('Ctrl+C at the last question, after the key was used', async () => {
      const server = fakeBundleServer();
      await setup(['global', false], { server, pc: 'laptop' }).command.push(noFlags);
      // "What to save?" and memory are answered; "replace the newer copy?" is cancelled.
      const t = setup([], { server, pc: 'desktop', prompter: cancelling(['global', false]) });
      await expect(t.command.push(noFlags)).rejects.toBeInstanceOf(PromptCancelledError);
      const wiped = await wipedKeys(() =>
        setup([], { server, pc: 'desktop', prompter: cancelling(['global', false]) }).command.push(
          noFlags,
        ),
      );
      expect(wiped.length).toBeGreaterThanOrEqual(1);
      expect(server.puts).toHaveLength(1);
    });

    it('an error while collecting', async () => {
      const adapter: AgentAdapter = {
        ...fakeAdapter(),
        collector: { collect: () => Promise.reject(new Error('disk gone')) },
      };
      const t = setup([], { adapter });
      const wiped = await wipedKeys(() => t.command.push({ global: true, yes: true }));
      expect(wiped).toHaveLength(1);
    });

    it('a setup not done, and a successful push', async () => {
      const codec: BundleCodec = {
        encode: () => Promise.resolve(new Uint8Array(6 * 1024 * 1024)),
        decode: () => Promise.reject(new Error('not used')),
      };
      const tooBig = setup([], { codec });
      expect(
        (await wipedKeys(() => tooBig.command.push({ global: true, yes: true }))).length,
      ).toBeGreaterThanOrEqual(1);
      const saved = setup([]);
      const wiped = await wipedKeys(() => saved.command.push({ global: true, yes: true }));
      expect(wiped.length).toBeGreaterThanOrEqual(1);
      expect(saved.server.stored.size).toBe(1);
    });
  });

  it('needs a login first', async () => {
    const empty = memorySecretStore();
    await expect(setup([], { secrets: empty }).command.push(noFlags)).rejects.toBeInstanceOf(
      NotLoggedInError,
    );
    // Push keeps its own wording with the shared error (T62).
    await expect(setup([], { secrets: empty }).command.push(noFlags)).rejects.toThrow(
      /^You are not logged in on this PC\. Run `agentnomad login` first\.$/,
    );
  });
});
