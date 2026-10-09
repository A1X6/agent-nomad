import { sameBytes } from '@agentnomad/contracts';
import * as z from 'zod';

import type { CollectedFile, ReviewedEntry, RunnableEntry } from '../adapter.ts';
import { parseJsonWith, valueOrNull } from '../../system/json.ts';
import { hookEntries, serverEntries } from './command-review.ts';
import { PLUGIN_GENERATED_PATHS } from './global-paths.ts';

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

/** The bundle path is or is inside something Claude Code generates in a plugin folder (T95). */
export function isPluginGenerated(bundlePath: string): boolean {
  const segments = bundlePath.split('/');
  return PLUGIN_GENERATED_PATHS.some((generated) => {
    const parts = generated.split('/');
    for (let start = 0; start + parts.length <= segments.length; start += 1) {
      if (parts.every((part, index) => segments[start + index] === part)) return true;
    }
    return false;
  });
}

/** A skill folder's bundle path prefix (`skills/` or `.claude/skills/`) and the plugin's name. */
const PLUGIN_FOLDER = /^((?:\.claude\/)?skills\/)([^/]+)\//;

const Json = z.record(z.string(), z.unknown());
/**
 * The manifest fields this module reads, in the shapes Claude Code's manifest reference
 * gives: `hooks` is a file path, an inline event map, or an array mixing both; `mcpServers`
 * is a `.json` file path, an MCP bundle path or URL (`.mcpb`, `.dxt`), an inline map, or an
 * array mixing them.
 */
const ManifestSchema = z.looseObject({
  hooks: z.union([z.string(), Json, z.array(z.union([z.string(), Json]))]).optional(),
  mcpServers: z.union([z.string(), Json, z.array(z.union([z.string(), Json]))]).optional(),
});
const HooksFileSchema = z.looseObject({ modules: z.array(z.string()).optional() });

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
}

/** A path the manifest names, relative to the plugin folder (`./hooks/x.json` → `hooks/x.json`). */
const insideFolder = (relative: string) => relative.replace(/^\.\//, '');

const isBundle = (value: string) => /\.(mcpb|dxt)$/i.test(value) || /^https?:\/\//i.test(value);

/** A JSON object file of the plugin, or `null`. */
const jsonFileOf = (byPath: ReadonlyMap<string, CollectedFile>, relative: string) => {
  const file = byPath.get(relative);
  return file === undefined ? null : valueOrNull(parseJsonWith(Json, file.content));
};

/** An MCP file's servers: under `mcpServers`, or the whole file when the wrapper is left out. */
const serversIn = (json: Record<string, unknown>) =>
  'mcpServers' in json ? json['mcpServers'] : json;

/**
 * The plugin folders among `files`: each `skills/<name>/` with a manifest, with the hooks and
 * MCP servers it declares (the default files, and whatever the manifest names) and its modules.
 */
export function pluginFolders(files: readonly CollectedFile[]): PluginFolder[] {
  const byFolder = new Map<string, CollectedFile[]>();
  for (const file of files) {
    const match = PLUGIN_FOLDER.exec(file.path);
    if (match === null || match[2] === 'synced') continue;
    const folder = `${match[1] ?? ''}${match[2] ?? ''}/`;
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
  }
  const plugins: PluginFolder[] = [];
  for (const [folder, inside] of byFolder) {
    const manifestFile = inside.find((file) => file.path === folder + MANIFEST_PATH);
    if (manifestFile === undefined) continue;
    const byPath = new Map(inside.map((file) => [file.path.slice(folder.length), file]));
    const manifest = valueOrNull(parseJsonWith(ManifestSchema, manifestFile.content));

    const hooks: HooksSource[] = [];
    const modules: string[] = [];
    // A hooks file wraps the event map in `hooks` (a file without the wrapper does not load).
    const hooksFile = (relative: string) => {
      const json = jsonFileOf(byPath, relative);
      if (json === null) return;
      hooks.push({ label: relative, hooks: json['hooks'] });
      const named = HooksFileSchema.safeParse(json);
      if (named.success) modules.push(...(named.data.modules ?? []));
    };
    hooksFile(DEFAULT_HOOKS_PATH);
    const declaredHooks = manifest?.hooks;
    for (const item of Array.isArray(declaredHooks) ? declaredHooks : [declaredHooks]) {
      if (typeof item === 'string') hooksFile(insideFolder(item));
      // An inline object is the event map itself, with no wrapper.
      else if (item !== undefined) hooks.push({ label: MANIFEST_PATH, hooks: item });
    }

    const servers: ServerSource[] = [];
    const mcpJson = jsonFileOf(byPath, DEFAULT_MCP_PATH);
    if (mcpJson !== null) servers.push({ label: DEFAULT_MCP_PATH, servers: serversIn(mcpJson) });
    const declaredServers = manifest?.mcpServers;
    for (const item of Array.isArray(declaredServers) ? declaredServers : [declaredServers]) {
      if (item === undefined) continue;
      if (typeof item !== 'string') servers.push({ label: MANIFEST_PATH, servers: item });
      else if (isBundle(item)) servers.push({ label: MANIFEST_PATH, bundle: item });
      else {
        const json = jsonFileOf(byPath, insideFolder(item));
        // A file that is not there or not JSON is shown as it is named, never dropped (SEC-01).
        servers.push({
          label: insideFolder(item),
          servers: json === null ? item : serversIn(json),
        });
      }
    }

    plugins.push({
      folder,
      name: folder.split('/').at(-2) ?? '',
      files: inside,
      hooks,
      servers,
      modules: [...new Set(modules)],
    });
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

/** The report `claude plugin validate --json` prints; only what the review reads is checked. */
const Problem = z.looseObject({ path: z.string().nullable().optional(), message: z.string() });
const ReportSchema = z.looseObject({
  manifest: z.looseObject({ errors: z.array(Problem).catch([]) }).optional(),
  contents: z
    .array(
      z.looseObject({
        type: z.string(),
        errors: z.array(Problem).catch([]),
        notes: z.array(z.string()).catch([]),
      }),
    )
    .catch([]),
});

/** `./register.ts hooks: a, b` and `./register.ts calls: $.x, $.y`, as validate notes them (T95). */
const NOTE = /^(\S+) (hooks|calls): (.*)$/;

/** The report as the review uses it; `null` when `stdout` is not one. */
export function readValidateReport(stdout: string): PluginValidation | null {
  const report = valueOrNull(parseJsonWith(ReportSchema, stdout.trim()));
  if (report === null) return null;
  const errors = [
    ...(report.manifest?.errors ?? []),
    ...report.contents.flatMap((content) => content.errors),
  ].map((problem) => (problem.path ? `${problem.path}: ${problem.message}` : problem.message));
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
  const entries: RunnableEntry[] = [];
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
  const hereFolders = new Set(
    current.flatMap((file) => {
      const match = PLUGIN_FOLDER.exec(file.path);
      return match === null ? [] : [`${match[1] ?? ''}${match[2] ?? ''}/`];
    }),
  );
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
