/**
 * Reading Claude Code settings and command lines: the commands a `settings.json` runs and
 * the words and program of a command. Pure text rules, no file access (SOLID-05).
 */
import * as z from 'zod';

import { JsonObjectSchema, parseJsonWith, valueOrNull } from '../../system/json.ts';
import { PACKAGE_RUNNERS, RUNTIME_COMMANDS } from './global-paths.ts';

const HookSchema = z.looseObject({
  type: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
});
const HookCommandSchema = z.looseObject({ command: z.string().optional() });

/**
 * One item of a settings `hooks` block: a hook, or a part of the block that could not be
 * read (`event` `null`: the whole block).
 */
export type HookItem =
  | { readonly event: string; readonly hook: z.infer<typeof HookSchema> }
  | { readonly event: string | null; readonly unreadable: unknown };

/**
 * Every hook of a settings `hooks` block, read one by one (SEC-01): an event, group or hook
 * that does not have the expected shape comes back as `unreadable` on its own and never
 * hides the others.
 */
export function hookItems(hooks: unknown): HookItem[] {
  if (hooks === undefined) return [];
  const events = JsonObjectSchema.safeParse(hooks);
  if (!events.success) return [{ event: null, unreadable: hooks }];
  const items: HookItem[] = [];
  for (const [event, groups] of Object.entries(events.data)) {
    if (!Array.isArray(groups)) {
      items.push({ event, unreadable: groups });
      continue;
    }
    for (const group of groups) {
      const parsed = z.looseObject({ hooks: z.array(z.unknown()).optional() }).safeParse(group);
      if (!parsed.success) {
        items.push({ event, unreadable: group });
        continue;
      }
      for (const hook of parsed.data.hooks ?? []) {
        const read = HookSchema.safeParse(hook);
        items.push(read.success ? { event, hook: read.data } : { event, unreadable: hook });
      }
    }
  }
  return items;
}

/** Parsed settings JSON, or `null` when the text is not a JSON object. */
export function parseSettings(settingsJson: string): Record<string, unknown> | null {
  return valueOrNull(parseJsonWith(JsonObjectSchema, settingsJson));
}

/**
 * The words a command's program gets (BUG-01). In exec form (`args` set) Claude Code starts
 * `command` with each `args` element as one word, exactly as written and with no shell; in
 * shell form the shell splits `command`.
 */
function runWords(command: string, args: readonly string[] | undefined): string[] {
  return args === undefined ? commandWords(command) : [command, ...args];
}

/**
 * A hook's command as shown (review 6 SEC-01): in exec form each `args` element quoted, so
 * `tool "a b; c"` (one word, no shell) never prints like the shell command `tool a b; c`.
 */
export function commandText(command: string, args: readonly string[] | undefined): string {
  return args === undefined
    ? command
    : [command, ...args.map((arg) => JSON.stringify(arg))].join(' ');
}

/** A command a `settings.json` runs: as shown, and the words its program gets. */
interface SettingsCommand {
  readonly text: string;
  readonly words: string[];
}

/**
 * Commands in a `settings.json` that run files: every hook, and the status line. A hook that
 * cannot be read is left out on its own (SEC-01).
 */
export function settingsCommands(settingsJson: string): SettingsCommand[] {
  const settings = parseSettings(settingsJson);
  if (settings === null) return [];
  const commands = hookItems(settings['hooks']).flatMap((item) =>
    'hook' in item && item.hook.command !== undefined
      ? [
          {
            text: commandText(item.hook.command, item.hook.args),
            words: runWords(item.hook.command, item.hook.args),
          },
        ]
      : [],
  );
  const statusLine = HookCommandSchema.safeParse(settings['statusLine']);
  if (statusLine.success && statusLine.data.command !== undefined) {
    const command = statusLine.data.command;
    commands.push({ text: command, words: commandWords(command) });
  }
  return commands;
}

/** The commands of `settingsCommands`, as the words each one's program gets. */
export function commandsInSettings(settingsJson: string): string[][] {
  return settingsCommands(settingsJson).map((command) => command.words);
}

/**
 * Words of a command line, like a shell splits them: quoted and unquoted parts next to each
 * other form one word (`"$CLAUDE_PROJECT_DIR"/.claude/hooks/a.sh`), quotes removed.
 */
export function commandWords(command: string): string[] {
  return [...command.matchAll(/(?:"[^"]*"|'[^']*'|[^\s"']+)+/g)].map((match) =>
    match[0].replace(
      /"([^"]*)"|'([^']*)'/g,
      (_quoted, double?: string, single?: string) => double ?? single ?? '',
    ),
  );
}

/** Shell operators, which end a word without a space: `a.sh;`, `a.sh&&b`, `$(cat a.sh)`. */
const SHELL_OPERATORS = /[;&|()<>`]+/;
/** Everything that can end a word: white space, quotes and shell operators. */
const WORD_ENDS = /[\s"';&|()<>`]+/;

/**
 * Every word of a command that can name a script (SEC-01): each word; the words of a
 * command line a word carries (`bash -c "a.sh; true"`, `pwsh -Command "& 'a.ps1' -Flag"`,
 * `cmd /c "a.cmd && b"`), again inside those, at any depth; and the parts of all of them
 * between white space, quotes and shell operators. The whole words stay in, so a quoted
 * path with spaces is found too. Extra words only make the review show more, never less.
 */
export function pathWords(words: readonly string[]): string[] {
  const found = new Set<string>();
  const add = (word: string) => {
    if (word === '' || found.has(word)) return;
    found.add(word);
    for (const part of word.split(WORD_ENDS)) found.add(part);
    for (const part of word.split(SHELL_OPERATORS)) add(part);
    // Each pass removes a pair of quotes or splits the word, so this ends.
    if (/[\s"']/.test(word)) commandWords(word).forEach(add);
  };
  words.forEach(add);
  found.delete('');
  return [...found];
}

/** `ccstatusline@2.2.22` → `ccstatusline`; `@scope/tool@1` → `@scope/tool`. */
const withoutVersion = (spec: string) => spec.replace(/(?<=.)@[^/]*$/, '');

/**
 * The program a command's words start, e.g. `ccstatusline`, or `ccstatusline` for
 * `npx -y ccstatusline@latest` (`runner`: nothing to install). `null` for a script path,
 * a shell or a runtime.
 */
export function programOf(words: readonly string[]): { name: string; runner: boolean } | null {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1;
  const first = words[index];
  if (first === undefined || /[\\/]/.test(first)) return null;
  const base = first.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (PACKAGE_RUNNERS.has(base)) {
    const spec = words.slice(index + 1).find((word) => !word.startsWith('-'));
    return spec === undefined ? null : { name: withoutVersion(spec), runner: true };
  }
  if (RUNTIME_COMMANDS.has(base) || !/^[A-Za-z0-9._-]+$/.test(first)) return null;
  return { name: base, runner: false };
}
