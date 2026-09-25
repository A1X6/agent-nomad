import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createClaudeRunningCheck, projectDirName } from '@agentnomad/cli';
import { expect } from 'vitest';

import type { LocalServer } from './local-server.ts';
import { forward, isExecutable, newPc, read, write, type Pc, type RunResult } from './pc.ts';

/** A throwaway account on the throwaway local server; strong enough for the T23 policy. */
const USERNAME = 'e2e-user';
const PASSWORD = 'quartz-lantern-meadow-pilot-58';
const LOGIN = ['--username', USERNAME, '--password-stdin'];
const stdin = `${PASSWORD}\n`;

const HOOK_SCRIPT = '#!/bin/sh\necho ok\n';
const SKILL = '---\nname: deploy\ndescription: Deploy the app\n---\nRun the deploy script.\n';
const REVIEW_SKILL = '---\nname: review\ndescription: Review a change\n---\nRead the diff.\n';
const MEMORY = '# Memory\n- The demo app uses port 5173.\n';
const EDIT = 'Edited on the second PC.\n';

export interface StepContext {
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

/**
 * Where Claude Code itself runs (a developer's PC, never CI), pull --yes leaves
 * `~/.claude.json` alone by design, so its MCP servers are only checked elsewhere.
 */
const claudeRunningHere = await createClaudeRunningCheck()();

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
  if (edited) expect(await read(claude(pc, 'skills', 'review', 'SKILL.md'))).toBe(REVIEW_SKILL);
  if (!claudeRunningHere) {
    const claudeJson = JSON.parse(await read(join(pc.home, '.claude.json'))) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(claudeJson.mcpServers).toEqual({ docs: { command: 'npx', args: ['-y', 'docs-mcp'] } });
  }
  expect(await read(join(pc.project, 'CLAUDE.md'))).toBe('Project rules.\n');
  expect(JSON.parse(await read(join(pc.project, '.mcp.json')))).toEqual({
    mcpServers: { db: { command: 'node', args: ['db.js'] } },
  });
  // Auto memory lands in the folder Claude Code uses for this project path on this PC.
  expect(await read(memoryFile(pc))).toBe(MEMORY);
}

/** Step 1, first OS: a realistic setup is registered, pushed with memory, and up to date. */
export async function firstPc({ server, keychain }: StepContext): Promise<void> {
  const pc = await newPc('first', { apiUrl: server.url, keychain });
  try {
    await write(claude(pc, 'CLAUDE.md'), notes(pc));
    await write(
      claude(pc, 'settings.json'),
      JSON.stringify({
        theme: 'dark',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: hookCommand(pc) }] }] },
      }),
    );
    await write(claude(pc, 'hooks', 'check.sh'), HOOK_SCRIPT, true);
    await write(claude(pc, 'skills', 'deploy', 'SKILL.md'), SKILL);
    await write(
      join(pc.home, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'first@example.com' },
        mcpServers: { docs: { command: 'npx', args: ['-y', 'docs-mcp'] } },
      }),
    );
    await write(join(pc.project, 'CLAUDE.md'), 'Project rules.\n');
    await write(
      join(pc.project, '.mcp.json'),
      JSON.stringify({ mcpServers: { db: { command: 'node', args: ['db.js'] } } }),
    );
    await write(memoryFile(pc), MEMORY);

    ok(await pc.run(['register', ...LOGIN, '--yes'], stdin));

    // No terminal and not enough flags: stops before changing anything, naming the flags.
    const unanswered = await pc.run(['push']);
    expect(unanswered.code).toBe(1);
    expect(unanswered.stderr).toContain('needs an answer, but there is no terminal to ask in');
    expect(unanswered.stderr).toContain('--global or --project <name>');
    expect(await server.count('bundles')).toBe(0);

    const pushed = ok(await pc.run(['push', '--global', '--project', 'demo', '--memory', '--yes']));
    expect(pushed.stdout).toContain('Saved the Claude Code global setup');
    expect(pushed.stdout).toContain('Saved the Claude Code project "demo"');

    const status = ok(await pc.run(['status']));
    expect(status.stdout).toContain('Claude Code global setup: up to date (revision 1)');
    expect(status.stdout).toContain('Claude Code project "demo": up to date (revision 1)');
  } finally {
    await pc.remove();
  }
}

