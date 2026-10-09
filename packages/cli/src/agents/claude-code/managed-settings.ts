import { readdir, readFile, stat } from 'node:fs/promises';
import { win32 } from 'node:path';

import { JsonObjectSchema, parseJsonWith, valueOrNull } from '../../system/json.ts';
import { runProgram } from '../../system/run-program.ts';
import { pathsOf } from '../shared/detector-system.ts';

/**
 * Settings an organization enforces on this PC (T31). They belong to the PC, not the user:
 * never synced, only detected so push and pull can say they exist and what they may block.
 * Server-managed settings (from the claude.ai console) are seen through the copy Claude Code
 * caches in `<base>/remote-settings.json`; before Claude Code's first start after the admin
 * set them, only `claude doctor` can tell.
 */

type ManagedSourceKind = 'remote' | 'file' | 'drop-ins' | 'mcp' | 'plist' | 'hklm' | 'hkcu';

interface ManagedSource {
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
  /** Claude Code's base folder (`~/.claude` or `CLAUDE_CONFIG_DIR`), for the remote cache. */
  readonly baseDir: string;
  readText(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<readonly string[]>;
  /** The `Settings` value under `<hive>\SOFTWARE\Policies\ClaudeCode`, or `null`. */
  readRegistry(hive: 'HKLM' | 'HKCU'): Promise<string | null>;
}

/** Where Claude Code caches server-managed settings, inside its base folder. */
const REMOTE_SETTINGS_FILE = 'remote-settings.json';

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
  return Object.keys(valueOrNull(parseJsonWith(JsonObjectSchema, text)) ?? {});
}

/** Finds every managed settings source on this PC and which policy keys they set. */
export async function detectManagedSettings(
  system: ManagedSettingsSystem,
): Promise<ManagedSettings> {
  const path = pathsOf(system.platform);
  const dir = managedSettingsDir(system.platform, system.env);
  const sources: ManagedSource[] = [];
  const keys = new Set<string>();
  const add = (kind: ManagedSourceKind, where: string, text: string | null) => {
    sources.push({ kind, where });
    for (const key of keysOf(text)) keys.add(key);
  };

  // Server-managed settings from the claude.ai console, as Claude Code last cached them.
  const remoteFile = path.join(system.baseDir, REMOTE_SETTINGS_FILE);
  const remote = await system.readText(remoteFile);
  if (remote !== null && keysOf(remote).length > 0) add('remote', remoteFile, remote);

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

/**
 * Where the settings come from, for a message: the admin console for server-managed ones,
 * not the cache file the user cannot edit (UX-03), and the path for the rest.
 */
const sourcesText = (found: ManagedSettings) =>
  found.sources
    .map((source) => (source.kind === 'remote' ? 'the claude.ai admin console' : source.where))
    .join(', ');

/** What push and pull say when this PC has managed settings; `null` when it has none. */
export function managedSettingsNotice(
  found: ManagedSettings,
  command: 'push' | 'pull' | 'agents',
): string | null {
  if (found.sources.length === 0) return null;
  const where = sourcesText(found);
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

/** Words that name the organization's policy itself. */
const POLICY_WORDS =
  /\b(policy|policies|strictKnownMarketplaces|blockedMarketplaces|managed settings)\b/i;
/**
 * Words a network or server failure can hold too: they mean the policy only when one is set
 * here (review 16 UX-03).
 */
const BLOCKED_WORDS = /\b(blocked|not allowed)\b/i;

/** A clearer reason for a failed plugin install when the organization's policy blocked it. */
export function explainPluginFailure(reason: string, found: ManagedSettings | null): string {
  const managed = found !== null && found.sources.length > 0;
  if (!POLICY_WORDS.test(reason) && !(managed && BLOCKED_WORDS.test(reason))) return reason;
  const where = managed ? ` (${sourcesText(found)})` : '';
  return `blocked by your organization's Claude Code policy${where}. Ask your admin to allow it. Details: ${reason}`;
}

/** The real PC. */
export function nodeManagedSettingsSystem(
  env: Readonly<Record<string, string | undefined>>,
  baseDir: string,
  platform: NodeJS.Platform = process.platform,
): ManagedSettingsSystem {
  return {
    platform,
    env,
    baseDir,
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
    async readRegistry(hive) {
      const { stdout, error } = await runProgram(
        'reg',
        ['query', `${hive}\\SOFTWARE\\Policies\\ClaudeCode`, '/v', 'Settings'],
        { timeoutMs: 10_000 },
      );
      return error ? null : parseRegSettings(stdout);
    },
  };
}

/**
 * The `Settings` value in `reg query` output, or `null` when there is no text value
 * (`REG_SZ` or `REG_EXPAND_SZ`), e.g. a `REG_MULTI_SZ`: nothing to read keys from.
 */
export function parseRegSettings(stdout: string): string | null {
  // "    Settings    REG_SZ    {...}"
  return /Settings\s+REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(stdout)?.[1]?.trim() ?? null;
}
