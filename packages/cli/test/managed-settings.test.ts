import { describe, expect, it } from 'vitest';

import {
  createAgentRegistry,
  createAgentsCommand,
  detectManagedSettings,
  explainPluginFailure,
  globalDestination,
  managedSettingsDir,
  managedSettingsNotice,
  syncPlugins,
  type ManagedSettingsSystem,
} from '../src/index.ts';

interface FakePc {
  platform: NodeJS.Platform;
  env?: Record<string, string>;
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
  registry?: Partial<Record<'HKLM' | 'HKCU', string>>;
}

function fakeSystem(pc: FakePc): ManagedSettingsSystem {
  return {
    platform: pc.platform,
    env: pc.env ?? {},
    baseDir: pc.platform === 'win32' ? 'C:\\Users\\a\\.claude' : '/home/a/.claude',
    readText: (path) => Promise.resolve(pc.files?.[path] ?? null),
    exists: (path) => Promise.resolve(path in (pc.files ?? {})),
    listDir: (path) => Promise.resolve(pc.dirs?.[path] ?? []),
    readRegistry: (hive) => Promise.resolve(pc.registry?.[hive] ?? null),
  };
}

const policy = JSON.stringify({
  strictKnownMarketplaces: [{ source: 'github', repo: 'acme/plugins' }],
  permissions: { deny: ['Read(./.env)'] },
});

describe('finding managed settings', () => {
  it('uses the system folder Claude Code reads on each OS', () => {
    expect(managedSettingsDir('linux', {})).toBe('/etc/claude-code');
    expect(managedSettingsDir('darwin', {})).toBe('/Library/Application Support/ClaudeCode');
    expect(managedSettingsDir('win32', { ProgramFiles: 'D:\\Programs' })).toBe(
      'D:\\Programs\\ClaudeCode',
    );
  });

  it('Linux: the managed file, drop-ins and managed MCP servers', async () => {
    const found = await detectManagedSettings(
      fakeSystem({
        platform: 'linux',
        files: {
          '/etc/claude-code/managed-settings.json': policy,
          '/etc/claude-code/managed-settings.d/20-mcp.json': JSON.stringify({
            deniedMcpServers: [{ serverName: 'x' }],
          }),
          '/etc/claude-code/managed-mcp.json': '{}',
        },
        dirs: {
          '/etc/claude-code/managed-settings.d': ['20-mcp.json', '.hidden.json', 'notes.txt'],
        },
      }),
    );
    expect(found).toEqual({
      sources: [
        { kind: 'file', where: '/etc/claude-code/managed-settings.json' },
        { kind: 'drop-ins', where: '/etc/claude-code/managed-settings.d' },
        { kind: 'mcp', where: '/etc/claude-code/managed-mcp.json' },
      ],
      keys: ['deniedMcpServers', 'managedMcpServers', 'permissions', 'strictKnownMarketplaces'],
      restrictsPlugins: true,
      restrictsMcpServers: true,
    });
  });

  it('macOS: an MDM profile is found by its file', async () => {
    const found = await detectManagedSettings(
      fakeSystem({
        platform: 'darwin',
        files: { '/Library/Managed Preferences/com.anthropic.claudecode.plist': 'bplist' },
      }),
    );
    expect(found.sources).toEqual([
      { kind: 'plist', where: '/Library/Managed Preferences/com.anthropic.claudecode.plist' },
    ]);
  });

  it('Windows: the file and both registry keys', async () => {
    const found = await detectManagedSettings(
      fakeSystem({
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files' },
        files: { 'C:\\Program Files\\ClaudeCode\\managed-settings.json': '{"model":"opus"}' },
        registry: { HKLM: JSON.stringify({ blockedMarketplaces: [] }), HKCU: '{"theme":"dark"}' },
      }),
    );
    expect(found.sources.map((source) => source.kind)).toEqual(['file', 'hklm', 'hkcu']);
    expect(found.restrictsPlugins).toBe(true);
    expect(found.restrictsMcpServers).toBe(false);
  });

  it('nothing on a normal PC', async () => {
    const found = await detectManagedSettings(fakeSystem({ platform: 'linux' }));
    expect(found).toEqual({
      sources: [],
      keys: [],
      restrictsPlugins: false,
      restrictsMcpServers: false,
    });
    expect(managedSettingsNotice(found, 'push')).toBeNull();
  });
});

