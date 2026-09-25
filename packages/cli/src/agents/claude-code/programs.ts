import { posix, win32 } from 'node:path';

import * as z from 'zod';

import { findExecutable, type DetectorSystem } from './detector.ts';

/** A program a hook or the status line runs, and how to install it elsewhere if known. */
export interface ProgramInfo {
  readonly command: string;
  /** Set when it is a global npm package, so pull can offer `npm install -g package@version`. */
  readonly npm: { readonly package: string; readonly version: string } | null;
}

/** Looks a command up on this PC; `null` when it is not installed here. */
export type ProgramLocator = (command: string) => Promise<ProgramInfo | null>;

const NpmManifestSchema = z.object({
  name: z.string().regex(/^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
});

/**
 * Finds a command like the shell does, then checks whether npm installed it globally:
 * npm puts the launcher in its prefix (Windows) or prefix/bin (macOS, Linux), next to
 * `node_modules/<name>` or `lib/node_modules/<name>`.
 */
export function createProgramLocator(system: DetectorSystem): ProgramLocator {
  const path = system.platform === 'win32' ? win32 : posix;
  return async (command) => {
    const executable = await findExecutable(system, command);
    if (executable === null) return null;
    const folder = path.dirname(executable);
    const manifests = [
      path.join(folder, 'node_modules', command, 'package.json'),
      path.join(folder, '..', 'lib', 'node_modules', command, 'package.json'),
    ];
    for (const manifest of manifests) {
      const text = await system.readText(manifest);
      if (text === null) continue;
      try {
        const parsed = NpmManifestSchema.safeParse(JSON.parse(text));
        if (!parsed.success) continue;
        const { name, version, bin } = parsed.data;
        const provides =
          typeof bin === 'string'
            ? name.split('/').pop() === command
            : bin?.[command] !== undefined;
        if (provides) return { command, npm: { package: name, version } };
      } catch {
        continue;
      }
    }
    return { command, npm: null };
  };
}
