import { posix, win32 } from 'node:path';

/** Same folder on this OS: Windows paths ignore case. */
export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix;
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

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

/** A project was asked for in a folder that holds the global setup. */
export class ProjectFolderError extends Error {
  constructor(folder: string, reason: string) {
    super(
      `${folder} is ${reason}, which holds the global setup, so it cannot be a project. Run the command again from the project's folder.`,
    );
    this.name = 'ProjectFolderError';
  }
}
