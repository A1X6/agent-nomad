import { readdir } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';

import {
  createClaudeRunningCheck,
  projectDirName,
  readBlock,
  shellProfileFor,
  systemProcessLister,
} from '@agentnomad/cli';
import { expect } from 'vitest';

import { FAKE_CLAUDE, MOD_HOOKS, MOD_MODULE, writeLocalMarketplace, writeMod } from './fixtures.ts';
import { expectNoLeaks, secretsOf, type Known } from './leaks.ts';
import type { LocalServer } from './local-server.ts';
import { forward, isExecutable, newPc, read, write, type Pc, type RunResult } from './pc.ts';

/** A throwaway account on the throwaway local server; strong enough for the T23 policy. */
const USER = { username: 'e2e-user', password: 'quartz-lantern-meadow-pilot-58' };
/** The plugin gate's own account (T104), so its skipped plugins never reach USER's revisions. */
const GATE_USER = { username: 'e2e-gate', password: USER.password };
const LOGIN = ['--username', USER.username, '--password-stdin'];
const stdin = `${USER.password}\n`;

const HOOK_SCRIPT = '#!/bin/sh\necho ok\n';
const SKILL = '---\nname: deploy\ndescription: Deploy the app\n---\nRun the deploy script.\n';
const REVIEW_SKILL = '---\nname: review\ndescription: Review a change\n---\nRead the diff.\n';
const MEMORY = '# Memory\n- The demo app uses port 5173.\n';
const EDIT = 'Edited on the second PC.\n';
/** Scripts kept with the other line endings (T56): restore fixes them once, then leaves them. */
const PY_CRLF = 'print("ok")\r\nprint("done")\r\n';
const CMD_LF = '@echo off\necho ok\n';
/** A saved environment value (T56), used by the project's MCP server. */
const ENV_NAME = 'AGENTNOMAD_E2E_TOKEN';
const ENV_VALUE = 'e2e-token-value-5b1d';
/**
 * Windows PCs already have the value set, so pull never writes the real user's environment
 * variables; elsewhere it goes into the shell profile in the PC's own home folder.
 */
const PRESET_ENV: Readonly<Record<string, string>> =
  process.platform === 'win32' ? { [ENV_NAME]: ENV_VALUE } : {};
/**
 * A mod in `~/.claude/skills/` (T97): it loads as `probe-mod@skills-dir` and runs code inside
 * Claude Code. Claude Code 2.1.296's validate passes it; `types/` is what Claude Code
 * generates when it reloads the mod, and never leaves the PC.
 */
const MOD_MANIFEST = JSON.stringify({ name: 'probe-mod' });
const MOD_TYPES = 'declare const generatedByClaudeCode: true;\n';
const mod = (pc: Pc, ...parts: string[]) => claude(pc, 'skills', 'probe-mod', ...parts);
/** A marketplace plugin installed on the first PC, at an older version than pull gets. */
const PLUGIN_ID = 'e2e-plugin@e2e-market';
const PLUGIN_VERSION = '9.8.7-e2e';
/** A skill from the user's claude.ai account, as Claude Code syncs it (T42). */
const ACCOUNT_SKILL =
  '---\nname: my-account-skill\ndescription: From claude.ai\n---\nWrite release notes.\n';
/** The manifest of a plugin the user uploaded to claude.ai, as Claude Code syncs it (T101). */
const ACCOUNT_PLUGIN = '{"name":"my-account-plugin","version":"1.0.0"}';
/** A claude.ai account folder as Claude Code 2.1.296 names it: `<org-uuid>_<account-uuid>`. */
const ACCOUNT_DIR = '44444444-4444-4444-8444-444444444444_55555555-5555-4555-8555-555555555555';
/**
 * A marketplace added from a folder in home (T98), outside git, with the mod `lm-mod`
 * installed from it; and plugin folders `env.CLAUDE_CODE_PLUGIN_DIRS` names (T99), one in home
 * and one outside it. Pushed on one OS and pulled on another (T104): the folders land in the
 * same place from home (the one outside home in `~/.agentnomad/plugin-dirs/`), and the value
 * names them with the pulling OS's separator.
 */
const LOCAL_MARKET = 'e2e-local';
const LOCAL_MOD_ID = `lm-mod@${LOCAL_MARKET}`;
const localMarket = (pc: Pc) => join(pc.home, 'markets', LOCAL_MARKET);
const PLUGIN_DIRS = 'CLAUDE_CODE_PLUGIN_DIRS';
/** Where the plugin folders are on the first PC, and where pull writes them. */
const pluginDirsFirst = (pc: Pc) => [
  join(pc.home, 'dev', 'pd-home'),
  join(dirname(pc.home), 'pd-outside'),
];
const pluginDirsPulled = (pc: Pc) => [
  join(pc.home, 'dev', 'pd-home'),
  join(pc.home, '.agentnomad', 'plugin-dirs', 'pd-outside'),
];