/**
 * Step 2, another OS: a wrong password saves nothing; pull merges into existing files and
 * rewrites every path for this PC; pulling again changes nothing; an edit is pushed back.
 */
export async function secondPc({ server, keychain }: StepContext): Promise<void> {
  const pc = await newPc('second', { apiUrl: server.url, keychain });
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
    const pulled = ok(await pc.run(['pull', '--global', '--project', 'demo', '--merge', '--yes']));
    expect(pulled.stdout).toContain('Restored the Claude Code global setup');
    expect(pulled.stdout).toContain('Restored the Claude Code project "demo"');
    await expectRestored(pc, false);
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

    // Pulling again: nothing to write, nothing backed up.
    const again = ok(await pc.run(['pull', '--global', '--project', 'demo', '--merge', '--yes']));
    expect(again.stdout).toContain('Restored the Claude Code global setup: 0 written');
    expect(again.stdout).toContain('Restored the Claude Code project "demo": 0 written');

    await write(claude(pc, 'CLAUDE.md'), (await read(claude(pc, 'CLAUDE.md'))) + EDIT);
    await write(claude(pc, 'skills', 'review', 'SKILL.md'), REVIEW_SKILL);
    const pushed = ok(await pc.run(['push', '--global', '--yes']));
    expect(pushed.stdout).toContain('(revision 2)');
    const status = ok(await pc.run(['status']));
    expect(status.stdout).toContain('Claude Code global setup: up to date (revision 2)');
  } finally {
    await pc.remove();
  }
}

/**
 * Step 3, back on the first OS: an existing file is overwritten with a backup; the second
 * PC's edit arrives with this PC's paths; a PC out of step cannot overwrite the newer copy;
 * delete and account delete leave nothing on the server.
 */
export async function thirdPc({ server, keychain }: StepContext): Promise<void> {
  const pc = await newPc('third', { apiUrl: server.url, keychain });
  // Never pulled: knows no revision. Its login is kept in its own folder (see pc.ts).
  const stale = await newPc('stale', { apiUrl: server.url, keychain: false });
  try {
    await write(claude(pc, 'CLAUDE.md'), 'Old notes on the third PC.\n');

    ok(await pc.run(['login', ...LOGIN], stdin));
    const status = ok(await pc.run(['status']));
    expect(status.stdout).toContain('never pulled or pushed on this PC');

    const pulled = ok(
      await pc.run(['pull', '--global', '--project', 'demo', '--overwrite', '--yes']),
    );
    expect(pulled.stdout).toContain('backed up first');
    await expectRestored(pc, true);
    const backups = (await readdir(claude(pc))).filter((name) =>
      name.startsWith('CLAUDE.md.agentnomad-backup-'),
    );
    expect(backups).toHaveLength(1);
    expect(await read(claude(pc, backups[0] ?? ''))).toBe('Old notes on the third PC.\n');

    // A PC out of step: --yes never replaces the newer copy.
    await write(claude(stale, 'CLAUDE.md'), 'Stale notes.\n');
    ok(await stale.run(['login', ...LOGIN], stdin));
    const skipped = ok(await stale.run(['push', '--global', '--yes']));
    expect(skipped.stderr).toContain('a newer copy exists. Run `agentnomad pull` first');
    const list = ok(await pc.run(['list']));
    expect(list.stdout).toMatch(/global setup\s+revision 2/);

    // Deleted from another PC: this PC's status then says so.
    const deleted = ok(await stale.run(['delete', '--global', '--yes']));
    expect(deleted.stdout).toContain('Deleted the Claude Code global setup from the server.');
    const afterDelete = ok(await pc.run(['status']));
    expect(afterDelete.stdout).toContain('✓ Claude Code project "demo": up to date (revision 1)');
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
  } finally {
    await Promise.all([pc.remove(), stale.remove()]);
  }
}

export const STEPS = { '1': firstPc, '2': secondPc, '3': thirdPc } as const;
