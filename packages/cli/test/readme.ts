import { readFileSync } from 'node:fs';

/**
 * The repository README, read by the tests that keep it and the program's own words the same
 * (T115): the Commands and Flags tables and the "What is synced" table.
 */
const README = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

/**
 * The README's text under the heading `heading` (e.g. `## Commands`), up to the next one. A
 * `# …` line inside a fenced code block (a shell comment) is not a heading.
 */
export function readmeSection(heading: string): string {
  const lines = README.split(/\r?\n/);
  const start = lines.indexOf(heading);
  if (start === -1) throw new Error(`README has no heading "${heading}"`);
  let fenced = false;
  const end = lines.findIndex((line, index) => {
    if (index <= start) return false;
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    return !fenced && /^#{1,6} /.test(line);
  });
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

/**
 * The body rows of the first Markdown table in `section`, as trimmed cells without `` ` ``
 * (a `\|` inside a cell is a plain `|`). The table ends at its first line not starting with
 * `|`, so a later table in the same section is not read.
 */
export function tableRows(section: string): string[][] {
  const lines = section.split('\n');
  const first = lines.findIndex((line) => line.startsWith('|'));
  if (first === -1) return [];
  const after = lines.findIndex((line, index) => index > first && !line.startsWith('|'));
  const rows = lines.slice(first, after === -1 ? undefined : after).map((line) =>
    line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((cell) => cell.replaceAll('\\|', '|').replaceAll('`', '').trim()),
  );
  // The header row and the `---` row under it.
  return rows.slice(2);
}