interface StepContext {
  readonly server: LocalServer;
  /** false when several PCs share this machine (see NO_KEYCHAIN in pc.ts). */
  readonly keychain: boolean;
}

const posix = process.platform !== 'win32';
const claude = (pc: Pc, ...parts: string[]) => join(pc.home, '.claude', ...parts);
const memoryFile = (pc: Pc) =>
  claude(pc, 'projects', projectDirName(pc.project), 'memory', 'MEMORY.md');
const hookCommand = (pc: Pc) => `${forward(pc.home)}/.claude/hooks/check.sh`;
const notes = (pc: Pc) => `Notes live in ${pc.home}/notes.\n`;
const MCP_JSON = {
  mcpServers: { db: { command: 'node', args: ['db.js'], env: { TOKEN: `\${${ENV_NAME}}` } } },
};

/**
 * T109: the project's part of `~/.claude.json`, a local-scope MCP server and an approved
 * `.mcp.json` server, in the project folder's entry. Its trust choice is never synced.
 */
const PROJECT_CLAUDE_JSON = {
  mcpServers: { notes: { type: 'stdio', command: 'node', args: ['notes-mcp.js'] } },
  enabledMcpjsonServers: ['db'],
};

/** The key of `pc`'s project in `~/.claude.json`, as Claude Code writes it on this OS. */
const projectKey = (pc: Pc) => (posix ? pc.project : forward(pc.project));

/**
 * Where Claude Code itself runs (a developer's PC, never CI), pull --yes leaves
 * `~/.claude.json` alone by design, so its MCP servers are only checked elsewhere.
 */
const claudeRunningHere = await createClaudeRunningCheck(
  systemProcessLister({ platform: process.platform, env: process.env }),
)();

/**
 * T38: nothing readable left the PC: no file contents, commands, memory, project name or
 * login state in `~/.claude.json` of the steps is in any request (see {@link expectNoLeaks}).
 */
function expectNothingReadable(server: LocalServer, secrets: Known): void {
  expectNoLeaks(server, secrets, [
    'Notes live in',
    'Deploy the app',
    'Run the deploy script',
    'Read the diff',
    'uses port 5173',
    'Project rules.',
    'docs-mcp',
    'db.js',
    'notes-mcp.js',
    'check.sh',
    'echo ok',
    EDIT.trim(),
    'Old notes on the third PC',
    'Write release notes.',
    'my-account-plugin',
    'e2e-mod-seen',
    'generatedByClaudeCode',
    // What the stale PC uploads in step 3 (QA-07).
    'Stale notes',
    'Stale project',
    'stale-only',
    'first@example.com',
    'second@example.com',
    'demo',
    ENV_VALUE,
    PLUGIN_ID,
    PLUGIN_VERSION,
    LOCAL_MOD_ID,
    'pd-outside',
  ]);
}

/** Exit 0, or a failure that shows what the CLI printed. */
function ok(result: RunResult): RunResult {
  expect(result, `${result.stdout}\n${result.stderr}`).toMatchObject({ code: 0 });
  return result;
}

function settingsOf(json: string): { theme?: string; model?: string; hook?: string } {
  const parsed = JSON.parse(json) as {
    theme?: string;
    model?: string;
    hooks?: { Stop?: { hooks?: { command?: string }[] }[] };
  };
  return {
    ...(parsed.theme !== undefined && { theme: parsed.theme }),
    ...(parsed.model !== undefined && { model: parsed.model }),
    ...(parsed.hooks?.Stop?.[0]?.hooks?.[0]?.command !== undefined && {
      hook: parsed.hooks.Stop[0].hooks[0].command,
    }),
  };
}

/**
 * What the first PC saved, as it must look on `pc`: home paths are this PC's, the hook
 * script is LF and runnable, and preferences merged into `~/.claude.json` keep its login.
 */
