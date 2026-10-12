import type { ChosenAgent } from '../agents/adapter.ts';
import { samePath } from '../system/paths.ts';

export interface ProjectFolderContext {
  readonly homedir: string;
  /** The agent's base folder (`~/.claude`), `null` when unknown. */
  readonly baseDir: string | null;
  readonly agentName: string;
  readonly platform: NodeJS.Platform;
}

/**
 * Why `folder` cannot be a project, or `null` when it can (BUG-05): in the home folder a
 * project's `.claude/` is the global `~/.claude/`, and the agent's own folder is the global
 * setup itself.
 */
export function projectFolderRefusal(folder: string, context: ProjectFolderContext): string | null {
  if (samePath(folder, context.homedir, context.platform)) return 'your home folder';
  if (context.baseDir !== null && samePath(folder, context.baseDir, context.platform)) {
    return `${context.agentName}'s own folder`;
  }
  return null;
}

/**
 * Why `cwd` cannot be a project of `agent` (BUG-05), or `null`, for push and pull alike;
 * throws {@link ProjectFolderError} when a project was asked for there.
 */
export function checkProjectFolder(
  cwd: string,
  agent: ChosenAgent,
  here: { readonly homedir: string; readonly platform: NodeJS.Platform },
  projectAsked: boolean,
): string | null {
  const refusal = projectFolderRefusal(cwd, {
    homedir: here.homedir,
    baseDir: agent.baseDir,
    agentName: agent.adapter.displayName,
    platform: here.platform,
  });
  if (projectAsked && refusal !== null) throw new ProjectFolderError(cwd, refusal);
  return refusal;
}

/** A project was asked for in a folder that holds the global setup. */
export class ProjectFolderError extends Error {
  constructor(folder: string, reason: string) {
    super(
      `${folder} is ${reason}, which holds the global setup, so it cannot be a project. Run the command again from the project's folder.`,
    );
    this.name = 'ProjectFolderError';
  }
}
