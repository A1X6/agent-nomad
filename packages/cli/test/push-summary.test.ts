import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE_CONTENTS, pushSummary, uploadQuestion } from '../src/index.ts';

/** One planned upload as the summary sees it. */
const upload = (
  scope: { kind: 'global' } | { kind: 'project'; name: string },
  files: number,
  withContents = true,
) => ({
  adapter: withContents ? { contents: CLAUDE_CODE_CONTENTS } : {},
  setup:
    scope.kind === 'global' ? 'Claude Code global setup' : `Claude Code project "${scope.name}"`,
  scope,
  bundle: { files: Array.from({ length: files }) },
  chosen: [
    { flag: '--memory', chosen: 'no' },
    { flag: '--env-values', chosen: 'GITHUB_TOKEN' },
  ],
});

describe('pushSummary (T115)', () => {
  it('names each setup with its files, what is always in it and what was chosen', () => {
    expect(pushSummary([upload({ kind: 'project', name: 'my-app' }, 1)])).toBe(
      [
        'Ready to save:',
        '  The Claude Code project "my-app": 1 file',
        "    Always saved: CLAUDE.md, CLAUDE.local.md, AGENTS.md, .mcp.json, .worktreeinclude, .claude/ settings and folders, scripts the project's hooks run",
        '    Saved only when you choose (a question, or the flag): --memory no; --env-values GITHUB_TOKEN',
      ].join('\n'),
    );
  });

  it('lists the global setup with what it takes from outside its folder', () => {
    const summary = pushSummary([upload({ kind: 'global' }, 3)]);
    expect(summary).toContain('  The Claude Code global setup: 3 files');
    expect(summary).toContain(
      'your MCP servers and documented preferences in ~/.claude.json, which plugins and marketplaces you use',
    );
  });

  it('leaves out the always-saved line for an agent that does not name its contents', () => {
    expect(pushSummary([upload({ kind: 'global' }, 2, false)])).not.toContain('Always saved');
  });
});

describe('uploadQuestion (T115)', () => {
  it('asks about one setup as "it"', () => {
    expect(uploadQuestion(1)).toBe('Upload it now? Nothing is saved until you say yes.');
  });

  it('asks about several by number', () => {
    expect(uploadQuestion(2)).toBe(
      'Upload these 2 setups now? Nothing is saved until you say yes.',
    );
  });
});
