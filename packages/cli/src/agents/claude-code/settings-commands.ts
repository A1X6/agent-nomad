/**
 * Reading Claude Code settings and command lines: the commands a `settings.json` runs and
 * the words and program of a command. Pure text rules, no file access (SOLID-05).
 */
import * as z from 'zod';

import { parseJsonWith, valueOrNull } from '../../system/json.ts';
import { PACKAGE_RUNNERS, RUNTIME_COMMANDS } from './global-paths.ts';

const JsonObject = z.record(z.string(), z.unknown());
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
  const events = JsonObject.safeParse(hooks);
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
  return valueOrNull(parseJsonWith(JsonObject, settingsJson));
}

/**
 * Commands in a `settings.json` that run files: every hook, and the status line. A hook that
 * cannot be read is left out on its own (SEC-01).
 */
export function commandsInSettings(settingsJson: string): string[] {
  const settings = parseSettings(settingsJson);
  if (settings === null) return [];
  const commands = hookItems(settings['hooks']).map((item) =>
    'hook' in item ? item.hook.command : undefined,
  );
  const statusLine = HookCommandSchema.safeParse(settings['statusLine']);
  commands.push(statusLine.success ? statusLine.data.command : undefined);
  return commands.filter((command): command is string => command !== undefined);
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

/** `ccstatusline@2.2.22` → `ccstatusline`; `@scope/tool@1` → `@scope/tool`. */
const withoutVersion = (spec: string) => spec.replace(/(?<=.)@[^/]*$/, '');

/**
 * The program a command starts, e.g. `ccstatusline`, or `ccstatusline` for
 * `npx -y ccstatusline@latest` (`runner`: nothing to install). `null` for a script path,
 * a shell or a runtime.
 */
export function programOf(command: string): { name: string; runner: boolean } | null {
  const words = commandWords(command);
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
