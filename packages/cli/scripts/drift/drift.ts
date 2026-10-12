/**
 * The weekly Claude Code drift check (T41): compares the Claude Code paths data file (T32)
 * with the newest Claude Code, so a file or folder Claude Code adds is noticed before users
 * miss it. Pure functions; `check-claude-code.ts` fetches the inputs and writes the report.
 *
 * Four sources:
 * - the official ".claude directory" docs page, which names what lives in `~/.claude` and a
 *   project's `.claude`;
 * - the settings reference, whose "Global config" keys are the `~/.claude.json` preferences
 *   push takes (T109);
 * - what a fresh Claude Code creates in an empty config folder (run in CI);
 * - the changelog entries of versions newer than the one the data file was reviewed against,
 *   including any that name a settings key or variable the pull review watches (T55), a
 *   plugin part Claude Code starts programs from (SEC-02 of review 15), or plugins at all: a
 *   new plugin part is in no list yet (ARCH-01 of review 16).
 */
import {
  CLAUDE_CODE_PATHS,
  type ClaudeCodePathsData,
} from '../../src/agents/claude-code/claude-code-paths.data.ts';
import { WATCHED_SETTINGS } from '../../src/agents/claude-code/reviewed-settings.ts';
import { compareVersions } from '../../src/agents/notices.ts';

export interface ChangelogSection {
  readonly version: string;
  /** Only the entries that may change where Claude Code keeps things (see `RELEVANT`). */
  readonly lines: readonly string[];
}

export interface DriftReport {
  readonly latestVersion: string;
  readonly reviewedVersion: string;
  /** Top-level names the docs page mentions that the data file does not know. */
  readonly unknownInDocs: readonly string[];
  /** Top-level names a fresh Claude Code created that the data file does not know. */
  readonly unknownInFreshInstall: readonly string[];
  /** "Global config" keys of the settings reference that the data file does not list. */
  readonly globalConfigMissing: readonly string[];
  /** Keys the data file lists that the settings reference no longer has as "Global config". */
  readonly globalConfigExtra: readonly string[];
  /** Relevant changelog entries of versions after `reviewedVersion`, newest first. */
  readonly changelog: readonly ChangelogSection[];
  readonly hasFindings: boolean;
}

export interface DriftInput {
  readonly paths: ClaudeCodePathsData;
  /** Markdown of https://code.claude.com/docs/en/claude-directory.md */
  readonly directoryDocs: string;
  /** Markdown of https://code.claude.com/docs/en/settings-reference.md */
  readonly settingsReference: string;
  /** Markdown of Claude Code's CHANGELOG.md */
  readonly changelog: string;
  /** The newest Claude Code version on npm. */
  readonly latestVersion: string;
  /** Top-level names in a fresh config folder, or `null` when that step did not run. */
  readonly freshEntries: readonly string[] | null;
}

/**
 * With `CLAUDE_CONFIG_DIR` set (as in the fresh-install run), `.claude.json` lives inside
 * the config folder instead of the home folder; the data file handles it separately.
 */
const CONFIG_DIR_ONLY = ['.claude.json'];

/** First path segment: `skills/synced` → `skills`, `.claude/rules` → `.claude`. */
const firstSegment = (path: string) => path.split('/')[0] ?? path;

/**
 * Every top-level name the data file accounts for, in `~/.claude` or a project's `.claude`:
 * synced, never synced or known state. Anything else is drift.
 */
export function knownTopLevelNames(paths: ClaudeCodePathsData): Set<string> {
  const inProjectClaude = (entry: string) =>
    entry.startsWith('.claude/') ? [firstSegment(entry.slice('.claude/'.length))] : [];
  return new Set([
    ...paths.global.files,
    ...paths.global.folders,
    ...paths.global.memoryFolders,
    ...paths.global.neverSynced.map(firstSegment),
    ...paths.global.knownState.map(firstSegment),
    ...paths.project.claudeFiles,
    ...paths.project.claudeFolders,
    ...paths.project.memoryFolders,
    ...paths.project.knownState.map(firstSegment),
    ...paths.project.neverSynced.flatMap(inProjectClaude),
  ]);
}

