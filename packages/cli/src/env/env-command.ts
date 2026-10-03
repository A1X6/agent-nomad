import type { AgentRegistry } from '../agents/adapter.ts';
import type { CommandHandlers } from '../cli/commands.ts';
import { projectFolderRefusal } from '../cli/project-folder.ts';
import type { Reporter } from '../ui/prompter.ts';
import { mergeEnvScans, scanEnvReferences, type EnvScan } from './env-references.ts';

export interface EnvCommandDeps {
  readonly registry: () => AgentRegistry;
  readonly reporter: Pick<Reporter, 'info' | 'success' | 'warn'>;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The current folder, taken as the project unless it holds the global setup (UX-03). */
  readonly cwd: string;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
}

/** Lines for `agentnomad env`; never includes a value. */
export function describeEnv(
  scan: EnvScan,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const width = Math.max(...scan.variables.map((variable) => variable.name.length));
  return scan.variables.map((variable) => {
    const status = scan.setBySettings.has(variable.name)
      ? '✓ set in settings'
      : (env[variable.name] ?? '') !== ''
        ? '✓ set here      '
        : '✗ missing here  ';
    return `${status.slice(0, 1)} ${variable.name.padEnd(width)}  ${status.slice(2)}  ${variable.usedBy.join('; ')}`;
  });
}

/**
 * `agentnomad env` (T30): which environment variables this PC's setups use (global and the
 * current folder's project) and whether each is set here. Only shows; changes nothing. The
 * home folder and the agent's own folder are never a project (BUG-05, UX-03).
 */
export function createEnvCommand(deps: EnvCommandDeps): Pick<CommandHandlers, 'env'> {
  return {
    async env() {
      const scans: EnvScan[] = [];
      for (const adapter of deps.registry().list()) {
        const found = await adapter.detector.detect();
        if (!found.installed) continue;
        const options = { includeMemory: false };
        const global = await adapter.collector.collect({ kind: 'global' }, options);
        scans.push(scanEnvReferences(global, `${adapter.displayName} global`));
        const refusal = projectFolderRefusal(deps.cwd, {
          homedir: deps.homedir,
          baseDir: found.baseDir,
          agentName: adapter.displayName,
          platform: deps.platform,
        });
        if (refusal !== null) continue;
        const project = await adapter.collector.collect(
          { kind: 'project', projectDir: deps.cwd },
          options,
        );
        scans.push(scanEnvReferences(project, `${adapter.displayName} this project`));
      }
      const scan = mergeEnvScans(scans);
      if (scan.variables.length === 0) {
        deps.reporter.info(
          'Your setups here use no environment variables (no ${VAR} in MCP servers or settings).',
        );
        return;
      }
      deps.reporter.info(
        [
          'Environment variables your setups use:',
          ...describeEnv(scan, deps.env).map((line) => `  ${line}`),
        ].join('\n'),
      );
      const missing = scan.variables.filter(
        (variable) =>
          !scan.setBySettings.has(variable.name) && (deps.env[variable.name] ?? '') === '',
      ).length;
      if (missing > 0) {
        deps.reporter.warn(
          `${String(missing)} missing here: the MCP servers or settings that use them will not work until they are set.`,
        );
      } else {
        deps.reporter.success('All of them are set here.');
      }
    },
  };
}
