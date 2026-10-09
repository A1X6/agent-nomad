import type { Restorer } from '../src/agents/adapter.ts';

/**
 * A restorer for tests about other parts: nothing in a setup runs programs or differs here,
 * and `restore` writes nothing unless the test gives its own.
 */
export function stubRestorer(restore?: Restorer['restore']): Restorer {
  return {
    reviewRunnable: () => Promise.resolve([]),
    isRedirectVariable: () => false,
    conflicts: () => [],
    restore:
      restore ?? (() => Promise.resolve({ written: [], skipped: [], backups: [], warnings: [] })),
  };
}
