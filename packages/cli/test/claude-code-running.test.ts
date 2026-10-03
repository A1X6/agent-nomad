import { describe, expect, it } from 'vitest';

import { createClaudeRunningCheck, isClaudeProcess } from '../src/index.ts';

describe('running Claude Code', () => {
  it.each([
    ['claude.exe', true],
    ['/usr/local/bin/claude --resume', true],
    ['/Users/a/.local/bin/claude', true],
    ['node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', true],
    ['"C:\\Users\\a\\.local\\bin\\claude.exe" --continue', true],
    // A folder with a space in its name (BUG-13).
    ['/Users/John Smith/.local/bin/claude --resume', true],
    ['/Users/John Smith/.local/bin/claude', true],
    ['"C:\\Users\\John Smith\\.local\\bin\\claude.exe" --continue', true],
    // npm's Claude Code on Windows, seen by its command line (BUG-08).
    [
      '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
      true,
    ],
    // The Claude app: its Code tab runs Claude Code, which shares ~/.claude.json (BUG-13).
    ['C:\\Users\\a\\AppData\\Local\\AnthropicClaude\\app-1.0.0\\claude.exe', true],
    ['/Applications/Claude.app/Contents/MacOS/Claude', true],
    ['agentnomad pull', false],
    ['claude-helper', false],
    ['/usr/bin/vim claude.md', false],
    ['grep claude notes.txt', false],
    ['/home/a/claude/bin/tool', false],
    ['/home/a/claude-code-notes/run.sh', false],
  ])('%j is Claude Code: %s', (line, expected) => {
    expect(isClaudeProcess(line)).toBe(expected);
  });

  // Seen on Windows 11 (T67) through systemProcessLister, from a real
  // `npm install --prefix <dir> @anthropic-ai/claude-code` (2.1.285) started with `claude.cmd
  // mcp serve`. The npm package now ships the native claude.exe and the .cmd launcher starts it
  // directly; node only runs when postinstall was skipped (cli-wrapper.cjs). The cmd.exe parent
  // need not match: its claude.exe child does.
  it.each([
    '"C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\.bin\\\\..\\@anthropic-ai\\claude-code\\bin\\claude.exe"    mcp serve',
    'C:\\nvm4w\\nodejs\\node.exe C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs mcp serve',
    'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code-win32-x64\\claude.exe mcp serve',
  ])('a real npm install on Windows is Claude Code: %j', (line) => {
    expect(isClaudeProcess(line)).toBe(true);
  });

  it('is detected from the process list, and a list that cannot be read never blocks', async () => {
    expect(
      await createClaudeRunningCheck(() => Promise.resolve(['explorer.exe', 'claude.exe']))(),
    ).toBe(true);
    expect(await createClaudeRunningCheck(() => Promise.resolve(['explorer.exe']))()).toBe(false);
    expect(await createClaudeRunningCheck(() => Promise.resolve(null))()).toBe(false);
  });
});
