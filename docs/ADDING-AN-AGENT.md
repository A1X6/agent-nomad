# Adding a new agent

agentnomad supports an agent through an **adapter**: one folder of code that answers "is it
installed, what is its setup, and how is it written back". Adding an agent means adding
one folder and **one line** that registers it. Nothing that exists changes: not Claude
Code's adapter, not push or pull, not encryption, not the server, and not anyone's saved
setups (data is stored per agent).

This guide walks through it with an imaginary agent, **Example CLI** (`example`), whose
setup lives in `~/.example`. Read [ARCHITECTURE.md](ARCHITECTURE.md) sections 4, 6 and 7
first; the Claude Code adapter in `packages/cli/src/agents/claude-code/` is the full
worked example.

> Want to add an agent with no code at all? That is planned: see
> [data-only agents](ROADMAP.md#v1x-data-only-agents) in the roadmap.

## Overview

```text
packages/cli/src/agents/
├── adapter.ts                  the interfaces you implement (do not change)
├── registry.ts                 the registry (do not change)
├── claude-code/                the reference adapter
└── example/                    ← your new folder
    ├── example-paths.data.ts   what to sync, skip and refuse, as data
    ├── detector.ts             is it installed? where? which version?
    ├── collector.ts            global and project setups → bundle files
    ├── restore-rules.ts        where each bundle file may go back (or why not)
    ├── restorer.ts             write a pulled setup
    └── example-adapter.ts      puts the parts together
packages/cli/src/app.ts         ← one line: register the adapter
packages/cli/test/example-*.test.ts
```

## Step 1 · Research the agent

Answer these from the agent's current documentation (and by looking at a real install on
each OS) before writing code:

- [ ] **Base folder:** where the global setup lives on macOS, Linux and Windows, and any
      environment variable that moves it (Claude Code: `CLAUDE_CONFIG_DIR`).
- [ ] **Detection:** the command name, how to get its version, other install locations.
- [ ] **Global setup:** which files and folders are the user's setup (settings,
      instructions, skills, commands, prompts, rules).
- [ ] **Project setup:** which files in a project root or project folder belong to the agent.
- [ ] **Never sync:** credentials and logins, history, sessions and transcripts, caches,
      logs, machine-specific state. When unsure, leave it out.
- [ ] **Things that run programs:** hooks, MCP servers, status lines, and the files that
      hold them. These must be shown for review on pull.
- [ ] **Formats:** JSON, TOML, YAML, Markdown. JSON merges by key today; other formats fall
      back to "keep yours, save theirs next to it" until a merge strategy is added to core.
- [ ] **Extensions or plugins:** reinstall them with the agent's own commands; never copy
      their files.
- [ ] **Organization-managed settings:** files an employer enforces; never sync them, only
      tell the user.

## Step 2 · The paths data file

Put every list in one data file, checked with a Zod schema when loaded, like
`claude-code/claude-code-paths.data.ts`. When the agent adds or moves a file later, this is
the only file to change.

```ts
// packages/cli/src/agents/example/example-paths.data.ts
import * as z from 'zod';

const RAW = {
  version: 1,
  global: {
    files: ['settings.json', 'INSTRUCTIONS.md'],
    folders: ['skills', 'commands'],
    neverSynced: ['credentials.json', 'history.jsonl', 'sessions', 'cache', 'logs'],
  },
  project: {
    rootFiles: ['INSTRUCTIONS.md'],
    folders: ['.example/skills', '.example/commands'],
    neverSynced: ['.git', '.example/local'],
  },
  skippedNames: ['.git', 'node_modules', '.DS_Store', 'Thumbs.db'],
};

const names = z.array(
  z
    .string()
    .min(1)
    .regex(/^[^\\]+$/, 'Use forward slashes'),
);

export const EXAMPLE_PATHS = z
  .strictObject({
    version: z.literal(1),
    global: z.strictObject({ files: names, folders: names, neverSynced: names }),
    project: z.strictObject({ rootFiles: names, folders: names, neverSynced: names }),
    skippedNames: names,
  })
  .parse(RAW);
```

## Step 3 · The detector

Implement `Detector` from `adapter.ts`. Reuse the helpers in `claude-code/detector.ts`:
`findExecutable(system, command)` searches PATH like a shell (PATHEXT on Windows), and
`nodeDetectorSystem(env, homedir, platform)` gives the real file system and a safe
`--version` runner (no shell, time-limited).