async function expectRestored(pc: Pc, edited: boolean): Promise<void> {
  expect(forward(await read(claude(pc, 'CLAUDE.md')))).toBe(
    forward(notes(pc)) + (edited ? EDIT : ''),
  );
  expect(settingsOf(await read(claude(pc, 'settings.json')))).toMatchObject({
    theme: 'dark',
    hook: hookCommand(pc),
  });
  expect(await read(claude(pc, 'hooks', 'check.sh'))).toBe(HOOK_SCRIPT);
  if (posix) expect(await isExecutable(claude(pc, 'hooks', 'check.sh'))).toBe(true);
  expect(await read(claude(pc, 'skills', 'deploy', 'SKILL.md'))).toBe(SKILL);
  // A .py always gets LF; a .cmd gets CRLF on Windows and keeps what it came with elsewhere.
  expect(await read(claude(pc, 'skills', 'deploy', 'tool.py'))).toBe(PY_CRLF.replace(/\r/g, ''));
  const cmd = await read(claude(pc, 'skills', 'deploy', 'run.cmd'));
  expect(cmd.replace(/\r/g, '')).toBe(CMD_LF);
  if (!posix) expect(cmd).toBe(CMD_LF.replace(/\n/g, '\r\n'));
  if (edited) expect(await read(claude(pc, 'skills', 'review', 'SKILL.md'))).toBe(REVIEW_SKILL);
  // The mod (T97), without what Claude Code generates in it.
  expect(await read(mod(pc, '.claude-plugin', 'plugin.json'))).toBe(MOD_MANIFEST);
  expect(await read(mod(pc, 'hooks', 'hooks.json'))).toBe(MOD_HOOKS);
  expect(await read(mod(pc, 'hooks', 'register.ts'))).toBe(MOD_MODULE);
  await expect(read(mod(pc, '.claude-plugin', 'types', 'register.d.ts'))).rejects.toThrow();
  if (!claudeRunningHere) {
    const claudeJson = JSON.parse(await read(join(pc.home, '.claude.json'))) as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, unknown>;
    };
    expect(claudeJson.mcpServers).toEqual({ docs: { command: 'npx', args: ['-y', 'docs-mcp'] } });
    // In this PC's entry for the folder pull ran in, keyed as Claude Code does here (T109).
    expect(claudeJson.projects?.[projectKey(pc)]).toEqual(PROJECT_CLAUDE_JSON);
  }
  expect(await read(join(pc.project, 'CLAUDE.md'))).toBe('Project rules.\n');
  expect(JSON.parse(await read(join(pc.project, '.mcp.json')))).toEqual(MCP_JSON);
  // Auto memory lands in the folder Claude Code uses for this project path on this PC.
  expect(await read(memoryFile(pc))).toBe(MEMORY);
  // The saved environment value: in the shell profile, or already set on Windows.
  if (posix) {
    const profile = shellProfileFor(process.env['SHELL'], pc.home, process.platform);
    expect(readBlock(await read(profile.path), profile.kind).get(ENV_NAME)).toBe(ENV_VALUE);
  }
}

/**
 * T104: the local marketplace and the plugin folders, pushed from another OS, are on `pc`:
 * reviewed before they were written (`said`, what pull printed), each mod's module there,
 * Claude Code told to add the marketplace from the folder pull wrote and to install its mod,
 * and the value in the settings naming the folders pull wrote, joined with this OS's separator.
 */
async function expectPluginFoldersRestored(pc: Pc, said: string): Promise<void> {
  expect(said).toContain(`+ ${LOCAL_MOD_ID} (${join(localMarket(pc), 'lm-mod')})`);
  expect(said).toContain(`+ pd-home@inline (${join(pc.home, 'dev', 'pd-home')})`);
  expect(said).toContain('+ pd-outside@inline');
  expect(await read(join(localMarket(pc), 'lm-mod', 'hooks', 'register.ts'))).toBe(MOD_MODULE);
  for (const dir of pluginDirsPulled(pc)) {
    expect(await read(join(dir, 'hooks', 'register.ts'))).toBe(MOD_MODULE);
  }
  const known = JSON.parse(await read(claude(pc, 'plugins', 'known_marketplaces.json'))) as Record<
    string,
    { source: { path?: string } }
  >;
  expect(known[LOCAL_MARKET]?.source.path).toBe(localMarket(pc));
  const installed = JSON.parse(await read(claude(pc, 'plugins', 'installed_plugins.json'))) as {
    plugins: Record<string, unknown>;
  };
  expect(Object.keys(installed.plugins)).toContain(LOCAL_MOD_ID);
  const settings = JSON.parse(await read(claude(pc, 'settings.json'))) as {
    env?: Record<string, string>;
  };
  // A value saved on this OS keeps its slashes as the home path is restored (`C:/…` on
  // Windows, which Claude Code reads too); the separator is always this OS's.
  expect(forward(settings.env?.[PLUGIN_DIRS] ?? '')).toBe(
    forward(pluginDirsPulled(pc).join(delimiter)),
  );
}

/** Every file and folder of the PC (home and project), to see that nothing was added. */
async function filesOf(pc: Pc): Promise<string[]> {
  const list = async (dir: string) =>
    (await readdir(dir, { recursive: true })).map((name) => join(dir, name));
  return [...(await list(pc.home)), ...(await list(pc.project))].sort();
}

