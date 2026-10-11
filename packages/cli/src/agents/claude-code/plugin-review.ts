import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { sameBytes } from '@agentnomad/contracts';
import * as z from 'zod';

import { isJsonObject, parseJsonWith, valueOrNull } from '../../system/json.ts';
import { printable, printableLine } from '../../ui/printable.ts';
import type { Prompter, Reporter } from '../../ui/prompter.ts';
import type { CollectedFile } from '../adapter.ts';
import type { ExecutableLookupSystem } from '../shared/detector-system.ts';
import { describeServer } from './command-review.ts';
import { findClaudeExecutable } from './detector.ts';
import { createProgramCli, type ProgramCli } from './plugin-sync.ts';
import { riskOfCall } from './reviewed-settings.ts';
import { commandText, hookItems } from './settings-commands.ts';
import {
  hasManifest,
  isRunsCodePath,
  PLUGIN_HOOKS,
  PLUGIN_MANIFEST,
  RUNS_CODE,
  samePluginPath,
} from './skills-dir-plugins.ts';

/*
 * The pull review of a plugin or mod folder (T97, T44 rule), shared by every place pull writes
 * one (T98, T99, T101): `claude plugin validate --json` on a copy pull makes itself, its
 * `hooks:`, `calls:` and `writes:` lines, the risky calls, classic command hooks, and the
 * servers and monitors Claude Code starts from the folder (SEC-02), which validate does not
 * list. A folder with code needs a yes, or --allow-commands; --yes alone never accepts it.
 */

/** A plugin folder pull is about to write. */
export interface PluginFolderToReview {
  /** How Claude Code names it, e.g. `probe-mod@skills-dir`. */
  readonly id: string;
  /** Where it goes, as shown, e.g. `skills/probe-mod`. */
  readonly folder: string;
  /** Its files, with paths from the plugin folder (`.claude-plugin/plugin.json`, …). */
  readonly files: readonly CollectedFile[];
}

