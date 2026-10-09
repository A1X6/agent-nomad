import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { BundlePathSchema } from '@agentnomad/contracts';

import type { ExecutableLookupSystem } from '../shared/detector-system.ts';
import { findClaudeExecutable } from './detector.ts';
import { createProgramCli, type ProgramCli } from './plugin-sync.ts';
import { readValidateReport, type PluginValidator } from './skills-dir-plugins.ts';

/*
 * Running Claude Code's own check on a pulled plugin (T96): `claude plugin validate --json`
 * reads the manifest and the source of the hooks modules without running them (T95), so it is
 * safe on a plugin the user has not accepted yet. The files go into a temporary folder of
 * their own, removed afterwards, so nothing lands in the setup before the user has agreed.
 */

export interface PluginValidatorDeps {
  readonly system: ExecutableLookupSystem;
  /** Runs a found program; injected for tests. */
  readonly cli?: (path: string) => ProgramCli;
  /** Where the plugin is written for the check; the OS temporary folder by default. */
  readonly tempDir?: string;
}

/** Long enough for Claude Code to start and read a plugin; a hung check must not hang pull. */
const VALIDATE_TIMEOUT_MS = 60_000;

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A validator for this PC. It never throws: a problem comes back as `unavailable`. */
export function createPluginValidator(deps: PluginValidatorDeps): PluginValidator {
  const cli =
    deps.cli ??
    ((path: string) => createProgramCli(path, deps.system, { timeoutMs: VALIDATE_TIMEOUT_MS }));
  return async (plugin) => {
    const claudePath = await findClaudeExecutable(deps.system);
    if (claudePath === null) {
      return { kind: 'unavailable', reason: 'the claude command was not found' };
    }
    let root: string | null = null;
    try {
      root = await mkdtemp(join(deps.tempDir ?? tmpdir(), 'agentnomad-plugin-'));
      const folder = join(root, plugin.name);
      for (const file of plugin.files) {
        const relative = file.path.slice(plugin.folder.length);
        // Checked again here, although bundle paths are checked when a setup is opened.
        if (!BundlePathSchema.safeParse(relative).success) {
          return { kind: 'unavailable', reason: `unsafe path ${relative}` };
        }
        const target = join(folder, ...relative.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
      const run = await cli(claudePath).run(['plugin', 'validate', '--json', folder], root);
      const report = readValidateReport(run.stdout);
      if (report !== null) return report;
      const said = run.stderr.trim().split(/\r?\n/)[0] || `exit code ${String(run.exitCode)}`;
      return { kind: 'unavailable', reason: `claude plugin validate gave no report (${said})` };
    } catch (error) {
      return { kind: 'unavailable', reason: `the check could not run (${reason(error)})` };
    } finally {
      if (root !== null) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