/**
 * QA-04 (T56): pulling the same revisions again asks nothing (no --yes, and no terminal to
 * ask in), writes nothing and leaves no new file, not even a backup of the shell profile.
 */
async function expectSecondPullChangesNothing(pc: Pc, conflict: '--merge' | '--overwrite') {
  const before = await filesOf(pc);
  const profile = posix
    ? await read(shellProfileFor(process.env['SHELL'], pc.home, process.platform).path)
    : '';
  const again = ok(
    await pc.run([
      'pull',
      '--global',
      '--project',
      'demo',
      conflict,
      '--allow-commands',
      '--account-skills',
      '--account-plugins',
      // Only where Claude Code runs (never CI): its "close Claude Code" question needs --yes.
      ...(claudeRunningHere ? ['--yes'] : []),
    ]),
  );
  expect(again.stdout).toContain('Restored the Claude Code global setup: 0 written');
  expect(again.stdout).toContain('Restored the Claude Code project "demo": 0 written');
  expect(again.stdout).toContain('The saved environment variables are already set here.');
  expect(again.stdout).not.toContain('backed up first');
  expect(await filesOf(pc)).toEqual(before);
  if (posix) {
    expect(await read(shellProfileFor(process.env['SHELL'], pc.home, process.platform).path)).toBe(
      profile,
    );
  }
}

