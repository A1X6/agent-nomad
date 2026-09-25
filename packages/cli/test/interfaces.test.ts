import { describe, expect, it } from 'vitest';

import type {
  AgentAdapter,
  AgentRegistry,
  ConflictResolver,
  SecretName,
  SecretStore,
} from '../src/index.ts';

/** In-memory SecretStore, the kind of fake later command tests will use. */
function memorySecretStore(): SecretStore {
  const secrets = new Map<SecretName, string>();
  return {
    backend: 'file',
    get: (name) => Promise.resolve(secrets.get(name) ?? null),
    set: (name, value) => {
      secrets.set(name, value);
      return Promise.resolve();
    },
    delete: (name) => {
      secrets.delete(name);
      return Promise.resolve();
    },
  };
}

const fakeAdapter: AgentAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  detector: {
    detect: () =>
      Promise.resolve({ installed: true, baseDir: '/home/ahmed/.claude', version: '2.1.0' }),
  },
  collector: { collect: () => Promise.resolve([]) },
  restorer: {
    restore: async (_target, files, onConflict) => {
      const skipped: string[] = [];
      for (const file of files)
        if ((await onConflict(file.path, { overwriteAllowed: true })) === 'skip')
          skipped.push(file.path);
      return { written: [], skipped, backups: [], warnings: [] };
    },
  },
};

const registry: AgentRegistry = {
  list: () => [fakeAdapter],
  get: (id) => (id === fakeAdapter.id ? fakeAdapter : undefined),
};

describe('cli interfaces', () => {
  it('a SecretStore keeps and forgets secrets', async () => {
    const store = memorySecretStore();
    await store.set('session-token', 'abc');
    expect(await store.get('session-token')).toBe('abc');
    await store.delete('session-token');
    expect(await store.get('session-token')).toBeNull();
  });

  it('an adapter is found through the registry and composes its three parts', async () => {
    const adapter = registry.get('claude-code');
    expect(adapter?.displayName).toBe('Claude Code');
    expect((await adapter?.detector.detect())?.installed).toBe(true);
    expect(registry.get('codex')).toBeUndefined();
  });

  it('the restorer asks the conflict resolver about each existing file', async () => {
    const skipAll: ConflictResolver = () => Promise.resolve('skip');
    const report = await fakeAdapter.restorer.restore(
      { kind: 'global' },
      [{ path: 'CLAUDE.md', content: new Uint8Array(), executable: false }],
      skipAll,
    );
    expect(report.skipped).toEqual(['CLAUDE.md']);
  });
});
