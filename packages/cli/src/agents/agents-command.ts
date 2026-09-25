import type { CommandHandlers } from '../cli/commands.ts';
import type { Reporter } from '../ui/prompter.ts';
import type { AgentRegistry, DetectedAgent } from './adapter.ts';

export interface AgentsCommandDeps {
  readonly registry: () => AgentRegistry;
  readonly reporter: Pick<Reporter, 'info' | 'success' | 'warn'>;
  /** Extra things to point out, e.g. organization-managed settings (T31). */
  readonly notices?: () => Promise<readonly string[]>;
}

/** One line per agent, e.g. `✓ Claude Code  2.1.282  C:\Users\a\.claude`. */
export function describeAgent(displayName: string, found: DetectedAgent): string {
  if (!found.installed) return `✗ ${displayName}  not found on this PC`;
  return [`✓ ${displayName}`, found.version ?? 'version unknown', found.baseDir ?? '']
    .filter((part) => part !== '')
    .join('  ');
}

/** `agentnomad agents`: which supported agents are on this PC, and where (T28). */
export function createAgentsCommand(deps: AgentsCommandDeps): Pick<CommandHandlers, 'agents'> {
  return {
    async agents() {
      const adapters = deps.registry().list();
      const found = await Promise.all(adapters.map((adapter) => adapter.detector.detect()));
      const lines = adapters.map((adapter, index) =>
        describeAgent(
          adapter.displayName,
          found[index] ?? { installed: false, baseDir: null, version: null },
        ),
      );
      const installed = found.filter((agent) => agent.installed).length;
      deps.reporter.info(['Supported agents:', ...lines.map((line) => `  ${line}`)].join('\n'));
      for (const notice of (await deps.notices?.()) ?? []) deps.reporter.warn(notice);
      deps.reporter.success(
        `${String(installed)} of ${String(adapters.length)} supported agent${adapters.length === 1 ? '' : 's'} found on this PC.`,
      );
    },
  };
}