/** What `claude plugin validate` said about a folder, or why it could not be asked. */
type PluginValidation =
  | {
      readonly kind: 'checked';
      /** Exit 0: passed (also with warnings). */
      readonly passed: boolean;
      /** Its errors, as `<path>: <message>`. */
      readonly errors: readonly string[];
      /** Every entry's `notes`: the `hooks:` and `calls:` line of each module. */
      readonly notes: readonly string[];
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** Runs `claude plugin validate` on a plugin folder's files. */
export interface PluginValidator {
  validate(folder: PluginFolderToReview): Promise<PluginValidation>;
}

const IssueSchema = z.looseObject({ path: z.string().optional(), message: z.string() });
const EntrySchema = z.looseObject({
  errors: z.array(IssueSchema).optional(),
  notes: z.array(z.string()).optional(),
});
const ReportSchema = z.looseObject({
  success: z.boolean(),
  manifest: EntrySchema.optional(),
  contents: z.array(EntrySchema).optional(),
});

/** A relative path that stays inside the folder it is written to. */
const staysInside = (path: string) =>
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

/**
 * Runs the found `claude` with `CLAUDE_CONFIG_DIR` set to `configDir`, an empty folder of the
 * review's own: Claude Code rewrites settings when it starts (2.1.296 turned `"model": "opus"`
 * into `"opus[1m]"`), and pull's review must leave this PC's setup as it is (T97).
 */
type ValidateCli = (configDir: string) => ProgramCli;

/**
 * A validator running `claude plugin validate --json` (`claude`: how to run the found program,
 * `null` when Claude Code is not installed here) on a copy of the folder that pull writes into
 * a new temporary folder of its own, never on a path read from the bundle. Paths of that copy
 * are shown as the folder's own (`skills/probe-mod`).
 */
function createPluginValidator(claude: ValidateCli | null): PluginValidator {
  return {
    async validate(folder) {
      if (claude === null) {
        return { kind: 'unavailable', reason: 'Claude Code is not installed here' };
      }
      const temp = await mkdtemp(join(tmpdir(), 'agentnomad-plugin-review-'));
      try {
        const copy = join(temp, 'plugin');
        const configDir = join(temp, 'config');
        await mkdir(configDir);
        try {
          for (const file of folder.files) {
            if (!staysInside(file.path)) continue;
            const path = join(copy, ...file.path.split('/'));
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, file.content);
          }
        } catch (error) {
          // E.g. a name this OS cannot hold: the folder is then unreviewed, never a crash.
          const reason = error instanceof Error ? error.message : String(error);
          return {
            kind: 'unavailable',
            reason: `its files could not be copied to check them (${reason})`,
          };
        }
        const run = await claude(configDir).run(['plugin', 'validate', '--json', copy], temp);
        const report =
          run.exitCode === 0 || run.exitCode === 1
            ? valueOrNull(parseJsonWith(ReportSchema, run.stdout))
            : null;
        if (report === null) {
          const said = run.stderr.trim().split('\n')[0] ?? '';
          return {
            kind: 'unavailable',
            reason: `\`claude plugin validate\` gave no report (exit code ${String(run.exitCode)}${said === '' ? '' : `: ${said}`})`,
          };
        }
        const shown = (text: string) =>
          text.split(copy).join(folder.folder).split(copy.replace(/\\/g, '/')).join(folder.folder);
        const entries = [...(report.manifest ? [report.manifest] : []), ...(report.contents ?? [])];
        return {
          kind: 'checked',
          passed: run.exitCode === 0 && report.success,
          errors: entries.flatMap((entry) =>
            (entry.errors ?? []).map((issue) =>
              shown(issue.path === undefined ? issue.message : `${issue.path}: ${issue.message}`),
            ),
          ),
          notes: entries.flatMap((entry) => (entry.notes ?? []).map(shown)),
        };
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
  };
}

/** `claude plugin validate` gets this long before the folder counts as unreviewed. */
const VALIDATE_TIMEOUT_MS = 60_000;

/**
 * The validator of this PC's Claude Code, found as the plugin reinstall finds it; without
 * one, every folder is unreviewed. `cli` runs the found program with an environment
 * (injected in tests).
 */
export async function findPluginValidator(
  system: ExecutableLookupSystem,
  cli: (path: string, env: Readonly<Record<string, string | undefined>>) => ProgramCli = (
    path,
    env,
  ) =>
    createProgramCli(path, { platform: system.platform, env }, { timeoutMs: VALIDATE_TIMEOUT_MS }),
): Promise<PluginValidator> {
  const claude = await findClaudeExecutable(system);
  return createPluginValidator(
    claude === null
      ? null
      : (configDir) => cli(claude, { ...system.env, CLAUDE_CONFIG_DIR: configDir }),
  );
}

/** One module of a mod: what it hooks into and the `$` methods it calls. */
interface ModuleReview {
  /** As validate names it, e.g. `./register.ts`. */
  readonly module: string;
  readonly hooks: readonly string[];
  readonly calls: readonly string[];
  /** The risky calls with what they do, e.g. `$.process.spawn (runs programs)`. */
  readonly risky: readonly string[];
  /** The environment variables and state it writes, e.g. `env writes: FOO` (SEC-04). */
  readonly writes: readonly string[];
}

/** What the review found in one plugin folder. */
export interface PluginReview {
  readonly id: string;
  readonly folder: string;
  readonly validation: PluginValidation;
  readonly modules: readonly ModuleReview[];
  /**
   * Classic command hooks in `hooks/hooks.json` and `plugin.json`, e.g.
   * `hook Stop: bash notify.sh`.
   */
  readonly commandHooks: readonly string[];
  /**
   * What Claude Code starts from the folder by itself (SEC-02): MCP and LSP servers and
   * monitors, e.g. `monitor watch: bash watch.sh`.
   */
  readonly starts: readonly string[];
  /** It runs code inside Claude Code, or could not be checked: it needs a yes. */
  readonly runsCode: boolean;
}

const NOTE = /^(.+?) (hooks|calls|env writes|state writes): (.*)$/;

/** What validate writes on a `calls:` line when a module calls no `$` method. */
const NO_CALLS = 'nothing on $';

/**
 * A note's list, split on commas outside `{…}` and `(…)` (`tool.call{tool=Bash}`,
 * `$.tool.call (via run, again)`).
 */
function listed(text: string): string[] {
  if (text.trim() === NO_CALLS) return [];
  const parts: string[] = [];
  let depth = 0;
  let part = '';
  for (const char of text) {
    if (char === '{' || char === '(') depth += 1;
    if (char === '}' || char === ')') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(part);
      part = '';
    } else part += char;
  }
  parts.push(part);
  return parts.map((item) => item.trim()).filter((item) => item !== '');
}

/** A path of the folder from these parts (`..` goes up); `null` when it leaves the folder. */
function insideFolder(path: readonly string[]): string | null {
  const parts: string[] = [];
  for (const part of path) {
    if (part === '' || part === '.') continue;
    if (part !== '..') parts.push(part);
    else if (parts.pop() === undefined) return null;
  }
  return parts.join('/');
}

/**
 * A module's file in the folder: validate names modules as `hooks/hooks.json` does, from the
 * `hooks/` folder (`./register.ts` is `hooks/register.ts`); `null` when it leaves the folder.
 */
const moduleFile = (module: string) => insideFolder(['hooks', ...module.split('/')]);

/** The modules in validate's notes, in the order it lists them. */
function modulesOf(notes: readonly string[]): ModuleReview[] {
  const modules = new Map<string, { hooks: string[]; calls: string[]; writes: string[] }>();
  for (const note of notes) {
    const match = NOTE.exec(note);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) continue;
    const found = modules.get(match[1]) ?? { hooks: [], calls: [], writes: [] };
    if (match[2] === 'hooks' || match[2] === 'calls') found[match[2]].push(...listed(match[3]));
    else if (match[3].trim() !== 'nothing') found.writes.push(`${match[2]}: ${match[3]}`);
    modules.set(match[1], found);
  }
  return [...modules].map(([module, found]) => ({
    module,
    ...found,
    risky: found.calls.flatMap((call) => {
      const does = riskOfCall(call);
      return does === null ? [] : [`${call} (${does})`];
    }),
  }));
}

