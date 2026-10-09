import type { CollectedFile, CollectOptions, Collector, ScopeTarget } from '../adapter.ts';
import { pathsOf } from '../shared/detector-system.ts';
import { findAutoMemory } from './auto-memory.ts';
import {
  createFileGatherer,
  type FileGatherer,
  jsonFile,
  uniqueByPath,
} from '../shared/file-gathering.ts';
import { neverSyncedIn, PLUGINS_BUNDLE_PATH, SKIPPED_NAMES } from './global-paths.ts';
import { projectHookScripts } from './hook-scripts.ts';
import { readPluginManifest } from './plugins.ts';
import {
  AUTO_MEMORY_BUNDLE_PREFIX,
  PROJECT_CLAUDE_FILES,
  PROJECT_CLAUDE_FOLDERS,
  PROJECT_MEMORY_FOLDERS,
  PROJECT_NEVER_SYNCED,
  PROJECT_ROOT_FILES,
  PROJECT_SETTINGS_FILES,
} from './project-paths.ts';

export interface ProjectCollectorOptions {
  /** Claude Code's base folder (`~/.claude` or `CLAUDE_CONFIG_DIR`), for auto memory. */
  readonly baseDir: string;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Never-synced project entries and what Claude Code generates in a plugin folder (T96). */
const isNeverSynced = neverSyncedIn(PROJECT_NEVER_SYNCED);

/**
 * A Claude Code project collector (T26). Bundle paths are relative to the project folder;
 * opt-in auto memory goes under `.agentnomad/auto-memory/`.
 */
export function createClaudeCodeProjectCollector(options: ProjectCollectorOptions): Collector {
  const path = pathsOf(options.platform);

  /** The script files the project's hooks run, when they are inside the project. */
  async function projectHookScriptFiles(
    files: FileGatherer,
    projectDir: string,
    settingsJson: string,
  ): Promise<CollectedFile[]> {
    const found: CollectedFile[] = [];
    for (const script of projectHookScripts(settingsJson, {
      projectDir,
      platform: options.platform,
    })) {
      const file = await files.readIfFile(script.nativePath, script.bundlePath);
      if (file) found.push(file);
    }
    return found;
  }

  async function autoMemory(
    projectDir: string,
    onSkipped: CollectOptions['onSkipped'],
  ): Promise<CollectedFile[]> {
    const location = await findAutoMemory({ ...options, projectDir });
    // A shared, unknown or refused folder is not this project's to take.
    if (location.kind !== 'folder') return [];
    const files = createFileGatherer(options.platform, {
      skippedNames: SKIPPED_NAMES,
      homedir: options.homedir,
      within: location.dir,
      ...(onSkipped && { onSkipped }),
    });
    // Auto memory is Markdown notes (T43); pull restores nothing else there.
    const found = await files.walk(location.dir, AUTO_MEMORY_BUNDLE_PREFIX, () => false);
    return found.filter((file) => file.path.toLowerCase().endsWith('.md'));
  }

  return {
    async collect(target: ScopeTarget, collectOptions: CollectOptions) {
      if (target.kind !== 'project') {
        throw new Error('The project collector only collects a project setup');
      }
      const { projectDir } = target;
      const claudeDir = path.join(projectDir, '.claude');
      const found: CollectedFile[] = [];
      // A cloned repository is not trusted: its links must stay inside the project (T45).
      const files = createFileGatherer(options.platform, {
        skippedNames: SKIPPED_NAMES,
        homedir: options.homedir,
        within: projectDir,
        ...(collectOptions.onSkipped && { onSkipped: collectOptions.onSkipped }),
      });

      for (const name of PROJECT_ROOT_FILES) {
        const file = await files.readIfFile(path.join(projectDir, name), name);
        if (file) found.push(file);
      }
      for (const name of PROJECT_CLAUDE_FILES) {
        const file = await files.readIfFile(path.join(claudeDir, name), `.claude/${name}`);
        if (file) found.push(file);
      }
      const seen = new Set<string>();
      const folders = collectOptions.includeMemory
        ? [...PROJECT_CLAUDE_FOLDERS, ...PROJECT_MEMORY_FOLDERS]
        : PROJECT_CLAUDE_FOLDERS;
      for (const name of folders) {
        found.push(
          ...(await files.walk(path.join(claudeDir, name), `.claude/${name}`, isNeverSynced, seen)),
        );
      }

      for (const settings of PROJECT_SETTINGS_FILES) {
        const file = found.find((entry) => entry.path === settings);
        if (file)
          found.push(
            ...(await projectHookScriptFiles(
              files,
              projectDir,
              new TextDecoder().decode(file.content),
            )),
          );
      }
      if (collectOptions.includeMemory) {
        found.push(...(await autoMemory(projectDir, collectOptions.onSkipped)));
      }

      const plugins = await readPluginManifest({
        baseDir: options.baseDir,
        platform: options.platform,
        scope: { kind: 'project', projectDir },
      });
      if (plugins) found.push(jsonFile(PLUGINS_BUNDLE_PATH, plugins));

      return uniqueByPath(found);
    },
  };
}
