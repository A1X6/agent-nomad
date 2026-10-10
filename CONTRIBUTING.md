# Contributing

Thanks for helping. This guide covers setting up the project, running it, testing it and
getting a change merged. How the system works is explained in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Set up

You need [Node.js](https://nodejs.org) 22.13 or newer and pnpm (the version in
`package.json` → `packageManager`; `corepack enable` installs it).

```sh
git clone https://github.com/A1X6/agent-nomad.git
cd agent-nomad
pnpm install
pnpm build
```

Run the CLI you just built:

```sh
node packages/cli/dist/src/bin.js --help
```

## Scripts

| Command                     | What it does                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm build`                | Compiles every package (`tsc --build`).                                                  |
| `pnpm test`                 | All unit and integration tests (Vitest).                                                 |
| `pnpm test:coverage`        | The tests with a coverage report (in `coverage/`).                                       |
| `pnpm knip`                 | Lists unused files, dependencies and exports (mark a kept export `@public`).             |
| `pnpm test:e2e`             | Builds, then runs the built CLI end to end against a local API (four simulated PCs).     |
| `pnpm check`                | Typecheck, lint, format check and tests: what CI runs. Run it before every pull request. |
| `pnpm lint` / `pnpm format` | ESLint / Prettier on their own.                                                          |
| `pnpm release:build`        | Builds the npm package into `packages/cli/release/` (bundled with esbuild).              |

## The repository

| Path                 | What is there                                                           |
| -------------------- | ----------------------------------------------------------------------- |
| `packages/contracts` | Zod schemas for the API and the bundle format, shared by CLI and server |
| `packages/core`      | Crypto, bundle codec, portable paths, merge strategies (pure logic)     |
| `packages/cli`       | The `agentnomad` command and the agent adapters                         |
| `packages/server`    | The API (Hono) and database (Drizzle, Postgres)                         |
| `packages/e2e`       | End-to-end and cross-OS tests                                           |
| `docs/`              | Architecture, roadmap, agent guide, decisions, threat model             |

## Trying it without the hosted API

Everything can run locally. The end-to-end tests start the real API on an in-memory
database (`packages/e2e/src/local-server.ts`); `AGENTNOMAD_API_URL` points the CLI at any
server (plain http is allowed only for `localhost`):

```sh
AGENTNOMAD_API_URL=http://127.0.0.1:3000 node packages/cli/dist/src/bin.js register
```

To run the API itself against Postgres, put `DATABASE_URL` and `SERVER_SECRET`
(`openssl rand -base64 32`) in `packages/server/.env` (never commit it), apply the
migrations with `pnpm --filter @agentnomad/server db:migrate`, then start
`packages/server/dist/src/main.js`.

When testing by hand, use a temporary home folder (set `HOME` and, on Windows,
`USERPROFILE` and `APPDATA`) so your real setup and keychain are never touched.

## How we write code

- **TypeScript strict,** ES modules, no `any`, no unchecked casts.
- **Validate every boundary** with the Zod schemas in `contracts` (API bodies and headers,
  files read back from disk).
- **Small, focused modules with injected dependencies.** Composition roots
  (`packages/cli/src/app.ts`, `packages/server/src/api.ts`) build the real services; the
  rest receives them, so tests need no network, terminal or keychain.
- **Agent-specific code stays in its adapter** (`packages/cli/src/agents/<agent>/`). See
  [docs/ADDING-AN-AGENT.md](docs/ADDING-AN-AGENT.md).
- **Formats are versioned and never changed in place** (bundle format, key labels, hash
  prefixes): add a new version next to the old one.
- **Check a library's documentation for the version we pin** before using it.
- **New dependencies are discussed first** in an issue: we prefer the platform and the
  libraries already in use, and a security tool should have few dependencies.
- **Comments explain why,** in plain English; code says what.

## Finding IDs and task numbers in comments

Many comments and test titles end with a reference such as `(T44)`, `(BUG-07)` or
`(review 6 SEC-01)`. `T44` is the task that wrote the line: `git log --grep '^T44:' --oneline`
lists its commits. `BUG-07` is a finding of one of the code reviews in
[docs/reviews](docs/reviews), whose entry says what was wrong and why it was fixed that way.
Review N is the file or folder whose name ends in `-N` (review 1 has no number:
`review-2026-10-03.md`). Every review numbers its findings from 01 again, so when a reference
does not name its review:

1. Run `git log -S 'BUG-07' --oneline -- <file>`. It lists the commits that added or removed
   the ID in that file; the last one listed wrote it. Its message starts with the task and
   names the ID, usually with its review (`T69: … from review 4 (SEC-01, …)`). If it does not
   name the ID, the line was moved there: run it again on the folder the code came from, or on
   the whole repository.
2. If the file cites the same ID for findings of several reviews, ask for that one line
   instead: `git log -L 84,84:<file> --oneline --no-patch`.
3. `grep -rnE '^#+ BUG-07 ·' docs/reviews` lists every finding with that ID. The one meant is
   in the review the commit names, or else the latest review before the commit, and its
   **Where** names the file.

For example, `(BUG-07)` in `packages/server/src/db/bundle-cursor.ts` leads to
`acc3e57 T58: … (BUG-07) …` and to "BUG-07 · Low · A well-formed cursor with an impossible
date gives a 500" in `docs/reviews/review-2026-10-03.md`. Keep the reason in the comment
itself; the reference only says where to read more. Never point at something a reader cannot
open, such as a chat or an option letter from a discussion.

## Tests

- Every change comes with tests: a failing test first for a bug, tests for each new
  behaviour and its edge cases.
- Tests use temporary folders and fakes. They must never read or write the real home
  folder, the real keychain or the hosted API. The one exception, the real OS keychain test
  in `packages/cli/test/secret-store.test.ts`, runs only with `AGENTNOMAD_TEST_REAL_KEYCHAIN=1`,
  which CI sets on every OS.
- Shared test helpers live in these files. Use them instead of a new copy, and name a new
  one here in the same change:
  - `packages/cli/test/fakes.ts`, which loads no agent's adapter: the one temporary-folder
    hook of the CLI tests (`useTempDir`, or `withTempDir` inside a single test; no test file
    calls `mkdtemp`); the real crypto service with a data key (`useDataKey`, then `crypto`
    and `dataKey`) and the real password checker (`useZxcvbnChecker`, then `zxcvbn`);
    collected files (`collected`, `collectedJson`, `paths`, `text`); files on disk
    (`writeTestFile`, `linkFolder`, `readText`, `readJson`, `exists`); a secret store
    (`memorySecretStore`, `memorySecrets`, and `loggedInStore` for one already logged in), a
    PC that finds only the programs it is given (`executableLookup`), a scripted prompter
    (`scriptedPrompter`), a recording reporter (`recordingReporter`), an env writer
    (`fakeEnvWriter`), a typed partial API client (`fakeApi`), a bundle server
    (`fakeBundleServer`, read with `storedOn` and `revisionOn`), a local state in a
    temporary folder (`localStateIn`), an adapter that only detects (`fakeAdapter`, with
    `installedAgent` and `missingAgent`), a password the policy accepts (`STRONG`) and a
    project folder nobody looks in (`CWD`).
  - `packages/cli/test/claude-code-project-fixtures.ts`: the Claude Code tests' temporary
    home and project (`useProjectFolders`, then `root`, `home`, `base` and `project`), the
    collectors (`options`, `globalCollector`, `collect`, `collectSkipped`), the real adapter
    (`claudeCodeAdapter`), settings with one Stop hook (`stopHook`), an auto memory folder
    (`setMemoryDirectory`, `memoryDir`) and a claude.ai synced skills folder (`synced`,
    `syncedSetup`).
  - `packages/cli/test/claude-code-plugin-fixtures.ts`: plugin files (`installedPluginsFile`,
    `putJson`, `realisticPlugins`), managed settings (`fakeManagedSystem` with
    `FakeManagedPc`, `noManagedSettings`, `fileManagedSettings`) and the plugin sources Claude
    Code 2.1.295 keeps (T96): the names `SKILLS_DIR_MARKETPLACE`, `PLUGIN_DATA_FOLDERS`,
    `PLUGIN_STORE_FILES` and `PLUGIN_STORE_MODES`; `claude plugin validate` runs as
    `ValidateRun` (`validatePassWithWarning`, `validateBrokenManifest`, the mod folder shown
    as `VALIDATED_MOD`); and the claude.ai synced files of `SYNCED_ACCOUNT`
    (`syncedSkillsManifest`, `olderSyncedSkillsManifest`, `syncedPluginsManifest`,
    `syncedPluginMeta`, `syncedMarketplaces`, all written by `syncedSources`).
  - `packages/cli/test/stub-restorer.ts`: a restorer that writes nothing, for tests about
    other parts (`stubRestorer`).
  - `packages/server/test/support/`: a fresh database or app for each test (`useTestDatabase`
    or `createTestDatabase` and `migrationsFolder` in `database.ts`; `useTestApp` or
    `createTestApp`, `TEST_IP_HEADER` and `postJson` in `app.ts`). In `fixtures.ts`: values
    (`b64`, `bytes`, `sha256Hex`, `scopeKeyOf`, `UNKNOWN_ID`, `authKey`), requests as the
    CLI sends them (`registration`, `registerUser`, `registerForToken`, `preloginRequest`,
    `loginRequest`, `putSetup`, `deleteAccountRequest`, the `bearer` header) and their
    `errorCode`, users and sessions (`newUser`, `createUser`, `newSession`), setups
    (`bundleRow`, `globalKey`, `metaWrite`, `seedSetups`) and `memoryLogger`.
  - `packages/core/test/fixtures.ts`: `useDataKey`, then `crypto` and `dataKey`.
  - `packages/contracts/test/fixtures.ts`: a session `token`, the `kdfParams` as the wire
    carries them and a bundle list `summary`.
- Use a named constant instead of its value: `GLOBAL_SCOPE_KEY`, `BUNDLE_FORMAT_VERSION`,
  `AUTH_KEY_BYTES`, `KDF_SALT_BYTES`, `WRAPPED_DATA_KEY_BYTES` and `MAX_BUNDLE_BYTES`
  (contracts); `AEAD_KEY_BYTES`, `DATA_KEY_BYTES`, `BACKUP_MARKER`, `INCOMING_MARKER` and
  `HOME_PLACEHOLDER` (core); `SECRETS_FILE`, `STATE_FILE`, `TEMP_MARKER`,
  `CLAUDE_JSON_BUNDLE_PATH`, `BLOCK_START` and `BLOCK_END` (the CLI). A value an assertion
  compares against stays written out, and so do the header names, sizes and settings that
  pin the API format in the contracts tests and the server's `support/fixtures.ts`.
- A module's tests go in the test file named after it, so they are found by name. The file
  reference in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) lists the other test files and
  the small modules tested through the code that uses them.
- Anything that touches paths runs on macOS, Linux and Windows in CI; write it so it passes
  on all three (use `path.join`, never assume `/`).
- A change to push, pull or the bundle belongs in the end-to-end steps too
  (`packages/e2e/src/steps.ts`), including the check that nothing readable leaves the PC
  (`packages/e2e/src/plaintext.ts`: as text, encoded or compressed).

## Pull requests

1. Fork, and create a branch from `dev`.
2. Make the change with its tests and docs (README, [docs/](docs/)).
3. `pnpm check` and `pnpm test:e2e` pass.
4. Open the pull request against `dev`, describing what and why. CI must be green on every
   OS.

`dev` is released to `main` when a set of changes is ready.

## Keeping up with Claude Code

Every Monday, `.github/workflows/drift-check.yml` compares the Claude Code paths data file
(`packages/cli/src/agents/claude-code/claude-code-paths.data.ts`) with the newest Claude Code
and, when something needs a look, opens or updates an issue labelled `drift`. To handle it:
sort each new name into `neverSynced`, `knownState` or a synced list (never sync credentials,
history, caches or machine state), read the listed changelog entries, set `reviewedVersion`
to the version in the issue, and run `pnpm check`. Run the check locally with
`node --experimental-strip-types packages/cli/scripts/drift/check-claude-code.ts`.

## Releases

Maintainers release from `main`:

1. Set the new version in `packages/cli/package.json` and `packages/cli/src/version.ts`
   (a test keeps them equal), merged through `dev` to `main`.
2. Write the release notes in `.github/release-notes/v1.2.3.md` in the same change (the
   release stops before publishing without them).
3. Tag the commit on `main` (`git tag v1.2.3 && git push origin v1.2.3`).
4. `.github/workflows/release.yml` builds and tests the package on every OS, then waits for
   approval in the `npm` environment; after approval it publishes with provenance through
   npm trusted publishing, checks `npx agentnomad` on every OS, and makes the GitHub
   release from the notes file, marked Latest.

To try the package locally: `pnpm release:build`, then
`npm pack ./packages/cli/release` and install the `.tgz` into a temporary prefix
(`npm install -g --prefix <temp folder> ./agentnomad-*.tgz`).

## Security

Never put secrets in code, tests, commits or issues. Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md), not in a public issue.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