/**
 * Top-level names the docs mention under `~/.claude/` or `.claude/`, e.g. `tasks` for
 * `~/.claude/tasks/` and `rules` for `.claude/rules/frontend/react.md`. Placeholders in
 * angle brackets and globs are not names.
 */
export function docsTopLevelNames(markdown: string): string[] {
  const names = new Set<string>();
  for (const match of markdown.matchAll(
    /(?:~\/\.claude|(?<![\w.~/-])\.claude)\/([A-Za-z0-9._-]+)/g,
  )) {
    // A full stop ending the sentence is not part of the name.
    const name = match[1]?.replace(/\.+$/, '');
    if (name) names.add(name);
  }
  return [...names].sort();
}

/** The heading row of the settings reference's index table (T109). */
const INDEX_HEADING = /^\| Key \| Description \| Topic \| Scope \|\s*$/m;

/** A row of that table whose last cell, the scope, is "Global config"; the key is linked. */
const GLOBAL_CONFIG_ROW = /^\| \[`([^`]+)`\]\([^)]*\) \|.*\| Global config \|\s*$/gm;

/**
 * The keys the settings reference's index table gives the scope "Global config": the
 * `~/.claude.json` preferences (T109). `null` when the page has no such table any more.
 */
export function docsGlobalConfigKeys(markdown: string): string[] | null {
  if (!INDEX_HEADING.test(markdown)) return null;
  const keys = new Set<string>();
  for (const match of markdown.matchAll(GLOBAL_CONFIG_ROW)) {
    if (match[1]) keys.add(match[1]);
  }
  return [...keys].sort();
}

/** Changelog entries that add, change, move or remove something about files or setup. */
const KIND =
  /^- (Added|Changed|Moved|Renamed|Removed|New|Now|Deprecated|Replaced|Settings?|Claude Code now)\b/i;
const WHERE =
  /~\/\.claude\b|\.claude\/|\.claude\.json|CLAUDE_CONFIG_DIR|\b(stored|saved|written|moved|kept|lives?) (in|to|under|at)\b|\bnew (file|folder|directory)\b|AGENTS\.md|CLAUDE(\.local)?\.md|\.mcp\.json|keybindings\.json|\.worktreeinclude/i;

/**
 * The settings keys and `env` names the pull review lists (T55), and the plugin parts it asks
 * about (SEC-02 of review 15): an entry that adds or changes one may need a change in
 * `command-review.ts` or `plugin-review.ts`.
 */
const { runsCode } = CLAUDE_CODE_PATHS.plugins;
const WATCHED_NAMES = [
  ...WATCHED_SETTINGS,
  ...runsCode.files,
  ...runsCode.folders,
  ...runsCode.manifestKeys,
];
const WATCHED = new RegExp(
  `(?<![\\w.])(${WATCHED_NAMES.map((key) => key.replaceAll('.', '\\.')).join('|')})(?!\\w)`,
);

/** Plugins and mods, which can gain a part that starts programs under a name not yet watched. */
const PLUGINS = /\b(plugins?|mods?)\b/i;

/** Relevant entries of every version newer than `afterVersion`, newest first. */
export function changelogSince(markdown: string, afterVersion: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  for (const section of markdown.split(/^## /m).slice(1)) {
    const [heading = '', ...body] = section.split(/\r?\n/);
    const version = /^\d+\.\d+\.\d+/.exec(heading.trim())?.[0];
    if (version === undefined || compareVersions(version, afterVersion) <= 0) continue;
    const lines = body.filter(
      (line) => KIND.test(line) && (WHERE.test(line) || WATCHED.test(line) || PLUGINS.test(line)),
    );
    if (lines.length > 0) sections.push({ version, lines });
  }
  return sections.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * A changelog line as it is shown in the issue (T48): text from outside the repository, so an
 * @mention cannot notify anyone and an image (Markdown or HTML: `<` is shown as text) cannot
 * load from elsewhere.
 */
export function inert(line: string): string {
  return line
    .replace(/@(?=[A-Za-z0-9])/g, '@\u200b')
    .replace(/!\[/g, '!\\[')
    .replace(/</g, '&lt;');
}

export function driftReport(input: DriftInput): DriftReport {
  const known = knownTopLevelNames(input.paths);
  const unknownInDocs = docsTopLevelNames(input.directoryDocs).filter((name) => !known.has(name));
  const unknownInFreshInstall = (input.freshEntries ?? [])
    .filter((name) => !known.has(name) && !CONFIG_DIR_ONLY.includes(name))
    .sort();
  const changelog = changelogSince(input.changelog, input.paths.reviewedVersion);
  const documented = docsGlobalConfigKeys(input.settingsReference) ?? [];
  const listed = input.paths.claudeJsonPreferenceKeys;
  const globalConfigMissing = documented.filter((key) => !listed.includes(key));
  const globalConfigExtra = listed.filter((key) => !documented.includes(key)).sort();
  return {
    latestVersion: input.latestVersion,
    reviewedVersion: input.paths.reviewedVersion,
    unknownInDocs,
    unknownInFreshInstall,
    globalConfigMissing,
    globalConfigExtra,
    changelog,
    hasFindings:
      unknownInDocs.length > 0 ||
      unknownInFreshInstall.length > 0 ||
      globalConfigMissing.length > 0 ||
      globalConfigExtra.length > 0 ||
      changelog.length > 0,
  };
}

const bullets = (items: readonly string[]) => items.map((item) => `- \`${item}\``).join('\n');