/** The MCP servers, LSP servers and monitors a plugin has without naming them in its manifest. */
const MCP_FILE = '.mcp.json';
const LSP_FILE = '.lsp.json';
const MONITORS_FILE = 'monitors/monitors.json';

/** A part a manifest key declares: inline (`from` names the key) or from a file. */
interface Declared {
  readonly from: string;
  readonly value: unknown;
}

/**
 * The folder's JSON files at `path` as a manifest names it (`./config/servers.json`), in any
 * case (review 16 SEC-01): Windows and macOS open `Hooks/hooks.json` as `hooks/hooks.json`.
 * Each with its value, `null` when it cannot be read; `from` is `path`, or the file's own
 * spelling when that differs. None when the folder has no such file.
 */
function jsonsAt(files: readonly CollectedFile[], path: string): Declared[] {
  const at = insideFolder(path.split('/'));
  if (at === null) return [];
  return files
    .filter((entry) => samePluginPath(entry.path, at))
    .map((entry) => ({
      from: entry.path === at ? path : entry.path,
      value: valueOrNull(parseJsonWith(z.unknown(), entry.content)),
    }));
}

/**
 * What the manifest's `key` declares, then the `file` Claude Code reads with it (`beside`) or
 * only without it: each inline value, and each file named by a path (a list when `list`).
 */
