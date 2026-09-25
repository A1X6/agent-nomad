import * as z from 'zod';

import type { AfterRestoreContext, CollectedFile } from '../adapter.ts';
import {
  claudeConfigDir,
  findClaudeExecutable,
  findExecutable,
  type DetectorSystem,
} from './detector.ts';
import { PLUGINS_BUNDLE_PATH, PROGRAMS_BUNDLE_PATH } from './global-paths.ts';
import {
  detectManagedSettings,
  explainPluginFailure,
  nodeManagedSettingsSystem,
} from './managed-settings.ts';
import { createClaudeCli, readCurrentPlugins, syncPlugins, type ClaudeCli } from './plugin-sync.ts';
import { PluginManifestSchema } from './plugins.ts';

/** `.agentnomad/programs.json`, checked before anything from it reaches a command line. */
const ProgramsFileSchema = z.strictObject({
  programs: z.array(
    z.strictObject({
      command: z.string().regex(/^[A-Za-z0-9._-]+$/),
      npm: z
        .strictObject({
          package: z.string().regex(/^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/),
          version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
        })
        .nullable(),
    }),
  ),
});

function readJson<S extends z.ZodType>(
  files: readonly CollectedFile[],
  path: string,
  schema: S,
): z.infer<S> | null {
  const file = files.find((entry) => entry.path === path);
  if (!file) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(file.content)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface AfterRestoreDeps {
  readonly system: DetectorSystem;
  /** Runs a found program (`claude`, `npm`); injected for tests. */
  readonly cli?: (path: string) => ClaudeCli;
}

/**
 * What pull does after writing a Claude Code setup (T34): reinstall its plugins (T29) and
 * offer to install programs its hooks or status line need (T25), each after asking.
 */
export function createClaudeCodeAfterRestore(deps: AfterRestoreDeps) {
  const cli = deps.cli ?? ((path: string) => createClaudeCli(path, deps.system.env));

  async function plugins(context: AfterRestoreContext): Promise<void> {
    const manifest = readJson(context.files, PLUGINS_BUNDLE_PATH, PluginManifestSchema);
    if (manifest === null || manifest.plugins.length === 0) return;
    const claudePath = await findClaudeExecutable(deps.system);
    if (claudePath === null) {
      context.reporter.warn(
        `${String(manifest.plugins.length)} saved plugin(s) were not reinstalled: the claude command was not found. Install Claude Code, then pull again.`,
      );
      return;
    }
    const baseDir = claudeConfigDir(deps.system);
    const managed = await detectManagedSettings(
      nodeManagedSettingsSystem(deps.system.env, baseDir, deps.system.platform),
    );
    const projectDir = context.target.kind === 'project' ? context.target.projectDir : undefined;
    await syncPlugins({
      manifest,
      current: await readCurrentPlugins(baseDir, projectDir),
      claude: cli(claudePath),
      prompter: context.prompter,
      reporter: context.reporter,
      cwd: projectDir ?? deps.system.homedir,
      assumeYes: context.assumeYes,
      explainFailure: (reason) => explainPluginFailure(reason, managed),
    });
  }

  async function programs(context: AfterRestoreContext): Promise<void> {
    const saved = readJson(context.files, PROGRAMS_BUNDLE_PATH, ProgramsFileSchema);
    if (saved === null) return;
    for (const program of saved.programs) {
      if ((await findExecutable(deps.system, program.command)) !== null) continue;
      if (program.npm === null) {
        context.reporter.warn(
          `Your hooks or status line run "${program.command}", which is not installed here. Install it for them to work.`,
        );
        continue;
      }
      const spec = `${program.npm.package}@${program.npm.version}`;
      const npmPath = await findExecutable(deps.system, 'npm');
      if (npmPath === null) {
        context.reporter.warn(
          `"${program.command}" is missing and npm was not found. Install it with: npm install -g ${spec}`,
        );
        continue;
      }
      const question = `"${program.command}" is not installed here. Install it with \`npm install -g ${spec}\`?`;
      if (!context.assumeYes && !(await context.prompter.confirm(question, true))) continue;
      const run = await cli(npmPath).run(['install', '-g', spec], deps.system.homedir);
      if (run.exitCode === 0) context.reporter.success(`Installed ${spec}.`);
      else
        context.reporter.warn(
          `Could not install ${spec}: ${run.stderr.trim() || `exit code ${String(run.exitCode)}`}`,
        );
    }
  }

  return async (context: AfterRestoreContext): Promise<void> => {
    await plugins(context);
    await programs(context);
  };
}