/**
 * The GitHub issue (or job summary) for a report, in Markdown. It holds no link to the run,
 * so the same findings give the same text and the open issue is only edited when they change.
 */
export function reportMarkdown(report: DriftReport): string {
  const parts = [
    `The paths data file (\`packages/cli/src/agents/claude-code/claude-code-paths.data.ts\`) was reviewed against Claude Code **${report.reviewedVersion}**; the newest is **${report.latestVersion}**.`,
  ];
  if (!report.hasFindings) parts.push('No drift found.');
  if (report.unknownInDocs.length > 0) {
    parts.push(
      '## Named by the docs, unknown to the data file',
      'From [Explore the .claude directory](https://code.claude.com/docs/en/claude-directory):',
      bullets(report.unknownInDocs),
    );
  }
  if (report.unknownInFreshInstall.length > 0) {
    parts.push(
      '## Created by a fresh Claude Code, unknown to the data file',
      bullets(report.unknownInFreshInstall),
    );
  }
  if (report.globalConfigMissing.length > 0) {
    parts.push(
      '## Global config keys unknown to the data file',
      'From [the settings reference](https://code.claude.com/docs/en/settings-reference), scope "Global config" (`~/.claude.json`):',
      bullets(report.globalConfigMissing),
    );
  }
  if (report.globalConfigExtra.length > 0) {
    parts.push(
      '## Global config keys the settings reference no longer lists',
      bullets(report.globalConfigExtra),
    );
  }
  if (report.changelog.length > 0) {
    parts.push(
      '## Changelog entries to review',
      'Entries that may change where Claude Code keeps things ([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)):',
      ...report.changelog.map(
        (section) => `### ${section.version}\n${section.lines.map(inert).join('\n')}`,
      ),
    );
  }
  if (report.hasFindings) {
    parts.push(
      '## To do',
      [
        '- [ ] Sort each unknown name into `neverSynced`, `knownState` or a synced list (never sync credentials, history, caches or machine state).',
        '- [ ] Add each unknown Global config key to `claudeJsonPreferenceKeys` (or remove one the reference dropped) once it is a preference, not account or machine state.',
        '- [ ] Read the changelog entries; add anything that is part of a user setup. For a setting that redirects Claude Code, loosens its permissions or runs a command, update `packages/cli/src/agents/claude-code/reviewed-settings.ts` and the pull review.',
        '- [ ] A new plugin part that starts programs: add it to `plugins.runsCode` in the paths data file and to the plugin review (`packages/cli/src/agents/claude-code/plugin-review.ts`).',
        `- [ ] Set \`reviewedVersion\` to \`${report.latestVersion}\`, run \`pnpm check\`, and close this issue.`,
      ].join('\n'),
    );
  }
  return `${parts.join('\n\n')}\n`;
}