function declared(
  files: readonly CollectedFile[],
  manifest: Record<string, unknown> | null,
  key: string,
  file: { readonly path: string; readonly beside: boolean; readonly list: boolean },
): Declared[] {
  const value = manifest?.[key];
  const items: unknown[] =
    value === undefined ? [] : file.list && Array.isArray(value) ? value : [value];
  const parts = items.flatMap((item): Declared[] => {
    if (typeof item !== 'string') return [{ from: `${PLUGIN_MANIFEST} ${key}`, value: item }];
    const found = jsonsAt(files, item);
    return found.length === 0 ? [{ from: item, value: undefined }] : found;
  });
  if (value === undefined || file.beside) parts.push(...jsonsAt(files, file.path));
  return parts;
}

/**
 * The MCP and LSP servers and monitors Claude Code starts from the folder (SEC-02), each with
 * its command; a file the manifest names that is not in the folder (an MCPB file or a URL) is
 * shown by its path.
 */
function startsOf(files: readonly CollectedFile[], manifest: Record<string, unknown> | null) {
  const lines: string[] = [];
  const servers = (label: string, part: Declared, wrapper: string | null) => {
    if (part.value === undefined) return lines.push(`${label}s from ${part.from}`);
    const inner = wrapper === null || !isJsonObject(part.value) ? undefined : part.value[wrapper];
    const all = isJsonObject(inner) ? inner : part.value;
    if (!isJsonObject(all)) return lines.push(`${label}s in ${part.from} (unreadable)`);
    for (const [name, server] of Object.entries(all)) {
      lines.push(
        isJsonObject(server)
          ? `${label} ${name}: ${describeServer(server)}`
          : `${label} ${name} (unreadable)`,
      );
    }
    return lines.length;
  };
  const mcp = { path: MCP_FILE, beside: true, list: true };
  for (const part of declared(files, manifest, 'mcpServers', mcp)) {
    servers('MCP server', part, 'mcpServers');
  }
  const lsp = { path: LSP_FILE, beside: true, list: true };
  for (const part of declared(files, manifest, 'lspServers', lsp)) {
    servers('LSP server', part, null);
  }
  const monitorsFile = { path: MONITORS_FILE, beside: false, list: false };
  for (const part of declared(files, manifest, 'monitors', monitorsFile)) {
    if (part.value === undefined) lines.push(`monitors from ${part.from}`);
    else if (!Array.isArray(part.value)) lines.push(`monitors in ${part.from} (unreadable)`);
    else {
      for (const monitor of part.value) {
        const name = isJsonObject(monitor) ? monitor['name'] : undefined;
        lines.push(
          isJsonObject(monitor) && typeof name === 'string'
            ? `monitor ${name}: ${describeServer(monitor)}`
            : 'monitor (unreadable)',
        );
      }
    }
  }
  return lines;
}

/**
 * Classic command hooks in the folder's `hooks/hooks.json` and those its manifest declares
 * (SEC-02), read as settings hooks are (T44).
 */
function commandHooksOf(
  files: readonly CollectedFile[],
  manifest: Record<string, unknown> | null,
): string[] {
  const hooksFile = { path: PLUGIN_HOOKS, beside: true, list: true };
  return declared(files, manifest, 'hooks', hooksFile).flatMap((part) => {
    if (part.value === undefined) return [`hooks from ${part.from}`];
    if (!isJsonObject(part.value)) return [`${part.from} (unreadable)`];
    // A hooks file holds `hooks` (and a mod's `modules`); the manifest may hold the events.
    const inline =
      !samePluginPath(part.from, PLUGIN_HOOKS) &&
      !('hooks' in part.value || 'modules' in part.value);
    return commandHookLines(inline ? part.value : part.value['hooks']);
  });
}

/** The command and HTTP hooks of a `hooks` block, as the review shows them. */
function commandHookLines(hooks: unknown): string[] {
  return hookItems(hooks).flatMap((item) => {
    if (!('hook' in item)) {
      return [item.event === null ? 'hooks (unreadable)' : `hook ${item.event} (unreadable)`];
    }
    const { event, hook } = item;
    if (hook.command !== undefined)
      return [`hook ${event}: ${commandText(hook.command, hook.args)}`];
    if (hook.type === 'http' && hook.url !== undefined) {
      return [`hook ${event} (sends data to): ${hook.url}`];
    }
    return [];
  });
}