/** Step 1, first OS: a realistic setup is registered, pushed with memory, and up to date. */
async function firstPc({ server, keychain }: StepContext): Promise<void> {
  const pc = await newPc('first', {
    apiUrl: server.url,
    keychain,
    env: { [ENV_NAME]: ENV_VALUE },
  });
  try {
    await write(claude(pc, 'CLAUDE.md'), notes(pc));
    await write(claude(pc, 'skills', 'deploy', 'tool.py'), PY_CRLF);
    await write(claude(pc, 'skills', 'deploy', 'run.cmd'), CMD_LF);
    await write(
      claude(pc, 'settings.json'),
      JSON.stringify({
        theme: 'dark',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: hookCommand(pc) }] }] },
        env: { [PLUGIN_DIRS]: pluginDirsFirst(pc).join(delimiter) },
      }),
    );
    // T104: the plugin folders that value names, and the local marketplace with its mod.
    for (const dir of pluginDirsFirst(pc)) await writeMod(dir, basename(dir));
    await writeLocalMarketplace(localMarket(pc), LOCAL_MARKET);
    await write(claude(pc, 'hooks', 'check.sh'), HOOK_SCRIPT, true);
    await write(claude(pc, 'skills', 'deploy', 'SKILL.md'), SKILL);
    await writeMod(mod(pc), 'probe-mod');
    await write(mod(pc, '.claude-plugin', 'types', 'register.d.ts'), MOD_TYPES);
    await write(
      join(pc.home, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'first@example.com' },
        mcpServers: { docs: { command: 'npx', args: ['-y', 'docs-mcp'] } },
        projects: {
          [projectKey(pc)]: { ...PROJECT_CLAUDE_JSON, hasTrustDialogAccepted: true },
        },
      }),
    );
    await write(join(pc.project, 'CLAUDE.md'), 'Project rules.\n');
    await write(join(pc.project, '.mcp.json'), JSON.stringify(MCP_JSON));
    await write(memoryFile(pc), MEMORY);
    // Skills Claude Code 2.1.295 and 2.1.296 sync from claude.ai (T42, T105): no creatorType; the
    // user's own upload, one of Anthropic's and one of an organization's plugins.
    const synced = (...parts: string[]) => claude(pc, 'skills', 'synced', ACCOUNT_DIR, ...parts);
    const syncedPlugins = (file: string) =>
      claude(pc, 'plugins', 'synced', ACCOUNT_DIR, ...file.split('/'));
    await write(
      synced('manifest.json'),
      JSON.stringify({
        skills: [
          { name: 'my-account-skill', source: 'plugin', backingPluginId: 'plugin_mine' },
          { name: 'pdf', source: 'anthropic' },
          { name: 'team-skill', source: 'plugin', backingPluginId: 'plugin_team' },
        ],
      }),
    );
    // The plugins in the shapes of the Claude Code 2.1.296 program (T106).
    await write(
      syncedPlugins('manifest.json'),
      JSON.stringify({
        lastUpdated: 1760000000000,
        plugins: [
          { pluginId: 'plugin_mine', marketplaceName: 'my-uploads' },
          { pluginId: 'plugin_team', marketplaceName: 'team-org' },
          // T101: the user's uploaded plugin, and a plugin the organization shares.
          {
            pluginId: 'plugin_upload',
            name: 'my-account-plugin',
            marketplaceName: 'my-uploads',
            installationPreference: 'available',
            generation: 2,
          },
          {
            pluginId: 'plugin_org',
            name: 'team-plugin',
            marketplaceName: 'team-org',
            installationPreference: 'available',
          },
        ],
      }),
    );
    await write(
      syncedPlugins('.marketplaces.json'),
      JSON.stringify({
        parserVersion: 1,
        rows: [
          {
            name: 'my-uploads',
            display_name: 'My Uploads',
            scope: 'account',
            source: { source: 'claudeai' },
            id: 'mkt_mine',
            updated_at: '2026-10-09T00:00:00Z',
          },
          {
            name: 'team-org',
            display_name: 'Team',
            scope: 'org',
            source: { source: 'claudeai' },
            id: 'mkt_team',
            updated_at: '2026-10-09T00:00:00Z',
          },
        ],
      }),
    );
    await write(synced('my-account-skill', 'SKILL.md'), ACCOUNT_SKILL);
    await write(synced('pdf', 'SKILL.md'), '---\nname: pdf\n---\nAnthropic.\n');
    await write(synced('team-skill', 'SKILL.md'), '---\nname: team-skill\n---\nTeam.\n');
    await write(syncedPlugins('my-account-plugin~g2/.claude-plugin/plugin.json'), ACCOUNT_PLUGIN);
    await write(syncedPlugins('team-plugin/.claude-plugin/plugin.json'), '{"name":"team-plugin"}');
    // A plugin from a GitHub marketplace (T29), with its version (T100), and the mod from the
    // local marketplace (T98), whose version Claude Code does not know.
    await write(
      claude(pc, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          [PLUGIN_ID]: [{ scope: 'user', installPath: 'x', version: PLUGIN_VERSION }],
          [LOCAL_MOD_ID]: [{ scope: 'user', installPath: 'x', version: 'unknown' }],
        },
      }),
    );
    await write(
      claude(pc, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({
        'e2e-market': { source: { source: 'github', repo: 'e2e-owner/e2e-market' } },
        [LOCAL_MARKET]: { source: { source: 'directory', path: localMarket(pc) } },
      }),
    );

    ok(await pc.run(['register', ...LOGIN, '--yes'], stdin));
    const secretsHere = await secretsOf(USER, pc);

    // No terminal and not enough flags: stops before changing anything, naming the flags.
    const unanswered = await pc.run(['push']);
    expect(unanswered.code).toBe(1);
    expect(unanswered.stderr).toContain('needs an answer, but there is no terminal to ask in');
    expect(unanswered.stderr).toContain('--global or --project <name>');
    expect(await server.count('bundles')).toBe(0);

    const pushed = ok(
      await pc.run([
        'push',
        '--global',
        '--project',
        'demo',
        '--memory',
        '--account-skills',
        '--account-plugins',
        '--yes',
      ]),
    );
    expect(pushed.stdout).toContain('Saved the Claude Code global setup');
    expect(pushed.stdout).toContain('Plugins in skills/: probe-mod@skills-dir (runs code)');
    expect(pushed.stdout).toContain('Saved the Claude Code project "demo"');
    // T49: a normal setup gets no false "not saved" warning (its hook script is saved).
    expect(pushed.stderr).not.toContain('left out, because agentnomad does not know');
    // T105: the organization's skill is named as left out.
    expect(pushed.stderr).toContain(
      `Not saved from claude.ai account ${ACCOUNT_DIR}: team-skill (it comes from your organization or claude.ai, not from you).`,
    );
    // T101: so is the organization's plugin; only the uploaded one is saved.
    expect(pushed.stderr).toContain(
      `Plugins not saved from claude.ai account ${ACCOUNT_DIR}: team-plugin (it comes from your organization or claude.ai, not from you).`,
    );

    const status = ok(await pc.run(['status']));
    expect(status.stdout).toContain('Claude Code global setup: up to date (revision 1)');
    expect(status.stdout).toContain('Claude Code project "demo": up to date (revision 1)');

    // The uploads really were recorded: encrypted bundles went up.
    const uploads = server.requests.filter((request) => request.method === 'PUT');
    expect(uploads.length).toBe(2);
    expect(uploads.every((request) => request.body.byteLength > 0)).toBe(true);

    // The project again, now with its environment value saved (T56), chosen by the flag
    // that answers push's question (T115): revision 2.
    const withValue = ok(
      await pc.run(['push', '--project', 'demo', '--memory', '--env-values', ENV_NAME]),
    );
    expect(withValue.stdout).toContain('Saved the Claude Code project "demo"');
    expect(withValue.stdout).toContain('(revision 2)');
    expectNothingReadable(server, secretsHere);
  } finally {
    await pc.remove();
  }
}

