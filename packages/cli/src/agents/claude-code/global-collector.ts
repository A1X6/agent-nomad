import { readFile } from 'node:fs/promises';

import * as z from 'zod';

import type { CollectedFile, CollectOptions, Collector, ScopeTarget } from '../adapter.ts';
import { underAnyFolder } from '../shared/bundle-paths.ts';
import { pathsOf } from '../shared/detector-system.ts';
import {
  createFileGatherer,
  type FileGatherer,
  jsonFile,
  uniqueByPath,
} from '../shared/file-gathering.ts';
import { ACCOUNT_SKILLS_PART, collectAccountSkills, readSyncedSkills } from './account-skills.ts';
import { ClaudeJsonError } from './claude-json-merge.ts';
import {
  CLAUDE_JSON_BUNDLE_PATH,
  CLAUDE_JSON_MCP_KEY,
  CLAUDE_JSON_PREFERENCE_KEYS,
  GLOBAL_FILES,
  GLOBAL_FOLDERS,
  GLOBAL_MEMORY_FOLDERS,
  globalSettingsFiles,
  HOME_SCRIPTS_PREFIX,
  NEVER_SYNCED,
  PLUGINS_BUNDLE_PATH,
  PROGRAMS_BUNDLE_PATH,
  SKIPPED_NAMES,
  TOOL_CONFIG_FILES,
} from './global-paths.ts';
import { hookScripts } from './hook-scripts.ts';
import { readPluginManifest } from './plugins.ts';
import { ProgramEntrySchema, type ProgramInfo, type ProgramLocator } from './programs.ts';
import { commandsInSettings, programOf } from './settings-commands.ts';

export interface GlobalCollectorOptions {
  /** Claude Code's base folder, from the detector (`~/.claude` or `CLAUDE_CONFIG_DIR`). */
  readonly baseDir: string;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
  /** Whether `CLAUDE_CONFIG_DIR` is set: `.claude.json` then lives in the base folder. */
  readonly customConfigDir: boolean;
  /** Looks up programs hooks and the status line run; without it none are recorded. */
  readonly findProgram?: ProgramLocator;
  /** Single files in the base folder; the paths data file's list unless a test gives one. */
  readonly globalFiles?: readonly string[];
}

/** True when `bundlePath` is a never-synced entry or inside one. */
const isNeverSynced = underAnyFolder(NEVER_SYNCED);

