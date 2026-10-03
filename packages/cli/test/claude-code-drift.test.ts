import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  changelogSince,
  docsTopLevelNames,
  driftReport,
  knownTopLevelNames,
  inert,
  reportMarkdown,
} from '../scripts/drift/drift.ts';
import { CLAUDE_CODE_PATHS } from '../src/index.ts';
import { WATCHED_SETTINGS } from '../src/agents/claude-code/reviewed-settings.ts';

/** Every top-level name the ".claude directory" docs page named on 2026-09-26 (Claude Code 2.1.283). */
const DOCS_NAMES_2026_09_26 = [
  'agent-memory',
  'agent-memory-local',
  'backups',
  'cache',
  'CLAUDE.md',
  'debug',
  'feedback',
  'feedback-bundles',
  'file-history',
  'history.jsonl',
  'image-cache',
  'logs',
  'output-styles',
  'paste-cache',
  'plans',
  'plugins',
  'policy-limits.json',
  'projects',
  'remote-settings.json',
  'rules',
  'session-env',
  'settings.json',
  'settings.local.json',
  'shell-snapshots',
  'skills',
  'stats-cache.json',
  'statsig',
  'tasks',
  'todos',
  'uploads',
  'usage-data',
  'workflows',
];

const CHANGELOG = `# Changelog

## 2.1.290

- Added \`~/.claude/prompts/\` for saved prompts
- Fixed a crash when \`~/.claude/settings.json\` was empty

## 2.1.284

- Fixed scrolling in long sessions
- Added a new theme

## 2.1.283

- Added AGENTS.md support
`;

describe('drift check (T41): reading the sources', () => {
  it('finds top-level names under ~/.claude/ and .claude/ in the docs', () => {
    const docs = [
      'Tasks live in `~/.claude/tasks/<session>/`, images in ~/.claude/image-cache.',
      'Project rules: `.claude/rules/frontend/react.md`; your MCP servers are in `~/.claude.json`.',
      'Skills: ~/.claude/skills/<name>/SKILL.md and my.claude/ignored and x.claude/also-ignored',
    ].join('\n');
    expect(docsTopLevelNames(docs)).toEqual(['image-cache', 'rules', 'skills', 'tasks']);
  });

  it('keeps only relevant changelog entries of versions after the reviewed one, newest first', () => {
    expect(changelogSince(CHANGELOG, '2.1.283')).toEqual([
      { version: '2.1.290', lines: ['- Added `~/.claude/prompts/` for saved prompts'] },
    ]);
    expect(changelogSince(CHANGELOG, '2.1.290')).toEqual([]);
    expect(changelogSince(CHANGELOG, '2.1.282').map((section) => section.version)).toEqual([
      '2.1.290',
      '2.1.283',
    ]);
  });
});

describe('drift check (T55): settings the pull review watches', () => {
  it('watches every key and variable the review lists', () => {
    for (const key of [
      'apiKeyHelper',
      'permissions.defaultMode',
      'permissions.allow',
      'permissions.additionalDirectories',
      'sandbox',
      'ANTHROPIC_BASE_URL',
      'HTTPS_PROXY',
      'NODE_EXTRA_CA_CERTS',
      'CLAUDE_CODE_SHELL_PREFIX',
    ]) {
      expect(WATCHED_SETTINGS).toContain(key);
    }
  });

  it('keeps changelog entries that name a watched setting', () => {
    const changelog = [
      '## 2.1.300',
      '',
      '- Added `sandbox.network.allowAll` to open the network',
      '- Changed `ANTHROPIC_BASE_URL` to also apply to MCP tool search',
      '- Added wildcards in `permissions.allow` rules for MCP servers',
      '- Fixed a crash when the sandbox could not start',
      '- Added a new theme',
      '',
    ].join('\n');
    expect(changelogSince(changelog, '2.1.299')).toEqual([
      {
        version: '2.1.300',
        lines: [
          '- Added `sandbox.network.allowAll` to open the network',
          '- Changed `ANTHROPIC_BASE_URL` to also apply to MCP tool search',
          '- Added wildcards in `permissions.allow` rules for MCP servers',
        ],
      },
    ]);
  });
});

describe('drift check (T41): comparing with the data file', () => {
  it('the data file knows every name the docs named on 2026-09-26', () => {
    const known = knownTopLevelNames(CLAUDE_CODE_PATHS);
    expect(DOCS_NAMES_2026_09_26.filter((name) => !known.has(name))).toEqual([]);
  });

  const driftInput = {
    paths: { ...CLAUDE_CODE_PATHS, reviewedVersion: '2.1.283' },
    directoryDocs: 'Settings in `~/.claude/settings.json`, prompts in `~/.claude/prompts/`.',
    changelog: CHANGELOG,
    latestVersion: '2.1.290',
    freshEntries: ['.claude.json', 'backups', 'projects', 'sessions', 'new-state'],
  };

  it('reports unknown docs names, unknown fresh-install entries and new changelog entries', () => {
    const report = driftReport(driftInput);
    expect(report).toMatchObject({
      latestVersion: '2.1.290',
      reviewedVersion: '2.1.283',
      unknownInDocs: ['prompts'],
      unknownInFreshInstall: ['new-state'],
      hasFindings: true,
    });
    expect(report.changelog.map((section) => section.version)).toEqual(['2.1.290']);

    const markdown = reportMarkdown(report);
    expect(markdown).toContain('- `prompts`');
    expect(markdown).toContain('- `new-state`');
    expect(markdown).toContain('### 2.1.290');
    expect(markdown).toContain('Set `reviewedVersion` to `2.1.290`');
  });

  it('writes the same report for the same input, with no link to the run (BUG-02)', async () => {
    // The workflow edits the open issue only when the body differs, so the body must not
    // change from run to run: the run link goes in the issue comment instead.
    expect(reportMarkdown(driftReport(driftInput))).toBe(reportMarkdown(driftReport(driftInput)));
    const script = await readFile(
      new URL('../scripts/drift/check-claude-code.ts', import.meta.url),
      'utf8',
    );
    const workflow = await readFile(
      new URL('../../../.github/workflows/drift-check.yml', import.meta.url),
      'utf8',
    );
    expect(script).not.toContain('RUN_URL');
    expect(workflow).not.toContain('DRIFT_RUN_URL');
  });

  it('finds nothing when the data file is up to date', () => {
    const report = driftReport({
      paths: CLAUDE_CODE_PATHS,
      directoryDocs: DOCS_NAMES_2026_09_26.map((name) => `~/.claude/${name}`).join('\n'),
      changelog: CHANGELOG.replace('2.1.290', CLAUDE_CODE_PATHS.reviewedVersion),
      latestVersion: CLAUDE_CODE_PATHS.reviewedVersion,
      freshEntries: ['.claude.json', 'backups', 'projects', 'sessions'],
    });
    expect(report.hasFindings).toBe(false);
    expect(reportMarkdown(report)).toContain('No drift found.');
  });
});

describe('drift check (T48): changelog text is shown inert', () => {
  it('cannot mention anyone or load an image in the issue', () => {
    const shown = inert('- Fixed @someone and ![x](https://tracker.example/p.png) in ~/.claude');
    expect(shown).not.toMatch(/@[A-Za-z]/);
    expect(shown).not.toContain('![');
    expect(shown).toContain('~/.claude');
  });

  it('shows HTML as text, so an <img> cannot load either (SEC-05)', () => {
    expect(inert('- Logo <img src="https://tracker.example/p.png"> added')).toBe(
      '- Logo &lt;img src="https://tracker.example/p.png"> added',
    );
  });
});