/**
 * Step 2, another OS: a wrong password saves nothing; pull merges into existing files and
 * rewrites every path for this PC; pulling again changes nothing; an edit is pushed back.
 */
async function secondPc({ server, keychain }: StepContext): Promise<void> {
  const pc = await newPc('second', {
    apiUrl: server.url,
    keychain,
    env: PRESET_ENV,
    claude: FAKE_CLAUDE,
  });
  try {
    // This PC already has its own settings and Claude Code login state.
    await write(claude(pc, 'settings.json'), JSON.stringify({ theme: 'light', model: 'opus' }));
    await write(
      join(pc.home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'second@example.com' }, numStartups: 3 }),
    );

    const wrong = await pc.run(['login', ...LOGIN], 'not-the-password-at-all\n');
    expect(wrong.code).toBe(1);
    expect(wrong.stderr.toLowerCase()).toContain('wrong username or password');
    const notLoggedIn = await pc.run(['list']);
    expect(notLoggedIn.code).toBe(1);
    expect(notLoggedIn.stderr).toContain('agentnomad login');

    ok(await pc.run(['login', ...LOGIN], stdin));
    const secretsHere = await secretsOf(USER, pc);
    const pulled = ok(
      await pc.run([
        'pull',
        '--global',
        '--project',
        'demo',
        '--merge',
        '--yes',
        '--allow-commands',
        '--account-skills',
        '--account-plugins',
        // The saved value, by the flag that answers pull's question (T115).
        '--env-values',
        ENV_NAME,
      ]),
    );
    expect(pulled.stdout).toContain('Restored the Claude Code global setup');
    expect(pulled.stdout).toContain('Restored the Claude Code project "demo"');
    // The mod was reviewed before it was written (T97), and types/ never came along.
    expect(pulled.stdout).toContain('+ probe-mod@skills-dir (skills/probe-mod)');
    expect(`${pulled.stdout}${pulled.stderr}`).not.toContain('types/register.d.ts');
    await expectRestored(pc, false);
    await expectPluginFoldersRestored(pc, `${pulled.stdout}\n${pulled.stderr}`);
    // T100: Claude Code installs only the latest plugin version, so pull names the change.
    expect(pulled.stdout).toContain(`Reinstalled ${PLUGIN_ID}, ${LOCAL_MOD_ID}.`);
    expect(pulled.stdout).toContain(`  ${PLUGIN_ID}  was ${PLUGIN_VERSION}, now 9.9.0`);
    // T42: the user's own claude.ai skill is a local skill here; Anthropic's and the
    // organization's never came along.
    expect(await read(claude(pc, 'skills', 'my-account-skill', 'SKILL.md'))).toBe(ACCOUNT_SKILL);
    await expect(read(claude(pc, 'skills', 'pdf', 'SKILL.md'))).rejects.toThrow();
    await expect(read(claude(pc, 'skills', 'team-skill', 'SKILL.md'))).rejects.toThrow();
    await expect(
      read(claude(pc, 'skills', 'synced', ACCOUNT_DIR, 'manifest.json')),
    ).rejects.toThrow();
    // T101: the uploaded claude.ai plugin is a local plugin here, reviewed first; the
    // organization's never left the first PC.
    expect(pulled.stdout).toContain('+ my-account-plugin@skills-dir (skills/my-account-plugin)');
    expect(
      await read(claude(pc, 'skills', 'my-account-plugin', '.claude-plugin', 'plugin.json')),
    ).toBe(ACCOUNT_PLUGIN);
    await expect(
      read(claude(pc, 'skills', 'team-plugin', '.claude-plugin', 'plugin.json')),
    ).rejects.toThrow();
    // --merge: incoming keys win, this PC's other keys stay.
    expect(settingsOf(await read(claude(pc, 'settings.json')))).toMatchObject({ model: 'opus' });
    const claudeJson = JSON.parse(await read(join(pc.home, '.claude.json'))) as Record<
      string,
      unknown
    >;
    expect(claudeJson).toMatchObject({
      ...(!claudeRunningHere && {
        mcpServers: { docs: { command: 'npx', args: ['-y', 'docs-mcp'] } },
      }),
      oauthAccount: { emailAddress: 'second@example.com' },
      numStartups: 3,
    });

    // Pulling again: nothing to ask, nothing to write, nothing backed up.
    await expectSecondPullChangesNothing(pc, '--merge');

    await write(claude(pc, 'CLAUDE.md'), (await read(claude(pc, 'CLAUDE.md'))) + EDIT);
    await write(claude(pc, 'skills', 'review', 'SKILL.md'), REVIEW_SKILL);
    const pushed = ok(await pc.run(['push', '--global', '--yes']));
    expect(pushed.stdout).toContain('(revision 2)');
    expect(pushed.stderr).not.toContain('left out, because agentnomad does not know');
    const status = ok(await pc.run(['status']));
    expect(status.stdout).toContain('Claude Code global setup: up to date (revision 2)');
    expectNothingReadable(server, secretsHere);
  } finally {
    await pc.remove();
  }
}