/** A Claude Code global collector for one PC (T25). Project scope is T26. */
export function createClaudeCodeGlobalCollector(options: GlobalCollectorOptions): Collector {
  const path = pathsOf(options.platform);
  const { baseDir, homedir } = options;
  const globalFiles = options.globalFiles ?? GLOBAL_FILES;
  // The settings files among them, as `GLOBAL_SETTINGS_FILES` is made.
  const settingsFiles = globalSettingsFiles(globalFiles);

  /** Script files that hooks and the status line run, if they are in the home folder. */
  async function hookScriptFiles(
    files: FileGatherer,
    settingsJson: string,
  ): Promise<CollectedFile[]> {
    const found: CollectedFile[] = [];
    for (const script of hookScripts(settingsJson, options)) {
      const file = await files.readIfFile(script.nativePath, script.bundlePath);
      if (file) found.push(file);
    }
    return found;
  }

  /**
   * For each program the commands of all settings files run: its known settings file (e.g.
   * ccstatusline's) and, unless it runs through npx, what it is and how it was installed, so
   * pull can check it. All in one `programs.json` (T86): one per settings file kept only the last.
   */
  async function programs(
    files: FileGatherer,
    settingsJsons: readonly string[],
    onSkipped: CollectOptions['onSkipped'],
  ): Promise<CollectedFile[]> {
    const found: CollectedFile[] = [];
    // `null`: left out, as pull would refuse it.
    const programsFound = new Map<string, ProgramInfo | null>();
    for (const words of settingsJsons.flatMap((json) => commandsInSettings(json))) {
      const program = programOf(words);
      if (program === null) continue;
      for (const relative of TOOL_CONFIG_FILES[program.name] ?? []) {
        const file = await files.readIfFile(
          path.join(homedir, ...relative.split('/')),
          HOME_SCRIPTS_PREFIX + relative,
        );
        if (file) found.push(file);
      }
      if (!program.runner && !programsFound.has(program.name) && options.findProgram) {
        const info = (await options.findProgram(program.name)) ?? {
          command: program.name,
          npm: null,
        };
        // Checked as pull checks it (BUG-01): an entry pull refuses is said here, not saved.
        const accepted = ProgramEntrySchema.safeParse(info).success;
        if (!accepted) onSkipped?.(`program ${program.name}`, 'pull refuses its name or package');
        programsFound.set(program.name, accepted ? info : null);
      }
    }
    const list = [...programsFound.values()]
      .filter((info): info is ProgramInfo => info !== null)
      .sort((a, b) => a.command.localeCompare(b.command));
    if (list.length > 0) found.push(jsonFile(PROGRAMS_BUNDLE_PATH, { programs: list }));
    return found;
  }

  /** MCP servers and preference keys from `~/.claude.json`; nothing else in it. */
  async function claudeJson(): Promise<CollectedFile | null> {
    const file = options.customConfigDir
      ? path.join(baseDir, '.claude.json')
      : path.join(homedir, '.claude.json');
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ClaudeJsonError(file, { cause: error });
    }
    const all = z.record(z.string(), z.unknown()).safeParse(parsed);
    if (!all.success) throw new ClaudeJsonError(file, { cause: all.error });

    const selected: Record<string, unknown> = {};
    const mcpServers = all.data[CLAUDE_JSON_MCP_KEY];
    if (mcpServers && typeof mcpServers === 'object' && Object.keys(mcpServers).length > 0) {
      selected[CLAUDE_JSON_MCP_KEY] = mcpServers;
    }
    for (const key of CLAUDE_JSON_PREFERENCE_KEYS) {
      if (all.data[key] !== undefined) selected[key] = all.data[key];
    }
    return Object.keys(selected).length === 0 ? null : jsonFile(CLAUDE_JSON_BUNDLE_PATH, selected);
  }

  return {
    async collect(target: ScopeTarget, collectOptions: CollectOptions) {
      if (target.kind !== 'global') {
        throw new Error('The global collector only collects the global setup');
      }
      const found: CollectedFile[] = [];
      // Links into folders for keys and logins are never followed, and huge files are left
      // out (T45); the user's own links elsewhere (a dotfiles repo) still come along.
      const files = createFileGatherer(options.platform, {
        skippedNames: SKIPPED_NAMES,
        homedir,
        ...(collectOptions.onSkipped && { onSkipped: collectOptions.onSkipped }),
      });

      for (const name of globalFiles) {
        const file = await files.readIfFile(path.join(baseDir, name), name);
        if (file) found.push(file);
      }
      const seen = new Set<string>();
      const folders = collectOptions.includeMemory
        ? [...GLOBAL_FOLDERS, ...GLOBAL_MEMORY_FOLDERS]
        : GLOBAL_FOLDERS;
      for (const name of folders) {
        found.push(...(await files.walk(path.join(baseDir, name), name, isNeverSynced, seen)));
      }

      const settingsJsons = found
        .filter((file) => settingsFiles.includes(file.path))
        .map((file) => new TextDecoder().decode(file.content));
      for (const text of settingsJsons) found.push(...(await hookScriptFiles(files, text)));
      found.push(...(await programs(files, settingsJsons, collectOptions.onSkipped)));

      const selected = await claudeJson();
      if (selected) found.push(selected);

      const plugins = await readPluginManifest({
        baseDir,
        platform: options.platform,
        scope: { kind: 'global' },
      });
      if (plugins) found.push(jsonFile(PLUGINS_BUNDLE_PATH, plugins));

      // Opt-in (T42): a copy of the user's own claude.ai skills, never skills/synced itself.
      if (collectOptions.include?.has(ACCOUNT_SKILLS_PART) === true) {
        found.push(...(await collectAccountSkills(files, await readSyncedSkills(path, baseDir))));
      }

      // A hook may name a file already in a synced folder.
      return uniqueByPath(found);
    },
  };
}
