/**
 * What happened to one setup in push or pull (T59). `declined`: the user answered a question
 * with no, which is their choice and not a failure. `not-done`: skipped or refused without
 * the user saying so (by `--yes`, a newer or older copy, the size limit, a question that was
 * never asked), which makes the command exit with code 1.
 */
export type SetupOutcome =
  | { readonly setup: string; readonly result: 'done' | 'declined' }
  | { readonly setup: string; readonly result: 'not-done'; readonly reason: string };

/**
 * How messages name a setup: `global setup` or `project "<name>"`, after the agent's display
 * name when one is given (`Claude Code global setup`).
 */
export function setupLabel(displayName: string | null, projectName: string | null): string {
  const what = projectName === null ? 'global setup' : `project "${projectName}"`;
  return displayName === null ? what : `${displayName} ${what}`;
}

/** Some setups were not saved or restored; the others were (BUG-03). Exit code 1. */
export class SetupsNotDoneError extends Error {
  readonly notDone: readonly { readonly setup: string; readonly reason: string }[];

  constructor(
    command: 'push' | 'pull',
    notDone: readonly { readonly setup: string; readonly reason: string }[],
  ) {
    super(
      [
        `Not ${command === 'push' ? 'saved' : 'restored'}:`,
        ...notDone.map((entry) => `  - the ${entry.setup}: ${entry.reason}`),
      ].join('\n'),
    );
    this.name = 'SetupsNotDoneError';
    this.notDone = notDone;
  }
}

/** Ends push or pull: throws one error listing every setup that was not done, if any. */
export function finishSetups(command: 'push' | 'pull', outcomes: readonly SetupOutcome[]): void {
  const notDone = outcomes.flatMap((outcome) =>
    outcome.result === 'not-done' ? [{ setup: outcome.setup, reason: outcome.reason }] : [],
  );
  if (notDone.length > 0) throw new SetupsNotDoneError(command, notDone);
}
