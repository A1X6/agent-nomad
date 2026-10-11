import type { AgentRestorePlan, ConflictChoice } from '../agents/adapter.ts';
import { CONTENT_GROUPS, ENV_VALUES_NONE } from '../cli/help-text.ts';

/** What the summary needs of one planned restore. */
interface SummaryRestore {
  /** E.g. `Claude Code global setup`. */
  readonly name: string;
  readonly files: readonly unknown[];
  readonly conflicts: ReadonlyMap<string, ConflictChoice>;
  readonly env: { readonly toAdd: readonly string[] } | null;
  /** The user declined commands it holds, so they are left out. */
  readonly declined: boolean;
  /** The agent's own answers (UX-01): what it left out, its choices and the files it writes. */
  readonly agentPlan?: Pick<AgentRestorePlan, 'declined' | 'summary'>;
}

/** `merge 2, skip 1`: how many files here that differ get each answer. */
function answers(conflicts: ReadonlyMap<string, ConflictChoice>): string {
  const counts = new Map<ConflictChoice, number>();
  for (const answer of conflicts.values()) counts.set(answer, (counts.get(answer) ?? 0) + 1);
  return [...counts].map(([answer, count]) => `${answer} ${String(count)}`).join(', ');
}

/**
 * What pull shows before it asks to write (T115): per setup, its files, what happens to the
 * ones here that differ, and what the user chose, under the group headings of `pull --help`.
 * The agent's plan gives the file count it writes and its own choices (UX-01).
 */
export function pullSummary(restores: readonly SummaryRestore[]): string {
  const groups = CONTENT_GROUPS.pull;
  return [
    'Ready to restore:',
    ...restores.flatMap(({ name, files, conflicts, env, declined, agentPlan }) => {
      const count = agentPlan?.summary?.files ?? files.length;
      const differ =
        conflicts.size === 0
          ? ''
          : `; ${String(conflicts.size)} differ here (${answers(conflicts)})`;
      const chosen = [
        `--env-values ${env === null || env.toAdd.length === 0 ? ENV_VALUES_NONE : env.toAdd.join(', ')}`,
        ...(declined || agentPlan?.declined === true
          ? ['--allow-commands no (what runs programs is left out)']
          : []),
        ...(agentPlan?.summary?.chosen ?? []),
      ];
      return [
        `  The ${name}: ${String(count)} file${count === 1 ? '' : 's'}`,
        `    ${groups.always}${differ}`,
        `    ${groups.chosen}: ${chosen.join('; ')}`,
      ];
    }),
  ].join('\n');
}

/** The one question after the summary; yes is the default. */
export function restoreQuestion(count: number): string {
  return `Restore ${count === 1 ? 'it' : `these ${String(count)} setups`} now? Nothing is written until you say yes.`;
}
