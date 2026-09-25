/**
 * Runs the Claude Code drift check (T41) and writes the report. From the repository root:
 *
 *   node --experimental-strip-types packages/cli/scripts/drift/check-claude-code.ts
 *
 * Environment (all optional):
 * - DRIFT_LATEST: the newest Claude Code version (else read from the npm registry)
 * - DRIFT_FRESH_ENTRIES: a file listing, one per line, what a fresh Claude Code created
 * - DRIFT_OUT: where to write the Markdown report (else only printed)
 * - DRIFT_RUN_URL: link to the CI run, added to the report
 * - GITHUB_OUTPUT / GITHUB_STEP_SUMMARY: set by GitHub Actions
 *
 * Fails (exit 1) when a source cannot be fetched or no longer looks as expected, so a
 * broken check is noticed instead of quietly finding nothing.
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises';

import { CLAUDE_CODE_PATHS } from '../../src/agents/claude-code/claude-code-paths.data.ts';
import { docsTopLevelNames, driftReport, reportMarkdown } from './drift.ts';

const DOCS_URL = 'https://code.claude.com/docs/en/claude-directory.md';
const CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';
const REGISTRY_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
  return response.text();
}

async function latestVersion(): Promise<string> {
  const given = process.env['DRIFT_LATEST']?.trim();
  if (given) return given;
  const body = JSON.parse(await fetchText(REGISTRY_URL)) as { version?: unknown };
  if (typeof body.version !== 'string') throw new Error(`${REGISTRY_URL}: no version`);
  return body.version;
}

async function freshEntries(): Promise<string[] | null> {
  const file = process.env['DRIFT_FRESH_ENTRIES'];
  if (!file) return null;
  return (await readFile(file, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const [directoryDocs, changelog, latest, fresh] = await Promise.all([
  fetchText(DOCS_URL),
  fetchText(CHANGELOG_URL),
  latestVersion(),
  freshEntries(),
]);

// The page names about 30 entries today; far fewer means its format changed.
if (docsTopLevelNames(directoryDocs).length < 10) {
  throw new Error(`${DOCS_URL} no longer lists the .claude directory as expected`);
}
if (!/^## \d+\.\d+\.\d+/m.test(changelog)) {
  throw new Error(`${CHANGELOG_URL} no longer has "## <version>" sections`);
}

const report = driftReport({
  paths: CLAUDE_CODE_PATHS,
  directoryDocs,
  changelog,
  latestVersion: latest,
  freshEntries: fresh,
});
const markdown = reportMarkdown(report, process.env['DRIFT_RUN_URL']);

console.log(markdown);
const out = process.env['DRIFT_OUT'];
if (out) await writeFile(out, markdown);
const summary = process.env['GITHUB_STEP_SUMMARY'];
if (summary) await appendFile(summary, markdown);
const output = process.env['GITHUB_OUTPUT'];
if (output) {
  await appendFile(
    output,
    `found=${String(report.hasFindings)}\nlatest=${latest}\nfresh_checked=${String(fresh !== null)}\n`,
  );
}
