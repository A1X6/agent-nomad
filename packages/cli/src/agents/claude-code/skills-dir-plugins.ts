import { sameBytes } from '@agentnomad/contracts';
import * as z from 'zod';

import type { CollectedFile, ReviewedEntry, RunnableEntry } from '../adapter.ts';
import {
  JsonObjectSchema,
  parseJsonWith,
  valueOrNull,
  type JsonResult,
} from '../../system/json.ts';
import { hookEntries, serverEntries, unreadableEntry } from './command-review.ts';

/*
 * Plugins and mods in the skills folder (T96). A folder in `skills/` (or a project's
 * `.claude/skills/`) with a `.claude-plugin/plugin.json` is a plugin that Claude Code loads
 * as `<name>@skills-dir` (T95). One whose hooks file names `modules` is a mod: code that runs
 * inside Claude Code. The folder is already synced whole (T25); this module leaves out what
 * Claude Code generates in it, names the plugins in push's summary, and gives pull's review
 * what each one runs. Pure text rules (SOLID-05): the files come in, nothing is read or run
 * here; `plugin-validate.ts` runs Claude Code's own check.
 */

/** A plugin's manifest file, from its folder. */
const MANIFEST_PATH = '.claude-plugin/plugin.json';
/** Where a plugin's hooks and MCP servers live unless the manifest names other sources. */
const DEFAULT_HOOKS_PATH = 'hooks/hooks.json';
const DEFAULT_MCP_PATH = '.mcp.json';
/** Why a named file could not be read, next to the parse problems `parseJsonWith` gives. */
const NO_SUCH_FILE = 'no such file';

/** A skill folder's bundle path prefix (`skills/` or `.claude/skills/`) and the plugin's name. */
const PLUGIN_FOLDER = /^((?:\.claude\/)?skills\/)([^/]+)\//;

/** The plugin folder a bundle path is in (`skills/<name>/`) and its name; `null` outside one. */
function pluginFolderOf(path: string): { folder: string; name: string } | null {
  const match = PLUGIN_FOLDER.exec(path);
  const [, prefix, name] = match ?? [];
  // `skills/synced/` is managed by claude.ai; never collected, and never a plugin of the setup.
  if (prefix === undefined || name === undefined || name === 'synced') return null;
  return { folder: `${prefix}${name}/`, name };
}

/**
 * A plugin's MCP sources known by path alone: its default `.mcp.json` and its manifest (inline
 * `mcpServers`), so the env scan sees their `${VAR}` references too (review 16 BUG-01). A file
 * the manifest names instead is only known once the manifest is read.
 */
export function isPluginMcpSource(path: string): boolean {
  const found = pluginFolderOf(path);
  if (found === null) return false;
  const inside = path.slice(found.folder.length);
  return inside === DEFAULT_MCP_PATH || inside === MANIFEST_PATH;
}

const Json = JsonObjectSchema;
/**
 * The manifest fields this module reads, each on its own (SEC-01), in the shapes Claude Code's
 * manifest reference gives: `hooks` is a file path, an inline event map, or an array mixing
 * both; `mcpServers` is a `.json` file path, an MCP bundle path or URL (`.mcpb`, `.dxt`), an
 * inline map, or an array mixing them.
 */
const HooksFieldSchema = z.union([z.string(), Json, z.array(z.union([z.string(), Json]))]);
const ServersFieldSchema = HooksFieldSchema;

/** Hooks a plugin declares: the event map, and where it came from. */
interface HooksSource {
  /** What the review names, e.g. `hooks/hooks.json` or `.claude-plugin/plugin.json`. */
  readonly label: string;
  readonly hooks: unknown;
}

/** MCP servers a plugin declares: a map of servers, or a packaged server it loads. */
type ServerSource =
  | { readonly label: string; readonly servers: unknown }
  /** An MCP bundle, as a path inside the plugin or a URL: code Claude Code downloads or extracts. */
  | { readonly label: string; readonly bundle: string };

/** A part of a plugin that could not be read as Claude Code expects; shown, never dropped. */
interface Unreadable {
  readonly label: string;
  readonly value: unknown;
}

/** One plugin folder among a setup's files. */
export interface PluginFolder {
  /** Bundle path of the folder, with its trailing slash: `skills/<name>/`. */
  readonly folder: string;
  readonly name: string;
  /** Every file of the folder. */
  readonly files: readonly CollectedFile[];
  readonly hooks: readonly HooksSource[];
  readonly servers: readonly ServerSource[];
  /** Hooks modules the plugin names: code that runs inside Claude Code (a mod). */
  readonly modules: readonly string[];
  readonly unreadable: readonly Unreadable[];
}

