/**
 * Reading Claude Code settings and command lines: the commands a `settings.json` runs and
 * the words and program of a command. Pure text rules, no file access (SOLID-05).
 */
import * as z from 'zod';

import { PACKAGE_RUNNERS, RUNTIME_COMMANDS } from './global-paths.ts';

const HookCommandSchema = z.looseObject({ command: z.string().optional() });
const SettingsSchema = z.looseObject({
  hooks: z
    .record(
      z.string(),
      z.array(z.looseObject({ hooks: z.array(HookCommandSchema).optional() })).optional(),
    )
    .optional(),
  statusLine: HookCommandSchema.optional(),
});

/** Parsed settings JSON, or `null` when the text is not a JSON object. */
export function parseSettings(settingsJson: string): Record<string, unknown> | null {
  try {
    const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(settingsJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Commands in a `settings.json` that run files: every hook, and the status line. */
export function commandsInSettings(settingsJson: string): string[] {
  const settings = SettingsSchema.safeParse(parseSettings(settingsJson));
  if (!settings.success) return [];
  const commands = Object.values(settings.data.hooks ?? {}).flatMap((groups) =>
    (groups ?? []).flatMap((group) => (group.hooks ?? []).map((hook) => hook.command)),
  );
  commands.push(settings.data.statusLine?.command);
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