/**
 * Step 3, back on the first OS: an existing file is overwritten with a backup; the second
 * PC's edit arrives with this PC's paths; a PC out of step cannot overwrite the newer copy;
 * delete and account delete leave nothing on the server.
 */
async function thirdPc({ server, keychain }: StepContext): Promise<void> {
  const pc = await newPc('third', {
    apiUrl: server.url,
    keychain,
    env: PRESET_ENV,
    claude: FAKE_CLAUDE,
  });
  // Never pulled: knows no revision. Its login is kept in its own folder (see pc.ts).
  const stale = await newPc('stale', { apiUrl: server.url, keychain: false });
  try {
    await write(claude(pc, 'CLAUDE.md'), 'Old notes on the third PC.\n');

    ok(await pc.run(['login', ...LOGIN], stdin));
    const status = ok(await pc.run(['status']));
    expect(status.stdout).toContain('never pulled or pushed on this PC');

    const pulled = ok(
      await pc.run([
        'pull',
        '--global',
        '--project',
        'demo',
        '--overwrite',
        '--yes',
        '--allow-commands',
      ]),
    );
    expect(pulled.stdout).toContain('backed up first');
    await expectRestored(pc, true);
    await expectPluginFoldersRestored(pc, `${pulled.stdout}\n${pulled.stderr}`);
    // The second PC saved the plugin at 9.9.0, the version installed here: no change named.
    expect(pulled.stdout).toContain(`Reinstalled ${PLUGIN_ID}, ${LOCAL_MOD_ID}.`);
    expect(pulled.stdout).not.toContain(' was ');
    const backups = (await readdir(claude(pc))).filter((name) =>
      name.startsWith('CLAUDE.md.agentnomad-backup-'),
    );
    expect(backups).toHaveLength(1);
    expect(await read(claude(pc, backups[0] ?? ''))).toBe('Old notes on the third PC.\n');
    await expectSecondPullChangesNothing(pc, '--overwrite');

    // A PC out of step: --yes never replaces the newer copy, and a script sees exit code 1
    // (BUG-03), while the setup that could be saved still is.
    await write(claude(stale, 'CLAUDE.md'), 'Stale notes.\n');
    await write(join(stale.project, 'CLAUDE.md'), 'Stale project.\n');
    ok(await stale.run(['login', ...LOGIN], stdin));
    const secretsHere = await secretsOf(USER, pc, stale);
    const skipped = await stale.run(['push', '--global', '--project', 'stale-only', '--yes']);
    expect(skipped.code, `${skipped.stdout}\n${skipped.stderr}`).toBe(1);
    expect(skipped.stderr).toContain('a newer copy exists. Run `agentnomad pull` first');
    expect(skipped.stderr).toContain('Not saved:');
    expect(skipped.stderr).toContain('- the Claude Code global setup: a newer copy exists');
    expect(skipped.stdout).toContain('Saved the Claude Code project "stale-only"');
    const list = ok(await pc.run(['list']));
    expect(list.stdout).toMatch(/global setup\s+revision 2/);

    // Deleted from another PC: this PC's status then says so.
    const deleted = ok(await stale.run(['delete', '--global', '--yes']));
    expect(deleted.stdout).toContain('Deleted the Claude Code global setup from the server.');
    const afterDelete = ok(await pc.run(['status']));
    expect(afterDelete.stdout).toContain('✓ Claude Code project "demo": up to date (revision 2)');
    expect(afterDelete.stdout).toContain(
      'A Claude Code setup this PC had was deleted on the server.',
    );

    const refused = await pc.run(['account', 'delete', ...LOGIN], stdin);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Add --yes to confirm deleting the account.');
    ok(await pc.run(['account', 'delete', ...LOGIN, '--yes'], stdin));
    for (const table of ['users', 'sessions', 'bundles', 'bundle_blobs'] as const) {
      expect(await server.count(table), table).toBe(0);
    }
    expectNothingReadable(server, secretsHere);
  } finally {
    await Promise.all([pc.remove(), stale.remove()]);
  }
}

/**
 * T104: pull's review of plugins (T97) through the `claude plugin validate` of the PC, on a
 * setup of its own account, so its skipped plugins never reach the main account's revisions.
 * A plugin without hooks, a mod and a mod whose manifest does not parse, in `skills/`.
 */
