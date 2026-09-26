import {
  AgentIdSchema,
  ProjectNameSchema,
  UsernameSchema,
  type AgentId,
} from '@agentnomad/contracts';
import { InvalidArgumentError } from '@commander-js/extra-typings';

/** `--agent claude-code,codex`: validated agent ids, in order, without repeats. */
export function parseAgentList(value: string): AgentId[] {
  const ids = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (ids.length === 0)
    throw new InvalidArgumentError('Give at least one agent, e.g. claude-code.');
  for (const id of ids) {
    if (!AgentIdSchema.safeParse(id).success) {
      throw new InvalidArgumentError(
        `"${id}" is not a valid agent id (lowercase letters, digits and dashes, e.g. claude-code).`,
      );
    }
  }
  return [...new Set(ids)];
}

/** `--project <name>`: the same rules the bundle format uses for project names. */
export function parseProjectName(value: string): string {
  const parsed = ProjectNameSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError(parsed.error.issues[0]?.message ?? 'Invalid project name.');
  }
  return parsed.data;
}

/** `--username <name>`: the same rules as the server's usernames. */
export function parseUsername(value: string): string {
  const parsed = UsernameSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError(parsed.error.issues[0]?.message ?? 'Invalid username.');
  }
  return parsed.data;
}