describe('server-managed settings (claude.ai admin console)', () => {
  it('are found through the copy Claude Code caches', async () => {
    const found = await detectManagedSettings(
      fakeSystem({
        platform: 'linux',
        files: {
          '/home/a/.claude/remote-settings.json': JSON.stringify({
            blockedMarketplaces: [{ source: 'github', repo: 'x/y' }],
          }),
        },
      }),
    );
    expect(found.sources).toEqual([
      { kind: 'remote', where: '/home/a/.claude/remote-settings.json' },
    ]);
    expect(found.restrictsPlugins).toBe(true);
    expect(managedSettingsNotice(found, 'pull')).toContain('(the claude.ai admin console)');
  });

  it('an empty cache means none are set', async () => {
    const found = await detectManagedSettings(
      fakeSystem({ platform: 'linux', files: { '/home/a/.claude/remote-settings.json': '{}' } }),
    );
    expect(found.sources).toEqual([]);
  });

  it('the cache is never synced', () => {
    expect(globalDestination('remote-settings.json')).toEqual({
      kind: 'refused',
      reason: 'never synced',
    });
  });
});

describe('warnings (T31 done-when)', () => {
  const found = {
    sources: [{ kind: 'file' as const, where: '/etc/claude-code/managed-settings.json' }],
    keys: ['allowedMcpServers', 'strictKnownMarketplaces'],
    restrictsPlugins: true,
    restrictsMcpServers: true,
  };

  it('push says they stay with this PC', () => {
    expect(managedSettingsNotice(found, 'push')).toBe(
      'Your organization manages some Claude Code settings on this PC (/etc/claude-code/managed-settings.json). They stay with this PC and are not saved with your setup. They limit which plugins can be installed and which MCP servers can run, so some items may be blocked here.',
    );
  });

  it('pull says they take priority', () => {
    expect(managedSettingsNotice(found, 'pull')).toContain(
      'They take priority over what you pull.',
    );
  });

  it('agentnomad agents shows the notice', async () => {
    const lines: string[] = [];
    await createAgentsCommand({
      registry: () => createAgentRegistry([]),
      reporter: { info: () => undefined, success: () => undefined, warn: (m) => lines.push(m) },
      notices: () => Promise.resolve([managedSettingsNotice(found, 'agents') ?? '']),
    }).agents();
    expect(lines[0]).toContain('never synced');
  });

  it('a plugin blocked by policy gets a clear reason', async () => {
    const result = await syncPlugins({
      manifest: {
        marketplaces: [],
        plugins: [{ id: 'tool@evil-market', scope: 'user', commandSource: false }],
        skipped: [],
      },
      current: { marketplaces: new Set(['evil-market']), installed: new Set() },
      claude: {
        run: () =>
          Promise.resolve({
            exitCode: 1,
            stdout: JSON.stringify({
              outcome: 'failed',
              message: 'Marketplace evil-market is blocked by strictKnownMarketplaces',
            }),
            stderr: '',
          }),
      },
      prompter: { confirm: () => Promise.resolve(true) },
      reporter: { info: () => undefined, success: () => undefined, warn: () => undefined },
      cwd: '/',
      explainFailure: (reason) => explainPluginFailure(reason, found),
    });
    expect(result.failed[0]?.reason).toBe(
      "blocked by your organization's Claude Code policy (/etc/claude-code/managed-settings.json). Ask your admin to allow it. Details: Marketplace evil-market is blocked by strictKnownMarketplaces",
    );
  });

  it('other failures keep their own reason', () => {
    expect(explainPluginFailure('Repository not found', found)).toBe('Repository not found');
  });
});