const GATE_LOGIN = ['--username', GATE_USER.username, '--password-stdin'];
type GatePlugin = 'gate-broken' | 'gate-mod' | 'gate-plain';
/** What the gate's setup holds that must never leave a PC readable (QA-07). */
const GATE_READABLE = ['Read the diff', 'e2e-mod-seen', 'gate-plain', 'gate-mod', 'gate-broken'];
const gatePlugin = (pc: Pc, name: GatePlugin, ...parts: string[]) =>
  claude(pc, 'skills', name, ...parts);

/** Step 1, after the first PC: the gate's setup is pushed from this OS. */
async function gateFirstPc({ server }: StepContext): Promise<void> {
  const pc = await newPc('gate-first', { apiUrl: server.url, keychain: false });
  try {
    await write(
      gatePlugin(pc, 'gate-plain', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'gate-plain', author: { name: 'e2e' } }),
    );
    await write(gatePlugin(pc, 'gate-plain', 'skills', 'notes', 'SKILL.md'), REVIEW_SKILL);
    await writeMod(claude(pc, 'skills', 'gate-mod'), 'gate-mod');
    await writeMod(claude(pc, 'skills', 'gate-broken'), 'gate-broken');
    await write(gatePlugin(pc, 'gate-broken', '.claude-plugin', 'plugin.json'), '{"name": "gate');
    ok(await pc.run(['register', ...GATE_LOGIN, '--yes'], stdin));
    const secretsHere = await secretsOf(GATE_USER, pc);
    const pushed = ok(await pc.run(['push', '--global', '--yes']));
    expect(pushed.stdout).toContain(
      'Plugins in skills/: gate-broken@skills-dir (runs code), gate-mod@skills-dir (runs code), gate-plain@skills-dir',
    );
    expectNoLeaks(server, secretsHere, GATE_READABLE);
  } finally {
    await pc.remove();
  }
}

/**
 * Step 2, after the second PC: the gate's three ways on another OS. `--yes` writes the plugin
 * without code and skips the mod (it needs a yes) and the broken one; `--allow-commands` then
 * writes the mod, never the broken one. The gate's account is deleted after.
 */
async function gateSecondPc({ server }: StepContext): Promise<void> {
  const pc = await newPc('gate-second', {
    apiUrl: server.url,
    keychain: false,
    claude: FAKE_CLAUDE,
  });
  try {
    ok(await pc.run(['login', ...GATE_LOGIN], stdin));
    const secretsHere = await secretsOf(GATE_USER, pc);
    const yes = ok(await pc.run(['pull', '--global', '--yes']));
    const said = `${yes.stdout}\n${yes.stderr}`;
    expect(said).toContain('+ gate-plain@skills-dir (skills/gate-plain)');
    expect(said).toContain(
      'Skipped skills/gate-mod: gate-mod@skills-dir runs code inside Claude Code. --yes never accepts a plugin with code; add --allow-commands to accept it.',
    );
    expect(said).toContain('claude plugin validate: failed, the plugin is broken');
    expect(said).toContain('✘ json: Invalid JSON syntax:');
    expect(said).toContain(
      'Skipped skills/gate-broken: gate-broken@skills-dir is broken, and only a yes from you writes it. Run pull without --yes to choose.',
    );
    expect(await read(gatePlugin(pc, 'gate-plain', 'skills', 'notes', 'SKILL.md'))).toBe(
      REVIEW_SKILL,
    );
    for (const name of ['gate-mod', 'gate-broken'] as const) {
      await expect(read(gatePlugin(pc, name, 'hooks', 'register.ts'))).rejects.toThrow();
    }

    const allowed = ok(await pc.run(['pull', '--global', '--yes', '--allow-commands']));
    expect(allowed.stdout).toContain('./register.ts calls: $.store.get');
    expect(`${allowed.stdout}\n${allowed.stderr}`).toContain('Skipped skills/gate-broken');
    expect(await read(gatePlugin(pc, 'gate-mod', 'hooks', 'register.ts'))).toBe(MOD_MODULE);
    await expect(read(gatePlugin(pc, 'gate-broken', 'hooks', 'register.ts'))).rejects.toThrow();

    ok(await pc.run(['account', 'delete', ...GATE_LOGIN, '--yes'], stdin));
    expectNoLeaks(server, secretsHere, GATE_READABLE);
  } finally {
    await pc.remove();
  }
}

export const STEPS = {
  '1': async (context: StepContext) => {
    await firstPc(context);
    await gateFirstPc(context);
  },
  '2': async (context: StepContext) => {
    await secondPc(context);
    await gateSecondPc(context);
  },
  '3': thirdPc,
} as const;
