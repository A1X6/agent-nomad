import type { AgentContents } from '../agents/adapter.ts';

/**
 * The words the command line uses to say what each command does, what each flag saves or
 * restores, and why a question is asked (T115): one source for `--help`, the questions push
 * and pull ask, and the README, so they cannot drift apart. program.test.ts checks the README
 * Commands and "What is synced" tables against it.
 */

/** One plain line per command: what it does to the user's files. */
export const COMMAND_HELP = {
  register: 'create an account (there is no password recovery)',
  login: 'log in on this PC, so push and pull can reach your saved setups',
  logout: 'log out on this PC (your files and saved setups stay as they are)',
  push: 'save your agent setup (settings, skills, hooks…) to your account, encrypted on this PC first',
  pull: 'write a saved setup onto this PC, asking before anything new runs (a project goes into the current folder)',
  list: 'show your saved setups, grouped by agent (changes nothing)',
  agents: 'show the supported agents and which are installed here (changes nothing)',
  status: 'show whether this PC matches your saved setups (changes nothing)',
  delete: 'delete saved setups from your account (files on your PCs are not touched)',
  account: 'manage your account',
  'account delete': 'delete your account and every saved setup (cannot be undone)',
  env: 'show which environment variables your setups use and which are set here (never their values)',
} as const;

/** What `--env-values` takes: names, comma-separated, or one of these two words. */
export const ENV_VALUES_ALL = 'all';
export const ENV_VALUES_NONE = 'none';

/**
 * The help of every flag push and pull share with a question, in the question's own words.
 * The optional parts' flags carry their own help (`OptionalPart.flagHelp`).
 */
export const FLAG_HELP = {
  agent: 'which agents to work on, comma-separated (e.g. claude-code); asked when not given',
  global: "the global setup: the agent's own folder in your home (e.g. ~/.claude)",
  project:
    "a project setup, by the name it was saved under (push: this folder's project; pull: written into this folder)",
  memory:
    "save the agent's memory, what it learned about you and your projects, from its folder (the global setup takes every project's, a project only its own)",
  noMemory: 'leave memory out',
  envValues: {
    push: `save these environment variable values with your setup (encrypted; only you can read them): names comma-separated, ${ENV_VALUES_ALL} (every one the setup uses and this PC has) or ${ENV_VALUES_NONE}`,
    pull: `add these saved environment variable values to this PC (shell profile or Windows user variables): names comma-separated, ${ENV_VALUES_ALL} or ${ENV_VALUES_NONE}`,
  },
  merge:
    'every file here that differs from the saved one: merge them (JSON by key, other files kept with the saved copy next to them)',
  overwrite:
    'every file here that differs from the saved one: replace it with the saved copy (the old one is backed up)',
  skipExisting: 'every file here that differs from the saved one: leave it as it is',
  allowCommands:
    'accept new or changed hooks, MCP servers and scripts, and install plugins and programs (--yes alone skips them)',
  yes: {
    push: "answer every question with its default instead of asking: the global setup, no memory, no environment values, each optional part's default",
    pull: 'answer every question with its default instead of asking: the global setup, merge files that differ, add missing plain environment values; never new commands or installs',
    delete:
      'delete without the last confirmation (which setups is still asked unless --global or --project names them)',
  },
} as const;

/** Why push and pull ask each of their own questions, said with the question. */
export const QUESTION_REASON = {
  agents: "Each agent's setup is saved and restored on its own.",
  scopePush:
    'The global setup follows you to every PC; a project setup belongs to the folder it is in.',
  scopePull: 'The global setup goes into your home; a project goes into this folder.',
  memory:
    'It is what the agent learned about you and your projects, so it is left out unless you say yes.',
  envValuesPush:
    'Your setup uses them (e.g. API keys); a saved value is encrypted and only you can read it. None are saved unless you tick them.',
  envValuesPull: (one: boolean) =>
    `The setup uses ${one ? 'it' : 'them'}, and ${one ? 'it is' : 'they are'} not set on this PC yet.`,
} as const;

/** The headings `push --help`, `pull --help` and push's summary group the contents under. */
export const CONTENT_GROUPS = {
  push: {
    title: 'What is saved',
    always: 'Always saved',
    chosen: 'Saved only when you choose (a question, or the flag)',
    never: 'Never saved',
  },
  pull: {
    title: 'What is restored',
    always: 'Always restored (a file here that differs is asked about first)',
    chosen: 'Restored only when you choose (a question, or the flag)',
    never: 'Never in a saved setup',
  },
} as const;

/** The longest line the help sections are wrapped to: commander's own width for options. */
const WIDTH = 80;

/** `text` after `indent`, wrapped at word boundaries; the next lines go two spaces deeper. */
function wrap(indent: string, text: string): string {
  const lines: string[] = [];
  let line = indent;
  for (const word of text.split(' ')) {
    if (line.trim() !== '' && line.length + 1 + word.length > WIDTH) {
      lines.push(line);
      line = `${indent}  ${word}`;
    } else line = line.trim() === '' ? `${line}${word}` : `${line} ${word}`;
  }
  lines.push(line);
  return lines.join('\n');
}

/** One flag of the "only when you choose" group: `--flag`, then what it saves or restores. */
export interface ChosenFlag {
  readonly flag: string;
  readonly help: string;
}

/** One agent as the help sections need it. */
export interface AgentHelp {
  readonly displayName: string;
  readonly contents: AgentContents;
}

/**
 * The "What is saved" (push) or "What is restored" (pull) section of `--help`: per agent,
 * what is always in a setup, what only goes in when the user chooses (with the flag that
 * chooses it) and what never does.
 */
export function contentsHelp(
  which: 'push' | 'pull',
  agents: readonly AgentHelp[],
  chosen: readonly ChosenFlag[],
): string {
  const groups = CONTENT_GROUPS[which];
  const item = (label: string, items: readonly string[]) =>
    wrap('    ', `${label}: ${items.join(', ')}`);
  const sections = agents.map(({ displayName, contents }) =>
    [
      `${groups.title} (${displayName}):`,
      `  ${groups.always}:`,
      item(contents.globalLabel, [...contents.global, ...contents.globalAlso]),
      item('a project', contents.project),
      `  ${groups.chosen}:`,
      ...chosen.map(({ flag, help }) => wrap('    ', `${flag}: ${help}`)),
      `  ${groups.never}:`,
      item(contents.globalLabel, [...contents.globalNever, ...contents.globalNeverAlso]),
      item('a project', contents.projectNever),
    ].join('\n'),
  );
  return sections.length === 0 ? '' : `\n${sections.join('\n\n')}`;
}
