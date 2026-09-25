import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import * as z from 'zod';

/**
 * Settings an organization enforces on this PC (T31). They belong to the PC, not the user:
 * never synced, only detected so push and pull can say they exist and what they may block.
 * Server-managed settings (from the claude.ai console) are fetched by Claude Code and are
 * not visible on disk, so they cannot be detected here.
 */

export type ManagedSourceKind = 'file' | 'drop-ins' | 'mcp' | 'plist' | 'hklm' | 'hkcu';

export interface ManagedSource {
  readonly kind: ManagedSourceKind;
  /** Where it is, for the message, e.g. `/etc/claude-code/managed-settings.json`. */
  readonly where: string;
}

export interface ManagedSettings {
  readonly sources: readonly ManagedSource[];
  /** Top-level keys the readable sources set (values are never shown). */
  readonly keys: readonly string[];
  /** Limits which marketplaces and plugins can be installed. */
  readonly restrictsPlugins: boolean;
  /** Limits which MCP servers can run. */
  readonly restrictsMcpServers: boolean;
}

/** Reading the PC, injected so every OS can be tested anywhere. */
export interface ManagedSettingsSystem {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readText(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<readonly string[]>;
  /** The `Settings` value under `<hive>\SOFTWARE\Policies\ClaudeCode`, or `null`. */
  readRegistry(hive: 'HKLM' | 'HKCU'): Promise<string | null>;
}

const PLUGIN_KEYS = ['strictKnownMarketplaces', 'blockedMarketplaces'];
const MCP_KEYS = [
  'allowedMcpServers',
  'deniedMcpServers',
  'allowManagedMcpServersOnly',
  'managedMcpServers',
];

/** The system folder Claude Code reads managed files from. */
export function managedSettingsDir(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform === 'win32') {
    return win32.join(
      env['ProgramFiles'] ?? env['PROGRAMFILES'] ?? 'C:\\Program Files',
      'ClaudeCode',
    );
  }
  return platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code';
}

function keysOf(text: string | null): string[] {
  if (text === null) return [];
  try {
    const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(text));
    return parsed.success ? Object.keys(parsed.data) : [];
  } catch {
    return [];
  }
}

/** Finds every managed settings source on this PC and which policy keys they set. */
export async function detectManagedSettings(
  system: ManagedSettingsSystem,
): Promise<ManagedSettings> {
  const path = system.platform === 'win32' ? win32 : posix;
  const dir = managedSettingsDir(system.platform, system.env);
  const sources: ManagedSource[] = [];
  const keys = new Set<string>();
  const add = (kind: ManagedSourceKind, where: string, text: string | null) => {
    sources.push({ kind, where });
    for (const key of keysOf(text)) keys.add(key);
  };

  const settingsFile = path.join(dir, 'managed-settings.json');
  const settings = await system.readText(settingsFile);
  if (settings !== null) add('file', settingsFile, settings);

  const dropIns = path.join(dir, 'managed-settings.d');
  const dropInFiles = (await system.listDir(dropIns))
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .sort();
  if (dropInFiles.length > 0) {
    sources.push({ kind: 'drop-ins', where: dropIns });
    for (const name of dropInFiles) {
      for (const key of keysOf(await system.readText(path.join(dropIns, name)))) keys.add(key);
    }
  }

  const mcpFile = path.join(dir, 'managed-mcp.json');
  if (await system.exists(mcpFile)) {
    sources.push({ kind: 'mcp', where: mcpFile });
    keys.add('managedMcpServers');
  }

  if (system.platform === 'darwin') {
    // MDM profiles land here; the contents are a binary plist, so only presence is reported.
    const plist = '/Library/Managed Preferences/com.anthropic.claudecode.plist';
    if (await system.exists(plist)) sources.push({ kind: 'plist', where: plist });
  }

  if (system.platform === 'win32') {
    for (const hive of ['HKLM', 'HKCU'] as const) {
      const value = await system.readRegistry(hive);
      if (value !== null)
        add(hive === 'HKLM' ? 'hklm' : 'hkcu', `${hive}\\SOFTWARE\\Policies\\ClaudeCode`, value);
    }
  }

  const sorted = [...keys].sort();
  return {
    sources,
    keys: sorted,
    restrictsPlugins: sorted.some((key) => PLUGIN_KEYS.includes(key)),
    restrictsMcpServers: sorted.some((key) => MCP_KEYS.includes(key)),
  };
}

/** What push and pull say when this PC has managed settings; `null` when it has none. */
export function managedSettingsNotice(
  found: ManagedSettings,
  command: 'push' | 'pull' | 'agents',
): string | null {
  if (found.sources.length === 0) return null;
  const where = found.sources.map((source) => source.where).join(', ');
  const limits = [
    ...(found.restrictsPlugins ? ['which plugins can be installed'] : []),
    ...(found.restrictsMcpServers ? ['which MCP servers can run'] : []),
  ];
  const lines = [
    `Your organization manages some Claude Code settings on this PC (${where}).`,
    command === 'push'
      ? 'They stay with this PC and are not saved with your setup.'
      : command === 'pull'
        ? 'They take priority over what you pull.'
        : 'They take priority over your own settings and are never synced.',
  ];
  if (limits.length > 0)
    lines.push(`They limit ${limits.join(' and ')}, so some items may be blocked here.`);
  return lines.join(' ');
}

/** Words Claude Code uses when a plugin install is refused by policy. */
const POLICY_WORDS =
  /\b(policy|policies|blocked|not allowed|strictKnownMarketplaces|blockedMarketplaces|managed settings)\b/i;

/** A clearer reason for a failed plugin install when the organization's policy blocked it. */
export function explainPluginFailure(reason: string, found: ManagedSettings | null): string {
  if (!POLICY_WORDS.test(reason)) return reason;
  const where =
    found && found.sources.length > 0
      ? ` (${found.sources.map((source) => source.where).join(', ')})`
      : '';
  return `blocked by your organization's Claude Code policy${where}. Ask your admin to allow it. Details: ${reason}`;
}

/** The real PC. */
export function nodeManagedSettingsSystem(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): ManagedSettingsSystem {
  return {
    platform,
    env,
    async readText(file) {
      try {
        return await readFile(file, 'utf8');
      } catch {
        return null;
      }
    },
    async exists(file) {
      return (await stat(file).catch(() => null)) !== null;
    },
    async listDir(dir) {
      return readdir(dir).catch(() => []);
    },
    readRegistry(hive) {
      return new Promise((done) => {
        execFile(
          'reg',
          ['query', `${hive}\\SOFTWARE\\Policies\\ClaudeCode`, '/v', 'Settings'],
          { windowsHide: true, encoding: 'utf8', timeout: 10_000 },
          (error, stdout) => {
            if (error) {
              done(null);
              return;
            }
            // "    Settings    REG_SZ    {...}"
            done(/Settings\s+REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(stdout)?.[1]?.trim() ?? '');
          },
        );
      });
    },
  };
}
