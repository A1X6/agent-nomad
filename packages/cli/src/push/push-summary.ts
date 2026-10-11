import type { BundleScope } from '@agentnomad/contracts';

import type { AgentAdapter } from '../agents/adapter.ts';
import { CONTENT_GROUPS } from '../cli/help-text.ts';

/** One choice in push's summary: the flag that makes it and what was chosen (T115). */
export interface ChosenContent {
  /** E.g. `--memory`. */
  readonly flag: string;
  /** E.g. `yes`, `no`, or the environment values' names. */
  readonly chosen: string;
}

/** What the summary needs of one planned upload. */
interface SummaryUpload {
  readonly adapter: Pick<AgentAdapter, 'contents'>;
  /** E.g. `Claude Code global setup`. */
  readonly setup: string;
  readonly scope: BundleScope;
  readonly bundle: { readonly files: readonly unknown[] };
  readonly chosen: readonly ChosenContent[];
}

/**
 * What push shows before it asks to upload (T115): per setup, its files, what is always in it
 * and what the user chose, under the group headings of `push --help`.
 */
export function pushSummary(uploads: readonly SummaryUpload[]): string {
  const groups = CONTENT_GROUPS.push;
  return [
    'Ready to save:',
    ...uploads.flatMap(({ adapter, setup, scope, bundle, chosen }) => {
      const { contents } = adapter;
      const always =
        contents === undefined
          ? []
          : scope.kind === 'global'
            ? [...contents.global, ...contents.globalAlso]
            : [...contents.project, ...contents.projectAlso];
      const count = bundle.files.length;
      return [
        `  The ${setup}: ${String(count)} file${count === 1 ? '' : 's'}`,
        ...(always.length > 0 ? [`    ${groups.always}: ${always.join(', ')}`] : []),
        `    ${groups.chosen}: ${chosen.map((choice) => `${choice.flag} ${choice.chosen}`).join('; ')}`,
      ];
    }),
  ].join('\n');
}

/** The one question after the summary; yes is the default. */
export function uploadQuestion(count: number): string {
  return `Upload ${count === 1 ? 'it' : `these ${String(count)} setups`} now? Nothing is saved until you say yes.`;
}