```ts
// packages/cli/src/agents/example/detector.ts
import { join } from 'node:path';

import type { DetectedAgent, Detector } from '../adapter.ts';
import { findExecutable, type DetectorSystem } from '../claude-code/detector.ts';

export const exampleBaseDir = (system: DetectorSystem) =>
  system.env['EXAMPLE_HOME']?.trim() || join(system.homedir, '.example');

export function createExampleDetector(system: DetectorSystem): Detector {
  return {
    async detect(): Promise<DetectedAgent> {
      const baseDir = exampleBaseDir(system);
      const command = await findExecutable(system, 'example');
      const installed = command !== null || (await system.isDirectory(baseDir));
      const version = command ? await system.runVersion(command) : null;
      return {
        installed,
        baseDir: installed ? baseDir : null,
        version: version?.match(/\d+\.\d+\.\d+/)?.[0] ?? null,
      };
    },
  };
}
```

## Step 4 · The collector

Implement `Collector`: return `CollectedFile`s whose `path` is relative to the base folder
(global) or the project root (project), with forward slashes. `createFileGatherer` from
`claude-code/file-gathering.ts` reads single files and walks folders (following links
once, skipping clutter and agentnomad's own backup copies).

```ts
// packages/cli/src/agents/example/collector.ts
import type { CollectedFile, Collector } from '../adapter.ts';
import { createFileGatherer, uniqueByPath } from '../claude-code/file-gathering.ts';
import { EXAMPLE_PATHS } from './example-paths.data.ts';

const under = (path: string, entry: string) => path === entry || path.startsWith(`${entry}/`);

export function createExampleCollector(options: {
  baseDir: string;
  platform: NodeJS.Platform;
}): Collector {
  const files = createFileGatherer(options.platform);
  const { path } = files;

  return {
    async collect(target) {
      const found: CollectedFile[] = [];
      const scope = target.kind === 'global' ? EXAMPLE_PATHS.global : EXAMPLE_PATHS.project;
      const root = target.kind === 'global' ? options.baseDir : target.projectDir;
      const excluded = (bundlePath: string) =>
        scope.neverSynced.some((entry) => under(bundlePath, entry));

      const single =
        target.kind === 'global' ? EXAMPLE_PATHS.global.files : EXAMPLE_PATHS.project.rootFiles;
      for (const name of single) {
        const file = await files.readIfFile(path.join(root, ...name.split('/')), name);
        if (file) found.push(file);
      }
      for (const folder of scope.folders) {
        found.push(...(await files.walk(path.join(root, ...folder.split('/')), folder, excluded)));
      }
      return uniqueByPath(found);
    },
  };
}
```

Collect only what is listed (an allowlist). Anything the agent adds later stays out until
the data file lists it; that is what keeps credentials out.

## Step 5 · Restore rules and the restorer

**Restore rules** are a pure function: for each bundle path, where it goes, or why it is
refused. Allow only what your collector could have produced. This is what stops a damaged
or tampered bundle from writing credentials, state or files outside the setup. See
`claude-code/restore-rules.ts`, including `windowsNameProblem` for Windows-unsafe names.

**The restorer** implements `Restorer.restore(target, files, onConflict, context)`:

1. For each file, ask the restore rules; report refused ones in `warnings`.
2. Skip files that are identical to what is on disk.
3. For a different existing file, call `onConflict(path, { overwriteAllowed })`: it asks the
   user or answers from `--merge` / `--overwrite` / `--yes`. Use `createMergeStrategies`
   and `selectMergeStrategy` from `@agentnomad/core` to plan merge (JSON by key; others
   side by side) and overwrite (with a timestamped backup).
4. Write atomically (temporary file, then rename), keep a replaced file's permissions,
   use LF for scripts (CRLF for `.bat`/`.cmd` on Windows), set the executable bit on
   macOS and Linux.
5. Return what was written, skipped and backed up.

`claude-code/restorer.ts` does all of this for Claude Code. When the second adapter is
written, move its generic parts (atomic writes, line endings, permissions, the conflict
loop) into a shared `agents/shared/` module rather than copying them.

## Step 6 · Optional parts

- **`inspector.unknownEntries(target)`:** entries in the agent's folder that the data file
  does not know, so push can tell the user (see `claude-code/unknown-files.ts`).
- **`inspector.notices('push' | 'pull')`:** anything to point out, such as
  organization-managed settings (see `claude-code/managed-settings.ts`).
- **`afterRestore(context)`:** follow-up after a pull, such as reinstalling extensions with
  the agent's own commands. Respect `context.assumeYes` and `context.allowCommands`:
  without `allowCommands`, never install or run anything unasked.

## Step 7 · Put the adapter together

```ts
// packages/cli/src/agents/example/example-adapter.ts
import type { AgentAdapter } from '../adapter.ts';
import { nodeDetectorSystem } from '../claude-code/detector.ts';
import { createExampleCollector } from './collector.ts';
import { createExampleDetector, exampleBaseDir } from './detector.ts';
import { createExampleRestorer } from './restorer.ts';

export function createExampleAdapter(options: {
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
  platform: NodeJS.Platform;
}): AgentAdapter {
  const system = nodeDetectorSystem(options.env, options.homedir, options.platform);
  const baseDir = exampleBaseDir(system);
  return {
    id: 'example',
    displayName: 'Example CLI',
    detector: createExampleDetector(system),
    collector: createExampleCollector({ baseDir, platform: options.platform }),
    restorer: createExampleRestorer({
      baseDir,
      homedir: options.homedir,
      platform: options.platform,
    }),
  };
}
```

The `id` is permanent: it is part of every saved bundle's key. Use lowercase letters,
digits and dashes.

## Step 8 · Register it (the one line)

In `packages/cli/src/app.ts`, add the adapter to the registry list:

```ts
createAgentRegistry([
  createClaudeCodeAdapter({ /* … */ }),
  createExampleAdapter({ env: app.env, homedir: app.homedir, platform: app.platform }),
]),
```

That is all the wiring. `agentnomad agents` now lists Example CLI; push and pull offer it
when it is installed or has saved setups; `--agent example` selects it.

## Step 9 · Tests

Copy the patterns from `packages/cli/test/claude-code-*.test.ts`:

- **Data file:** the schema accepts it; every list uses forward slashes.
- **Detector:** installed via the command, via the folder only, not installed; the folder
  environment variable; version parsing. Use a fake `DetectorSystem`, never the real PC.
- **Collector:** against a real temporary folder with a realistic setup, including files
  that must **never** be collected (credentials, history). Assert they are absent.
- **Restore rules:** every never-synced entry and unsafe path is refused, with its reason.
- **Restorer:** a round trip (collect on one fake PC, restore on another with a different
  home folder), conflicts (merge, overwrite with backup, skip), per-OS line endings and
  permissions.
- **End to end (recommended):** add the agent's files to `packages/e2e/src/steps.ts`, so the
  cross-OS chains push them on one OS and check them on another, and add its secrets to the
  plaintext check.

Tests must never read or write the real home folder or keychain: use temporary folders and
the fakes the existing tests use.

## Step 10 · Before opening a pull request

- [ ] `pnpm check` passes (typecheck, lint, format, tests).
- [ ] `pnpm test:e2e` passes.
- [ ] Push and pull tried by hand on at least two operating systems (a temporary home
      folder is enough), including a pull onto a PC that already has a different setup.
- [ ] Anything that runs programs is shown by pull before it is written. The review in
      `pull/command-review.ts` understands Claude Code's formats today; if your agent's
      setup can run programs (hooks, MCP servers), add its format there, or better, move
      the review behind the adapter as the [roadmap](ROADMAP.md#v1x-more-agents) plans.
- [ ] README (supported agents), [ROADMAP.md](ROADMAP.md) and
      [ARCHITECTURE.md](ARCHITECTURE.md) (file reference) updated.
- [ ] The [threat model](security/threat-model.md) still holds: no credentials collected,
      nothing runs unseen.

## What you do not touch

| Part                                                 | Why it keeps working                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| `push`, `pull`, `list`, `status`, `delete`, `agents` | They only use the registry and the adapter interfaces.                |
| Encryption, bundles, project names (`core`)          | Agent-independent; the agent id is just part of the bundle's context. |
| The API and the database (`server`)                  | They store opaque ciphertext per agent and scope.                     |
| The contracts                                        | `AgentIdSchema` accepts any lowercase id.                             |
| Other adapters and their users' saves                | Data is stored per agent.                                             |
