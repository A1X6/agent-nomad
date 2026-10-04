import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BundleSummary } from '@agentnomad/contracts';
import {
  createSodiumCryptoService,
  encryptProjectName,
  scopeKeyFor,
  type CryptoService,
} from '@agentnomad/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CWD,
  fakeAdapter,
  fakeApi,
  localStateIn,
  memorySecretStore,
  recordingReporter,
  scriptedPrompter,
} from './fakes.ts';

import {
  createAgentRegistry,
  createSetupCommands,
  NotLoggedInError,
  timeAgo,
  type LocalState,
} from '../src/index.ts';

const NOW = new Date('2026-09-25T12:00:00Z');

let crypto: CryptoService;
let dataKey: Uint8Array;
beforeAll(async () => {
  crypto = await createSodiumCryptoService();
  dataKey = crypto.randomBytes(32);
});

let dir: string;
let state: LocalState;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentnomad-cmds-'));
  state = localStateIn(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const claude = fakeAdapter('claude-code', 'Claude Code', {
  installed: true,
  baseDir: null,
  version: null,
});

/** A server holding a global setup and two projects. */
function fakeServer() {
  const project = (name: string) => {
    const scopeKey = scopeKeyFor(crypto, dataKey, { kind: 'project', name });
    const nameEnc = Buffer.from(
      encryptProjectName(crypto, dataKey, name, { agent: 'claude-code', scopeKey }),
    ).toString('base64');
    return { scopeKey, nameEnc };
  };
  const items: BundleSummary[] = [
    {
      agent: 'claude-code',
      scopeKey: 'global',
      nameEnc: null,
      revision: 3,
      formatVersion: 1,
      sizeBytes: 5120,
      updatedAt: '2026-09-25T10:00:00Z',
    },
    {
      agent: 'claude-code',
      ...project('my-app'),
      revision: 5,
      formatVersion: 1,
      sizeBytes: 3000,
      updatedAt: '2026-09-24T09:00:00Z',
    },
    {
      agent: 'claude-code',
      ...project('website'),
      revision: 1,
      formatVersion: 1,
      sizeBytes: 900,
      updatedAt: '2026-09-10T09:00:00Z',
    },
  ];
  const deleted: string[] = [];
  const api = fakeApi({
    bundles: {
      list: () =>
        Promise.resolve({
          items: items.filter((item) => !deleted.includes(item.scopeKey)),
          nextCursor: null,
        }),
      delete: (params: { scopeKey: string }) => {
        deleted.push(params.scopeKey);
        return Promise.resolve();
      },
    },
  });
  return { api, items, deleted, keyOf: (name: string) => project(name).scopeKey };
}

function commands(
  server: ReturnType<typeof fakeServer>,
  answers: unknown[] = [],
  secrets = memorySecretStore({ loggedIn: dataKey }),
) {
  const script = scriptedPrompter(answers);
  const { reporter, lines } = recordingReporter();
  const handlers = createSetupCommands({
    prompter: script.prompter,
    reporter,
    registry: () => createAgentRegistry([claude]),
    secrets: () => Promise.resolve(secrets),
    api: () => server.api,
    crypto: () => Promise.resolve(crypto),
    localState: () => state,
    cwd: CWD,
    now: () => NOW,
  });
  return { ...handlers, asked: script.asked, lines };
}

const noFlags = { global: false };

describe('agentnomad list', () => {
  it('shows every saved setup with names decrypted, size and age', async () => {
    const t = commands(fakeServer());
    await t.list();
    expect(t.lines).toEqual([
      [
        'info: Claude Code',
        '  global setup       revision 3    5 KB  2 hours ago',
        '  project "my-app"   revision 5    3 KB  yesterday',
        '  project "website"  revision 1   900 B  15 days ago',
      ].join('\n'),
    ]);
  });

  it('says so when nothing is saved, and needs a login', async () => {
    const empty = fakeServer();
    empty.items.length = 0;
    const t = commands(empty);
    await t.list();
    expect(t.lines[0]).toContain('Nothing is saved yet');
    const none = memorySecretStore({ backend: 'file' });
    await expect(commands(fakeServer(), [], none).list()).rejects.toBeInstanceOf(NotLoggedInError);
  });
});

describe('agentnomad status', () => {
  it('compares this PC’s revisions with the server', async () => {
    const server = fakeServer();
    await state.setRevision('claude-code', 'global', 3);
    await state.setRevision('claude-code', server.keyOf('my-app'), 2);
    await state.setRevision('claude-code', 'f'.repeat(64), 4);
    await state.rememberProject(CWD, 'my-app');
    const t = commands(server);
    await t.status(noFlags);
    expect(t.lines).toEqual([
      [
        'info: ✓ Claude Code global setup: up to date (revision 3)',
        '↓ Claude Code project "my-app": newer copy on the server (revision 5, this PC has 2). Run `agentnomad pull`.',
        '· Claude Code project "website": never pulled or pushed on this PC',
        '✗ A Claude Code setup this PC had was deleted on the server.',
      ].join('\n'),
      'info: This folder is saved as "my-app".',
    ]);
  });

  it('narrows to --project', async () => {
    const t = commands(fakeServer());
    await t.status({ global: false, project: 'website' });
    expect(t.lines[0]).toBe(
      'info: · Claude Code project "website": never pulled or pushed on this PC',
    );
    expect(t.lines[1]).toBe('info: This folder is not saved as a project.');
  });
});

describe('agentnomad delete', () => {
  it('deletes the chosen setups after asking, and forgets them on this PC', async () => {
    const server = fakeServer();
    await state.setRevision('claude-code', server.keyOf('website'), 1);
    const t = commands(server, [[`claude-code/${server.keyOf('website')}`], true]);
    await t.delete({ global: false, yes: false });
    expect(server.deleted).toEqual([server.keyOf('website')]);
    expect(t.asked[1]).toBe(
      'Delete Claude Code project "website" from the server? This cannot be undone.',
    );
    expect(await state.revisionOf('claude-code', server.keyOf('website'))).toBeNull();
    expect(t.lines.at(-1)).toBe(
      'success: Deleted the Claude Code project "website" from the server.',
    );
  });

  it('deletes nothing when the user says no', async () => {
    const server = fakeServer();
    const t2 = commands(server, [false]);
    await t2.delete({ global: true, yes: false });
    expect(t2.lines.at(-1)).toBe('info: Nothing was deleted.');
    expect(server.deleted).toEqual([]);
  });

  it('--project with --yes deletes without asking; an unknown name deletes nothing', async () => {
    const server = fakeServer();
    const t = commands(server);
    await t.delete({ global: false, project: 'my-app', yes: true });
    expect(t.asked).toEqual([]);
    expect(server.deleted).toEqual([server.keyOf('my-app')]);
    await expect(
      commands(server).delete({ global: false, project: 'nope', yes: true }),
    ).rejects.toThrow('No saved setup matches');
  });

  it('--agent with nothing saved for that agent says so instead of an empty checklist (UX-04)', async () => {
    const server = fakeServer();
    const t = commands(server);
    await expect(t.delete({ global: false, agents: ['codex'], yes: false })).rejects.toThrow(
      'No saved setup matches. Run `agentnomad list` to see them.',
    );
    expect(t.asked).toEqual([]);
    expect(server.deleted).toEqual([]);
  });
});

describe('formatting', () => {
  it.each([
    ['2026-09-25T11:59:30Z', 'just now'],
    ['2026-09-25T11:55:00Z', '5 minutes ago'],
    ['2026-09-25T11:00:00Z', '1 hour ago'],
    ['2026-09-24T11:00:00Z', 'yesterday'],
    ['2026-09-20T12:00:00Z', '5 days ago'],
    ['2026-01-02T12:00:00Z', '2026-01-02'],
  ])('%s is %s', (iso, text) => {
    expect(timeAgo(iso, NOW)).toBe(text);
  });
});