/** A path the manifest names, relative to the plugin folder (`./hooks/x.json` → `hooks/x.json`). */
const insideFolder = (relative: string) => relative.replace(/^\.\//, '');

const isBundle = (value: string) => /\.(mcpb|dxt)$/i.test(value) || /^https?:\/\//i.test(value);

/** An MCP file's servers: under `mcpServers`, or the whole file when the wrapper is left out. */
const serversIn = (json: Record<string, unknown>) =>
  'mcpServers' in json ? json['mcpServers'] : json;

/** Reads one plugin folder's declarations, one part at a time: a bad part hides no other (SEC-01). */
function readPlugin(
  folder: string,
  name: string,
  inside: readonly CollectedFile[],
  manifestFile: CollectedFile,
): PluginFolder {
  const byPath = new Map(inside.map((file) => [file.path.slice(folder.length), file]));
  const hooks: HooksSource[] = [];
  const servers: ServerSource[] = [];
  const modules: string[] = [];
  const unreadable: Unreadable[] = [];
  const read = new Set<string>();

  /**
   * A JSON object file of the plugin, or why it could not be read: missing, not JSON, or not an
   * object, in the words `parseJsonWith` gives (review 16 UX-01, UX-02).
   */
  const jsonFileOf = (relative: string): JsonResult<Record<string, unknown>> => {
    const file = byPath.get(relative);
    return file === undefined ? { problem: NO_SUCH_FILE } : parseJsonWith(Json, file.content);
  };

  // A hooks file wraps the event map in `hooks` and may name `modules`. A file named twice (the
  // manifest naming the default) is read once.
  const hooksFile = (relative: string, named: boolean) => {
    // A missing file is "read" only once it is named, so the default read of hooks/hooks.json
    // never hides a manifest that names it (review 15 BUG-01).
    if (!byPath.has(relative)) {
      if (named && !read.has(relative)) unreadable.push({ label: relative, value: NO_SUCH_FILE });
      if (named) read.add(relative);
      return;
    }
    if (read.has(relative)) return;
    read.add(relative);
    const result = jsonFileOf(relative);
    if ('problem' in result) {
      unreadable.push({ label: relative, value: result.problem });
      return;
    }
    const json = result.value;
    // A file with neither key is not a hooks file Claude Code loads (an event map at the top
    // level is refused): shown as it is, never dropped (review 16 SEC-02).
    if (json['hooks'] === undefined && json['modules'] === undefined) {
      unreadable.push({ label: relative, value: json });
      return;
    }
    if (json['hooks'] !== undefined) hooks.push({ label: relative, hooks: json['hooks'] });
    const list = json['modules'];
    if (list === undefined) return;
    const names = Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
    modules.push(...names);
    if (!Array.isArray(list) || names.length !== list.length) {
      unreadable.push({ label: `${relative} modules`, value: list });
    }
  };
  hooksFile(DEFAULT_HOOKS_PATH, false);

  // The manifest is there (that is what made the folder a plugin); it may still not be JSON.
  const manifestRead = parseJsonWith(Json, manifestFile.content);
  if ('problem' in manifestRead) {
    unreadable.push({ label: MANIFEST_PATH, value: manifestRead.problem });
  } else {
    const manifest = manifestRead.value;
    // Each field on its own: a bad `hooks` never hides a valid `mcpServers`.
    const hooksField = HooksFieldSchema.safeParse(manifest['hooks']);
    if (manifest['hooks'] !== undefined && !hooksField.success) {
      unreadable.push({ label: `${MANIFEST_PATH} hooks`, value: manifest['hooks'] });
    }
    const declaredHooks = hooksField.success ? hooksField.data : undefined;
    for (const item of Array.isArray(declaredHooks) ? declaredHooks : [declaredHooks]) {
      if (typeof item === 'string') hooksFile(insideFolder(item), true);
      // An inline object is the event map itself, with no wrapper.
      else if (item !== undefined) hooks.push({ label: MANIFEST_PATH, hooks: item });
    }

    const serversField = ServersFieldSchema.safeParse(manifest['mcpServers']);
    if (manifest['mcpServers'] !== undefined && !serversField.success) {
      unreadable.push({ label: `${MANIFEST_PATH} mcpServers`, value: manifest['mcpServers'] });
    }
    const declaredServers = serversField.success ? serversField.data : undefined;
    for (const item of Array.isArray(declaredServers) ? declaredServers : [declaredServers]) {
      if (item === undefined) continue;
      if (typeof item !== 'string') servers.push({ label: MANIFEST_PATH, servers: item });
      else if (isBundle(item)) servers.push({ label: MANIFEST_PATH, bundle: item });
      else {
        const relative = insideFolder(item);
        if (read.has(relative)) continue;
        read.add(relative);
        const result = jsonFileOf(relative);
        // A file that is missing or not JSON is shown with why, never dropped (review 16 UX-02).
        if ('problem' in result) unreadable.push({ label: relative, value: result.problem });
        else servers.push({ label: relative, servers: serversIn(result.value) });
      }
    }
  }
  if (!read.has(DEFAULT_MCP_PATH) && byPath.has(DEFAULT_MCP_PATH)) {
    const result = jsonFileOf(DEFAULT_MCP_PATH);
    if ('problem' in result) unreadable.push({ label: DEFAULT_MCP_PATH, value: result.problem });
    else servers.push({ label: DEFAULT_MCP_PATH, servers: serversIn(result.value) });
  }
  return {
    folder,
    name,
    files: inside,
    hooks,
    servers,
    modules: [...new Set(modules)],
    unreadable,
  };
}

/**
 * The plugin folders among `files`: each `skills/<name>/` with a manifest, with the hooks and
 * MCP servers it declares (the default files, and whatever the manifest names) and its modules.
 */
export function pluginFolders(files: readonly CollectedFile[]): PluginFolder[] {
  const byFolder = new Map<string, { name: string; files: CollectedFile[] }>();
  for (const file of files) {
    const found = pluginFolderOf(file.path);
    if (found === null) continue;
    const group = byFolder.get(found.folder);
    if (group) group.files.push(file);
    else byFolder.set(found.folder, { name: found.name, files: [file] });
  }
  const plugins: PluginFolder[] = [];
  for (const [folder, group] of byFolder) {
    const manifestFile = group.files.find((file) => file.path === folder + MANIFEST_PATH);
    if (manifestFile === undefined) continue;
    plugins.push(readPlugin(folder, group.name, group.files, manifestFile));
  }
  return plugins.sort((a, b) => (a.folder < b.folder ? -1 : 1));
}

/** What push says about the plugins among a setup's files; `[]` when there are none. */
export function pluginNotes(files: readonly CollectedFile[]): string[] {
  const plugins = pluginFolders(files);
  if (plugins.length === 0) return [];
  const named = plugins.map(
    (plugin) =>
      `${plugin.name} (${plugin.folder}${plugin.modules.length > 0 ? ', a mod: runs code inside Claude Code' : ''})`,
  );
  return [
    `Plugins in the skills folder, saved with it: ${named.join(', ')}. They load as <name>@skills-dir on the other PC, after pull shows what they run.`,
  ];
}

/** What `claude plugin validate --json` said about one plugin, or why it could not be run. */
export type PluginValidation =
  | {
      readonly kind: 'report';
      /** Errors in the manifest or a hooks file; the plugin is broken when there are any. */
      readonly errors: readonly string[];
      /** Per hooks module: the events it hooks and the `$` methods it calls. */
      readonly modules: readonly {
        readonly module: string;
        readonly hooks: string;
        readonly calls: string;
      }[];
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** Runs Claude Code's own check on a plugin's files (`plugin-validate.ts`). */
export type PluginValidator = (plugin: PluginFolder) => Promise<PluginValidation>;

/**
 * The report `claude plugin validate --json` prints; only what the review reads is checked.
 * Errors are kept as they come: one in an unexpected shape is shown as its JSON, never
 * dropped (review 15 SEC-02).
 */
const Problem = z.looseObject({ path: z.string().nullable().optional(), message: z.string() });
const ReportSchema = z.looseObject({
  success: z.boolean().optional(),
  manifest: z.looseObject({ errors: z.array(z.unknown()).catch([]) }),
  contents: z.array(
    z.looseObject({
      type: z.string(),
      errors: z.array(z.unknown()).catch([]),
      notes: z.array(z.string()).catch([]),
    }),
  ),
});

/** One reported error as text: `path: message`, or the JSON of an error in another shape. */
function errorText(error: unknown): string {
  const problem = Problem.safeParse(error);
  if (!problem.success) return JSON.stringify(error);
  return problem.data.path ? `${problem.data.path}: ${problem.data.message}` : problem.data.message;
}

/** `./register.ts hooks: a, b` and `./register.ts calls: $.x, $.y`, as validate notes them (T95). */
const NOTE = /^(\S+) (hooks|calls): (.*)$/;

/** The report as the review uses it; `null` when `stdout` is not one. */
export function readValidateReport(stdout: string): PluginValidation | null {
  const report = valueOrNull(parseJsonWith(ReportSchema, stdout.trim()));
  if (report === null) return null;
  const errors = [
    ...report.manifest.errors,
    ...report.contents.flatMap((content) => content.errors),
  ].map(errorText);
  if (report.success === false && errors.length === 0) {
    errors.push('validate reported a failure it did not explain');
  }
  const modules = new Map<string, { hooks: string; calls: string }>();
  for (const content of report.contents) {
    if (content.type !== 'hooks') continue;
    for (const note of content.notes) {
      const match = NOTE.exec(note);
      if (match === null) continue;
      const [, module, kind, text] = match;
      const entry = modules.get(module ?? '') ?? { hooks: '', calls: '' };
      entry[kind === 'hooks' ? 'hooks' : 'calls'] = text ?? '';
      modules.set(module ?? '', entry);
    }
  }
  return {
    kind: 'report',
    errors,
    modules: [...modules].map(([module, found]) => ({ module, ...found })),
  };
}

const label = (plugin: PluginFolder, rest: string) => `plugin ${plugin.folder} ${rest}`;

const entry = (plugin: PluginFolder, rest: string, command: string): RunnableEntry => ({
  file: plugin.folder,
  label: label(plugin, rest),
  command,
  identity: command,
});

/** Everything one plugin runs, as entries that all belong to its folder. */
async function pluginEntries(
  plugin: PluginFolder,
  validate: PluginValidator | undefined,
): Promise<RunnableEntry[]> {
  const entries: RunnableEntry[] = plugin.unreadable.map((part) =>
    unreadableEntry(plugin.folder, label(plugin, part.label), part.value),
  );
  for (const source of plugin.hooks) {
    for (const found of hookEntries(source.label, source.hooks)) {
      entries.push({ ...found, file: plugin.folder, label: label(plugin, found.label) });
    }
  }
  for (const source of plugin.servers) {
    if ('bundle' in source) {
      entries.push(
        entry(plugin, `MCP bundle (${source.label}, downloaded or extracted)`, source.bundle),
      );
      continue;
    }
    for (const found of serverEntries(source.label, source.servers)) {
      entries.push({ ...found, file: plugin.folder, label: label(plugin, found.label) });
    }
  }
  if (plugin.modules.length === 0) return entries;

  const checked = validate
    ? await validate(plugin)
    : { kind: 'unavailable' as const, reason: 'plugin checks are not set up' };
  if (checked.kind === 'unavailable') {
    entries.push(
      entry(
        plugin,
        `(a mod: runs code inside Claude Code, not checked)`,
        `modules ${plugin.modules.join(', ')}: ${checked.reason}, so what they hook and call could not be listed`,
      ),
    );
    return entries;
  }
  if (checked.errors.length > 0) {
    entries.push(
      entry(plugin, '(broken: Claude Code will not load it)', checked.errors.join('; ')),
    );
  }
  const reported = new Set(checked.modules.map((module) => module.module));
  for (const module of checked.modules) {
    entries.push(
      entry(
        plugin,
        `module ${module.module} (runs code inside Claude Code)`,
        `hooks: ${module.hooks || 'nothing'}; calls: ${module.calls || 'nothing on $'}`,
      ),
    );
  }
  for (const module of plugin.modules.filter((name) => !reported.has(name))) {
    entries.push(
      entry(plugin, `module ${module} (runs code inside Claude Code)`, 'not read by validate'),
    );
  }
  return entries;
}

/**
 * The plugins among `incoming` that are new or changed on this PC, with everything each one
 * runs: its hooks (the T44 reader, as `claude plugin validate` does not list classic hooks),
 * its MCP servers and bundles, and for a mod what its modules hook and call. The whole folder
 * is one unit (its `file` is the folder), so declining leaves the plugin out entirely; an
 * unchanged plugin is not shown.
 */
export async function reviewPlugins(
  incoming: readonly CollectedFile[],
  current: readonly CollectedFile[],
  validate?: PluginValidator,
): Promise<ReviewedEntry[]> {
  // Lookup tables, not a search per plugin or file: a setup may hold thousands (PERF-01).
  const here = new Map(current.map((file) => [file.path, file]));
  const hereFolders = new Set(current.flatMap((file) => pluginFolderOf(file.path)?.folder ?? []));
  const entries: ReviewedEntry[] = [];
  for (const plugin of pluginFolders(incoming)) {
    const existing = hereFolders.has(plugin.folder);
    const differs = plugin.files.some((file) => {
      const same = here.get(file.path);
      return same === undefined || !sameBytes(same.content, file.content);
    });
    if (existing && !differs) continue;
    const change = existing ? ('changed' as const) : ('new' as const);
    for (const found of await pluginEntries(plugin, validate)) entries.push({ ...found, change });
  }
  return entries;
}
