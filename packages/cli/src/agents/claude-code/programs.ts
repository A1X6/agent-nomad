import type { PlatformPath } from 'node:path';

import * as z from 'zod';

import { parseJsonWith, type JsonResult } from '../../system/json.ts';
import {
  findExecutable,
  pathsOf,
  type DetectorSystem,
  type ExecutableLookupSystem,
} from '../shared/detector-system.ts';

/** A program a hook or the status line runs, and how to install it elsewhere if known. */
export interface ProgramInfo {
  readonly command: string;
  /** Set when it is a global npm package, so pull can offer `npm install -g package@version`. */
  readonly npm: { readonly package: string; readonly version: string } | null;
}

/** Looks a command up on this PC; `null` when it is not installed here. */
export type ProgramLocator = (command: string) => Promise<ProgramInfo | null>;

/** An npm package name (scoped or not) and an exact version: all that reaches an install command. */
const NPM_PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const NPM_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * One entry of `.agentnomad/programs.json`, checked before anything from it reaches a command
 * line. Push checks each entry with it before saving (BUG-01), so pull never refuses it.
 */
export const ProgramEntrySchema = z.strictObject({
  command: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  npm: z
    .strictObject({
      package: z.string().regex(NPM_PACKAGE_NAME),
      version: z.string().regex(NPM_VERSION),
    })
    .nullable(),
});

/**
 * Reads a saved `.agentnomad/programs.json` entry by entry (BUG-01): an entry pull refuses
 * is left out and named (`refused`, as JSON), and the others are still offered.
 */
export function readSavedPrograms(
  content: Uint8Array,
): JsonResult<{ readonly programs: readonly ProgramInfo[]; readonly refused: readonly string[] }> {
  const outline = parseJsonWith(z.object({ programs: z.array(z.unknown()) }), content);
  if (!('value' in outline)) return outline;
  const programs: ProgramInfo[] = [];
  const refused: string[] = [];
  for (const entry of outline.value.programs) {
    const parsed = ProgramEntrySchema.safeParse(entry);
    if (parsed.success) programs.push(parsed.data);
    else refused.push(JSON.stringify(entry));
  }
  return { value: { programs, refused } };
}

const NpmManifestSchema = z.object({
  name: z.string().regex(NPM_PACKAGE_NAME),
  version: z.string().regex(NPM_VERSION),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
});

/**
 * The package folder a file inside `node_modules` belongs to, e.g.
 * `…/node_modules/@scope/tool/dist/cli.js` → `…/node_modules/@scope/tool`; `null` outside one.
 */
function packageFolderOf(path: PlatformPath, file: string): string | null {
  const parts = path.normalize(file).split(path.sep);
  const at = parts.lastIndexOf('node_modules');
  if (at === -1) return null;
  const name = parts.slice(at + 1, parts[at + 1]?.startsWith('@') === true ? at + 3 : at + 2);
  return NPM_PACKAGE_NAME.test(name.join('/'))
    ? [...parts.slice(0, at + 1), ...name].join(path.sep)
    : null;
}

/** What npm's `.cmd` launcher runs: `"%dp0%\node_modules\typescript\bin\tsc" %*`. */
const SHIM_TARGET = /%~?dp0%?\\(node_modules\\[^"%*\r\n]+)/i;

/**
 * Finds a command like the shell does, then checks whether npm installed it globally (BUG-02):
 * the package the launcher runs, whatever its name (`tsc` from `typescript`, `mmdc` from
 * `@mermaid-js/mermaid-cli`). npm links the launcher into the package on macOS and Linux,
 * and writes a `.cmd` launcher that names it on Windows. Else a package of the command's own
 * name next to the launcher: `node_modules/<name>` (Windows) or `lib/node_modules/<name>`.
 */
export function createProgramLocator(
  system: ExecutableLookupSystem & Pick<DetectorSystem, 'readText' | 'realPath'>,
): ProgramLocator {
  const path = pathsOf(system.platform);

  async function packageRun(executable: string): Promise<string | null> {
    if (system.platform !== 'win32') {
      const real = await system.realPath(executable);
      return real === null ? null : packageFolderOf(path, real);
    }
    if (path.extname(executable).toLowerCase() !== '.cmd') return null;
    const target = SHIM_TARGET.exec((await system.readText(executable)) ?? '')?.[1];
    return target === undefined
      ? null
      : packageFolderOf(path, path.join(path.dirname(executable), target));
  }

  return async (command) => {
    const executable = await findExecutable(system, command);
    if (executable === null) return null;
    const folder = path.dirname(executable);
    const run = await packageRun(executable);
    const manifests = [
      ...(run === null ? [] : [path.join(run, 'package.json')]),
      path.join(folder, 'node_modules', command, 'package.json'),
      path.join(folder, '..', 'lib', 'node_modules', command, 'package.json'),
    ];
    for (const manifest of manifests) {
      const text = await system.readText(manifest);
      if (text === null) continue;
      const parsed = parseJsonWith(NpmManifestSchema, text);
      if (!('value' in parsed)) continue;
      const { name, version, bin } = parsed.value;
      const provides =
        typeof bin === 'string' ? name.split('/').pop() === command : bin?.[command] !== undefined;
      if (provides) return { command, npm: { package: name, version } };
    }
    return { command, npm: null };
  };
}
