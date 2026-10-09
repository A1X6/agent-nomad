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

/** What the commands know about the folder they run in and the agent they work for. */
export interface ProjectFolderDeps {
  readonly cwd: string;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
}

/**
 * The commands' one check (review 17 DUP-02): why `deps.cwd` cannot be a project of `agent`,
 * or `null`; with `--project` given, a refusal is an error instead.
 */
export function projectFolderRefusalFor(
  deps: ProjectFolderDeps,
  agent: { readonly baseDir: string | null; readonly displayName: string },
  projectAsked: boolean,
): string | null {
  const refusal = projectFolderRefusal(deps.cwd, {
    homedir: deps.homedir,
    baseDir: agent.baseDir,
    agentName: agent.displayName,
    platform: deps.platform,
  });
  if (projectAsked && refusal !== null) throw new ProjectFolderError(deps.cwd, refusal);
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
