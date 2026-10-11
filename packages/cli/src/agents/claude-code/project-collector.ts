import { isFile } from '../../system/files.ts';
import type { CollectedFile, CollectOptions, Collector, ScopeTarget } from '../adapter.ts';
import { underAnyFolder } from '../shared/bundle-paths.ts';
import { pathsOf } from '../shared/detector-system.ts';
import {
  createFileGatherer,
  type FileGatherer,
  jsonFile,
  uniqueByPath,
} from '../shared/file-gathering.ts';
import { findAutoMemory } from './auto-memory.ts';
import { claudeJsonFileOf, projectClaudeJson, readClaudeJsonFile } from './claude-json-merge.ts';
import {
  followImports,
  isProjectMemoryFile,
  projectImportPlace,
  shownImportPath,
  skippedImportReason,
} from './claude-md-imports.ts';
import { SKIPPED_NAMES } from './global-paths.ts';
import { onceEachScript, projectHookScripts, type SkippedScript } from './hook-scripts.ts';
import { localMarketplaceFiles } from './local-marketplaces.ts';
import type { ProgramCli } from './plugin-sync.ts';
import { pluginFiles } from './plugins.ts';
import {
  AUTO_MEMORY_BUNDLE_PREFIX,
  CLAUDE_JSON_PROJECT_BUNDLE_PATH,
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
  /** Whether `CLAUDE_CONFIG_DIR` is set: `.claude.json` then lives in the base folder. */
  readonly customConfigDir?: boolean;
  /** Finds `git` for saved local marketplaces (T98); without it their folders are walked. */
  readonly findGit?: () => Promise<ProgramCli | null>;
}

/** What gathering an auto memory folder needs: this PC, and who hears of a file left out. */
interface MemoryGathering {
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
  readonly onSkipped?: CollectOptions['onSkipped'] | undefined;
}

/**
 * The Markdown files of one auto memory folder as `bundlePrefix/...`: auto memory is notes
 * (T43), and pull restores nothing else there. Links must stay inside the folder. Shared with
 * the global collector, which takes every project's (T110).
 */
export async function collectMemoryFolder(
  dir: string,
  bundlePrefix: string,
  gathering: MemoryGathering,
): Promise<CollectedFile[]> {
  const files = createFileGatherer(gathering.platform, {
    skippedNames: SKIPPED_NAMES,
    homedir: gathering.homedir,
    within: dir,
    ...(gathering.onSkipped && { onSkipped: gathering.onSkipped }),
  });
  const found = await files.walk(dir, bundlePrefix, () => false);
  return found.filter((file) => file.path.toLowerCase().endsWith('.md'));
}

/** True when `bundlePath` is a never-synced project entry or inside one. */
const isNeverSynced = underAnyFolder(PROJECT_NEVER_SYNCED);

/**
 * A Claude Code project collector (T26). Bundle paths are relative to the project folder;
 * opt-in auto memory goes under `.agentnomad/auto-memory/`.
 */
export function createClaudeCodeProjectCollector(options: ProjectCollectorOptions): Collector {
  const path = pathsOf(options.platform);

  /**
   * The script files the project's hooks run, when they are inside the project; the others
   * are told to `onSkipped` (T112).
   */
  async function projectHookScriptFiles(
    files: FileGatherer,
    projectDir: string,
    settingsJson: string,
    onSkipped: SkippedScript | undefined,
  ): Promise<CollectedFile[]> {
    const found: CollectedFile[] = [];
    const context = { projectDir, platform: options.platform };
    for (const script of projectHookScripts(settingsJson, context, onSkipped)) {
      const file = await files.readIfFile(script.nativePath, script.bundlePath);
      if (file) found.push(file);
    }
    return found;
  }

  /**
   * The files the project's memory files import (T111) that are inside the project, at their
   * project path. Each one push cannot take (outside the project, never synced) is named.
   */
  async function importedFiles(
    files: FileGatherer,
    projectDir: string,
    found: readonly CollectedFile[],
    onSkipped: CollectOptions['onSkipped'],
  ): Promise<CollectedFile[]> {
    const memoryFiles = found
      .filter((file) => isProjectMemoryFile(file.path))
      .map((file) => ({
        nativePath: path.join(projectDir, ...file.path.split('/')),
        bundlePath: file.path,
        text: new TextDecoder().decode(file.content),
      }));
    const imported: CollectedFile[] = [];
    const { skipped } = await followImports(
      memoryFiles,
      {
        place: (nativePath) =>
          projectImportPlace(nativePath, { projectDir, platform: options.platform }),
        isFile,
        async read(nativePath, bundlePath) {
          const file = await files.readIfFile(nativePath, bundlePath);
          if (file === null) return null;
          imported.push(file);
          return new TextDecoder().decode(file.content);
        },
      },
      options,
    );
    for (const entry of skipped) {
      onSkipped?.(shownImportPath(entry.nativePath, options), skippedImportReason(entry, options));
    }
    return imported;
  }

  async function autoMemory(
    projectDir: string,
    onSkipped: CollectOptions['onSkipped'],
  ): Promise<CollectedFile[]> {
    const location = await findAutoMemory({ ...options, projectDir });
    // A shared, unknown or refused folder is not this project's to take.
    if (location.kind !== 'folder') return [];
    return collectMemoryFolder(location.dir, AUTO_MEMORY_BUNDLE_PREFIX, { ...options, onSkipped });
  }

  /**
   * The project's local MCP servers and `.mcp.json` choices from its entry in
   * `~/.claude.json` (T109), keyed by the folder as Claude Code writes it; nothing else there.
   */
  async function claudeJson(projectDir: string): Promise<CollectedFile | null> {
    const all = await readClaudeJsonFile(
      claudeJsonFileOf({ ...options, customConfigDir: options.customConfigDir ?? false }),
    );
    const selected = all === null ? null : projectClaudeJson(all, projectDir, options.platform);
    return selected === null ? null : jsonFile(CLAUDE_JSON_PROJECT_BUNDLE_PATH, selected);
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

      const skippedScript = onceEachScript(collectOptions.onSkipped);
      for (const settings of PROJECT_SETTINGS_FILES) {
        const file = found.find((entry) => entry.path === settings);
        if (file)
          found.push(
            ...(await projectHookScriptFiles(
              files,
              projectDir,
              new TextDecoder().decode(file.content),
              skippedScript,
            )),
          );
      }
      found.push(...(await importedFiles(files, projectDir, found, collectOptions.onSkipped)));
      if (collectOptions.includeMemory) {
        found.push(...(await autoMemory(projectDir, collectOptions.onSkipped)));
      }
      const selected = await claudeJson(projectDir);
      if (selected) found.push(selected);

      const plugins = {
        baseDir: options.baseDir,
        platform: options.platform,
        scope: { kind: 'project', projectDir },
      } as const;
      found.push(...(await pluginFiles(plugins)));
      found.push(
        ...(await localMarketplaceFiles(plugins, {
          homedir: options.homedir,
          ...(options.findGit && { git: options.findGit }),
          ...(collectOptions.onSkipped && { onSkipped: collectOptions.onSkipped }),
        })),
      );

      return uniqueByPath(found);
    },
  };
}