/**
 * Reviews one plugin folder: validate's report, its modules and its command hooks. Every
 * manifest in the folder is read, in any case (review 16 SEC-01), and a case variant of a part
 * Claude Code starts programs from counts as that part on every OS.
 */
export async function reviewPluginFolder(
  folder: PluginFolderToReview,
  validator: PluginValidator,
): Promise<PluginReview> {
  const validation = await validator.validate(folder);
  const modules = validation.kind === 'checked' ? modulesOf(validation.notes) : [];
  const manifests = jsonsAt(folder.files, PLUGIN_MANIFEST).flatMap((part) =>
    isJsonObject(part.value) ? [part.value] : [],
  );
  const each = manifests.length === 0 ? [null] : manifests;
  // A file beside two manifests is read for each: shown once.
  const commandHooks = [
    ...new Set(each.flatMap((manifest) => commandHooksOf(folder.files, manifest))),
  ];
  const starts = [...new Set(each.flatMap((manifest) => startsOf(folder.files, manifest)))];
  const runsCode =
    validation.kind === 'unavailable' ||
    !validation.passed ||
    modules.length > 0 ||
    commandHooks.length > 0 ||
    starts.length > 0 ||
    folder.files.some((file) => isRunsCodePath(file.path)) ||
    manifests.some((manifest) => RUNS_CODE.manifestKeys.some((key) => manifest[key] !== undefined));
  return {
    id: folder.id,
    folder: folder.folder,
    validation,
    modules,
    commandHooks,
    starts,
    runsCode,
  };
}

/** The review as pull shows it: one block for the folder, each line printable. */
function pluginReviewLines(review: PluginReview, change: 'new' | 'changed'): string[] {
  const { validation } = review;
  const status =
    validation.kind === 'unavailable'
      ? `not checked: ${validation.reason}; treated as unreviewed code`
      : validation.passed
        ? 'claude plugin validate: passed'
        : 'claude plugin validate: failed, the plugin is broken';
  return [
    `  ${change === 'new' ? '+' : '~'} ${review.id} (${review.folder})${change === 'changed' ? '  (changed)' : ''}`,
    `      ${status}`,
    ...(validation.kind === 'checked' ? validation.errors.map((error) => `      ✘ ${error}`) : []),
    ...review.modules.flatMap((module) => [
      `      ${module.module} hooks: ${module.hooks.join(', ')}`,
      `      ${module.module} calls: ${module.calls.join(', ')}`,
      ...module.writes.map((writes) => `      ${module.module} ${writes}`),
      ...(module.risky.length > 0 ? [`      ⚠ ${module.module}: ${module.risky.join(', ')}`] : []),
    ]),
    ...review.commandHooks.map((hook) => `      ${hook}`),
    ...review.starts.map((started) => `      ${started}`),
  ].map(printableLine);
}

/** The answers and flags of pull's plan step that the gate needs. */
export interface PluginGateContext {
  readonly prompter: Prompter;
  readonly reporter: Reporter;
  /** `--yes`: never accepts a folder with code. */
  readonly assumeYes: boolean;
  /** `--allow-commands`: accepts a folder with code that validate passed. */
  readonly allowCommands: boolean;
}

/** The module files whose risky calls the user may read before answering. */
const riskyModuleFiles = (review: PluginReview, folder: PluginFolderToReview) =>
  review.modules
    .filter((module) => module.risky.length > 0)
    .flatMap((module) => {
      const path = moduleFile(module.module);
      const file = folder.files.find((entry) => entry.path === path);
      return file ? [{ module: module.module, file }] : [];
    });

/**
 * Shows the review of each folder and asks before writing one with code (T97): a person's yes
 * or --allow-commands accepts it; --yes alone never does. A broken folder (validate exit 1) is
 * written only after a person's yes. Returns the folders to write.
 */
