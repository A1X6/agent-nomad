import { describe, expect, it } from 'vitest';

import {
  fakeManagedSystem as fakeSystem,
  fileManagedSettings,
  noManagedSettings,
  remoteSettingsFile,
} from './claude-code-plugin-fixtures.ts';
import { claudeCodeAdapter } from './claude-code-project-fixtures.ts';
import { recordingReporter } from './fakes.ts';
import {
  createAgentRegistry,
  createAgentsCommand,
  detectManagedSettings,
  explainPluginFailure,
  managedSettingsDir,
  managedSettingsNotice,
  parseRegSettings,
} from '../src/index.ts';

const policy = JSON.stringify({
  strictKnownMarketplaces: [{ source: 'github', repo: 'acme/plugins' }],
  permissions: { deny: ['Read(./.env)'] },
});

describe('finding managed settings', () => {
  it('uses the system folder Claude Code reads on each OS', () => {
    expect(managedSettingsDir('linux', {})).toBe('/etc/claude-code');
    expect(managedSettingsDir('darwin', {})).toBe('/Library/Application Support/ClaudeCode');
    // Without ProgramFiles in the environment, the usual folder (review 17 QA-09).
    expect(managedSettingsDir('win32', {})).toBe('C:\\Program Files\\ClaudeCode');
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

describe('the Settings value in reg query output (QA-07)', () => {
  /** What 'reg query <hive>\SOFTWARE\Policies\ClaudeCode /v Settings' prints. */
  const regOutput = (line: string) =>
    ['', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode', line, '', ''].join('\r\n');

  it.each([
    ['a REG_SZ value', '    Settings    REG_SZ    {"model":"opus"}', '{"model":"opus"}'],
    [
      'REG_EXPAND_SZ',
      '    Settings    REG_EXPAND_SZ    {"env":{"A":"%HOME%"}}',
      '{"env":{"A":"%HOME%"}}',
    ],
    [
      'a value with spaces',
      '    Settings    REG_SZ    { "permissions": { "deny": ["Bash(rm -rf)"] } }',
      '{ "permissions": { "deny": ["Bash(rm -rf)"] } }',
    ],
  ])('reads %s', (_, line, value) => {
    expect(parseRegSettings(regOutput(line))).toBe(value);
  });

  it('answers null when there is no text value, so no source without keys is listed', () => {
    expect(parseRegSettings(regOutput('    Settings    REG_MULTI_SZ    a\\0b'))).toBeNull();
    expect(parseRegSettings(regOutput('    Other    REG_SZ    {}'))).toBeNull();
    expect(parseRegSettings('')).toBeNull();
  });
});

describe('server-managed settings (claude.ai admin console)', () => {
  /** Settings from the admin console that block a marketplace, in Claude Code's cached copy. */
  const blockingMarketplace = () =>
    detectManagedSettings(
      fakeSystem({
        platform: 'linux',
        files: {
          [remoteSettingsFile('linux')]: JSON.stringify({
            blockedMarketplaces: [{ source: 'github', repo: 'x/y' }],
          }),
        },
      }),
    );

  it('are found through the copy Claude Code caches', async () => {
    const found = await blockingMarketplace();
    expect(found.sources).toEqual([{ kind: 'remote', where: remoteSettingsFile('linux') }]);
    expect(found.restrictsPlugins).toBe(true);
    expect(managedSettingsNotice(found, 'pull')).toContain('(the claude.ai admin console)');
  });

  it('a plugin they block names the admin console, not the cached file (UX-03)', async () => {
    const found = await blockingMarketplace();
    expect(explainPluginFailure('Marketplace y is blocked', found)).toBe(
      "blocked by your organization's Claude Code policy (the claude.ai admin console). Ask your admin to allow it. Details: Marketplace y is blocked",
    );
  });

  // A policy word names the policy whatever is set here; a generic word only when one is
  // (review 16 UX-03; as a table, review 17 QA-09).
  const network = 'connect ECONNREFUSED: request blocked by firewall';
  const notAllowed = 'install not allowed';
  const policyWord = 'strictKnownMarketplaces forbids it';
  const managed = (reason: string) =>
    `blocked by your organization's Claude Code policy (/etc/claude-code/managed-settings.json). Ask your admin to allow it. Details: ${reason}`;
  it.each([
    ['a generic word, nothing managed', network, null, network],
    ['a generic word, an empty cache', network, noManagedSettings, network],
    ['"not allowed", nothing managed', notAllowed, null, notAllowed],
    ['a generic word, managed', network, fileManagedSettings, managed(network)],
    ['"not allowed", managed', notAllowed, fileManagedSettings, managed(notAllowed)],
    [
      'a policy word, nothing managed',
      policyWord,
      null,
      `blocked by your organization's Claude Code policy. Ask your admin to allow it. Details: ${policyWord}`,
    ],
  ])('explains a failure: %s', (_case, reason, found, expected) => {
    expect(explainPluginFailure(reason, found)).toBe(expected);
  });

  it('a generic word with the admin console cache names the console (review 16 UX-03)', async () => {
    expect(explainPluginFailure(network, await blockingMarketplace())).toBe(
      `blocked by your organization's Claude Code policy (the claude.ai admin console). Ask your admin to allow it. Details: ${network}`,
    );
  });

  it('an empty cache means none are set', async () => {
    const found = await detectManagedSettings(
      fakeSystem({ platform: 'linux', files: { [remoteSettingsFile('linux')]: '{}' } }),
    );
    expect(found.sources).toEqual([]);
  });
});

describe('warnings (T31 done-when)', () => {
  const found = fileManagedSettings;

  it('push says they stay with this PC', () => {
    expect(managedSettingsNotice(found, 'push')).toBe(
      'Your organization manages some Claude Code settings on this PC (/etc/claude-code/managed-settings.json). They stay with this PC and are not saved with your setup. They limit which plugins can be installed and which MCP servers can run, so some items may be blocked here.',
    );
  });

  it.each([
    [
      'plugins only',
      { ...found, keys: ['strictKnownMarketplaces'], restrictsMcpServers: false },
      'They limit which plugins can be installed, so some items may be blocked here.',
    ],
    [
      'MCP servers only',
      { ...found, keys: ['allowedMcpServers'], restrictsPlugins: false },
      'They limit which MCP servers can run, so some items may be blocked here.',
    ],
  ])('names only the limit that is set: %s (review 17 QA-09)', (_case, settings, limit) => {
    expect(managedSettingsNotice(settings, 'push')).toContain(limit);
    expect(managedSettingsNotice(settings, 'push')).not.toContain(' and which ');
  });

  it('pull says they take priority', () => {
    expect(managedSettingsNotice(found, 'pull')).toContain(
      'They take priority over what you pull.',
    );
  });

  it('agentnomad agents shows the notice, from the adapter’s inspector (SOLID-01)', async () => {
    const { reporter, lines: reported } = recordingReporter();
    const adapter = claudeCodeAdapter('/nowhere', {
      platform: 'linux',
      managedSystem: fakeSystem({
        platform: 'linux',
        files: { '/etc/claude-code/managed-settings.json': policy },
      }),
    });
    await createAgentsCommand({
      registry: () => createAgentRegistry([adapter]),
      reporter,
    }).agents();
    const lines = reported.filter((line) => line.startsWith('warn: '));
    expect(lines[0]).toContain('never synced');
    expect(managedSettingsNotice(found, 'agents')).toContain('never synced');
  });

  it('other failures keep their own reason', () => {
    expect(explainPluginFailure('Repository not found', found)).toBe('Repository not found');
  });
});
