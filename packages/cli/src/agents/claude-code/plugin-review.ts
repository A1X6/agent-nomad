import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { sameBytes } from '@agentnomad/contracts';
import * as z from 'zod';

import { JsonObjectSchema, parseJsonWith, valueOrNull } from '../../system/json.ts';
import { printable, printableLine } from '../../ui/printable.ts';
import type { Prompter, Reporter } from '../../ui/prompter.ts';
import type { CollectedFile } from '../adapter.ts';
import type { ExecutableLookupSystem } from '../shared/detector-system.ts';
import { findClaudeExecutable } from './detector.ts';
import { createProgramCli, type ProgramCli } from './plugin-sync.ts';
import { riskOfCall } from './reviewed-settings.ts';
import { commandText, hookItems } from './settings-commands.ts';
import { PLUGIN_HOOKS } from './skills-dir-plugins.ts';

/*
 * The pull review of a plugin or mod folder (T97, T44 rule), shared by every place pull writes
 * one (T98, T99, T101): `claude plugin validate --json` on a copy pull makes itself, its
 * `hooks:` and `calls:` lines, the risky calls, and classic command hooks (which validate does
 * not list). A folder with code needs a yes, or --allow-commands; --yes alone never accepts it.
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
}

/** What the review found in one plugin folder. */
export interface PluginReview {
  readonly id: string;
  readonly folder: string;
  readonly validation: PluginValidation;
  readonly modules: readonly ModuleReview[];
  /** Classic command hooks in `hooks/hooks.json`, e.g. `hook Stop: bash notify.sh`. */
  readonly commandHooks: readonly string[];
  /** It runs code inside Claude Code, or could not be checked: it needs a yes. */
  readonly runsCode: boolean;
}

const NOTE = /^(.+?) (hooks|calls): (.*)$/;

/** What validate writes on a `calls:` line when a module calls no `$` method. */
const NO_CALLS = 'nothing on $';

/** A note's list, split on commas outside `{…}` (`tool.call{tool=Bash}`). */
function listed(text: string): string[] {
  if (text.trim() === NO_CALLS) return [];
  const parts: string[] = [];
  let depth = 0;
  let part = '';
  for (const char of text) {
    if (char === '{') depth += 1;
    if (char === '}') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(part);
      part = '';
    } else part += char;
  }
  parts.push(part);
  return parts.map((item) => item.trim()).filter((item) => item !== '');
}

/**
 * A module's file in the folder: validate names modules as `hooks/hooks.json` does, from the
 * `hooks/` folder (`./register.ts` is `hooks/register.ts`); `null` when it leaves the folder.
 */
function moduleFile(module: string): string | null {
  const parts: string[] = [];
  for (const part of ['hooks', ...module.split('/')]) {
    if (part === '' || part === '.') continue;
    if (part !== '..') parts.push(part);
    else if (parts.pop() === undefined) return null;
  }
  return parts.join('/');
}

/** The modules in validate's notes, in the order it lists them. */
function modulesOf(notes: readonly string[]): ModuleReview[] {
  const modules = new Map<string, { hooks: string[]; calls: string[] }>();
  for (const note of notes) {
    const match = NOTE.exec(note);
    if (match?.[1] === undefined || match[3] === undefined) continue;
    const found = modules.get(match[1]) ?? { hooks: [], calls: [] };
    found[match[2] === 'hooks' ? 'hooks' : 'calls'].push(...listed(match[3]));
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

/** Classic command hooks in the folder's `hooks/hooks.json`, read as settings hooks are (T44). */
function commandHooksOf(files: readonly CollectedFile[]): string[] {
  const file = files.find((entry) => entry.path === PLUGIN_HOOKS);
  if (!file) return [];
  const json = valueOrNull(parseJsonWith(JsonObjectSchema, file.content));
  if (json === null) return [`${PLUGIN_HOOKS} (unreadable)`];
  return hookItems(json['hooks']).flatMap((item) => {
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

/** Reviews one plugin folder: validate's report, its modules and its command hooks. */
export async function reviewPluginFolder(
  folder: PluginFolderToReview,
  validator: PluginValidator,
): Promise<PluginReview> {
  const validation = await validator.validate(folder);
  const modules = validation.kind === 'checked' ? modulesOf(validation.notes) : [];
  const commandHooks = commandHooksOf(folder.files);
  const runsCode =
    validation.kind === 'unavailable' ||
    !validation.passed ||
    modules.length > 0 ||
    commandHooks.length > 0 ||
    folder.files.some((file) => file.path === PLUGIN_HOOKS || file.path === '.mcp.json');
  return { id: folder.id, folder: folder.folder, validation, modules, commandHooks, runsCode };
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
      ...(module.risky.length > 0 ? [`      ⚠ ${module.module}: ${module.risky.join(', ')}`] : []),
    ]),
    ...review.commandHooks.map((hook) => `      ${hook}`),
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