export async function askPluginFolders(
  folders: readonly { readonly folder: PluginFolderToReview; readonly change: 'new' | 'changed' }[],
  validator: PluginValidator,
  context: PluginGateContext,
): Promise<Set<string>> {
  const { prompter, reporter } = context;
  const accepted = new Set<string>();
  for (const { folder, change } of folders) {
    const review = await reviewPluginFolder(folder, validator);
    reporter.info(
      [
        'This plugin would be added or changed; a plugin with hooks runs code inside Claude Code:',
        ...pluginReviewLines(review, change),
      ].join('\n'),
    );
    if (!review.runsCode) {
      accepted.add(folder.folder);
      continue;
    }
    const broken = review.validation.kind === 'checked' && !review.validation.passed;
    const name = printableLine(review.id);
    if (!broken && context.allowCommands) {
      accepted.add(folder.folder);
      continue;
    }
    if (context.assumeYes) {
      reporter.warn(
        broken
          ? `Skipped ${printableLine(folder.folder)}: ${name} is broken, and only a yes from you writes it. Run pull without --yes to choose.`
          : `Skipped ${printableLine(folder.folder)}: ${name} runs code inside Claude Code. --yes never accepts a plugin with code; add --allow-commands to accept it.`,
      );
      continue;
    }
    for (const { module, file } of riskyModuleFiles(review, folder)) {
      const show = await prompter.confirm(
        `Show the source of ${printableLine(module)} in ${name}?`,
        false,
      );
      if (show) reporter.info(printable(new TextDecoder().decode(file.content)));
    }
    const question = broken
      ? `Write ${name} anyway? claude plugin validate found errors, so Claude Code may not load it.`
      : `Write ${name}? It runs code inside Claude Code.`;
    if (await prompter.confirm(question, false)) accepted.add(folder.folder);
    else reporter.warn(`Skipped ${printableLine(folder.folder)}. The rest is restored.`);
  }
  return accepted;
}

/**
 * Whether `folder` would be new or changed in `dir`, where pull writes it: `null` when every
 * file is already there with the same bytes, `changed` when some of them are there.
 */
export async function pluginFolderChange(
  dir: string,
  folder: PluginFolderToReview,
): Promise<'new' | 'changed' | null> {
  let differs = false;
  let found = false;
  for (const file of folder.files) {
    const here = staysInside(file.path)
      ? await readFile(join(dir, ...file.path.split('/'))).catch(() => null)
      : null;
    if (here !== null) found = true;
    if (here === null || !sameBytes(here, file.content)) differs = true;
  }
  if (!differs) return null;
  return found ? 'changed' : 'new';
}

/**
 * The folder with the manifest and the parts that start programs that it has in `dir`, where
 * pull writes it, and that its own files lack (review 16 SEC-02): a lone `hooks/hooks.json`
 * adds command hooks to a plugin already there, and a lone manifest makes a plugin of hooks
 * already there. `null` when neither has a manifest: not a plugin, so Claude Code runs nothing
 * from it.
 */
export async function withPartsHere(
  dir: string,
  folder: PluginFolderToReview,
): Promise<PluginFolderToReview | null> {
  const parts = [PLUGIN_MANIFEST, ...RUNS_CODE.files];
  for (const part of RUNS_CODE.folders) {
    const entries = await readdir(join(dir, part), { withFileTypes: true }).catch(() => []);
    parts.push(
      ...entries.filter((entry) => entry.isFile()).map((entry) => `${part}/${entry.name}`),
    );
  }
  const here: CollectedFile[] = [];
  for (const part of parts) {
    if (folder.files.some((file) => samePluginPath(file.path, part))) continue;
    const content = await readFile(join(dir, ...part.split('/'))).catch(() => null);
    if (content !== null) here.push({ path: part, content, executable: false });
  }
  const files = [...folder.files, ...here];
  return hasManifest(files) ? { ...folder, files } : null;
}
