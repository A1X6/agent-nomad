# Code Review — Agent Nomad — 2026-10-04 (review 7)

**Scope:** the whole repository at `dev` `7cb74d9`, after the fixes for review 6 (T80 to T83).
**Stack:** pnpm monorepo, TypeScript strict, Node 22.13 or newer. Packages: `contracts` (Zod), `core` (libsodium, pure logic), `cli` (commander, @clack/prompts, @napi-rs/keyring), `server` (Hono, Drizzle, Postgres on Neon, hosted on Render), `e2e`.
**Coverage:** 273 of 273 files read in full, 38,565 lines. 289 files are tracked; 16 are skipped (see [Not reviewed](#not-reviewed)).
**Checks run:**

- `pnpm check` (typecheck, lint, format, tests): pass. 67 test files, 1,373 tests passed, 17 skipped (the real keychain test and OS-specific tests).
- `pnpm knip`: pass, nothing unused.
- `pnpm audit --prod`: pass, no known advisories.
- CI on `7cb74d9` (run 37157351594): pass on macOS, Linux and Windows.
- One probe during the review: a file placed in `packages/cli/src/agents/` that imports `./claude-code/detector.ts` fails lint, as the new rule from review 6 (ARCH-02) intends. The probe file was removed.

## Summary

The code is in very good shape. All 15 findings of review 6 are fixed and each fix was checked in this review. This pass found 6 new findings, all Low: no bugs in behaviour, no Critical, High or Medium. One is the last part of a review 6 security finding: a warning that still prints a hook command with its real line breaks. Two are small duplications the fixes themselves introduced. Three are about names and wording: tests that still sit away from the module they test, one comment in the generic adapter interface, and one sentence in `CONTRIBUTING.md` that disagrees with `ARCHITECTURE.md`.

## Scores

| Area                         | Score /10 | One-line reason                                                                       |
| ---------------------------- | --------- | ------------------------------------------------------------------------------------- |
| Correctness                  | 9.5       | No bug found; every boundary is schema-checked and tested.                            |
| Security                     | 9.5       | One Low: a warning line can be split by a line break in a hook command.               |
| Performance                  | 9.5       | Nothing found; queries are indexed, paged and limited.                                |
| User experience              | 9.5       | Messages are consistent after review 6; nothing new found.                            |
| Readability                  | 9         | Some tests are still not in the file named after their module.                        |
| Maintainability              | 9         | Two small duplications (a settings file list, test set-up helpers).                   |
| Architecture and scalability | 9.5       | Boundaries are enforced by lint and a second made-up agent; no finding.               |
| Test coverage                | 9.5       | Every module has tests; one small gap (the warning in SEC-01 has no line-break test). |

| Category        | Critical | High | Medium | Low |
| --------------- | -------- | ---- | ------ | --- |
| Bugs            | 0        | 0    | 0      | 0   |
| Security        | 0        | 0    | 0      | 1   |
| Database        | 0        | 0    | 0      | 0   |
| Performance     | 0        | 0    | 0      | 0   |
| User experience | 0        | 0    | 0      | 0   |
| Dead code       | 0        | 0    | 0      | 0   |
| Duplication     | 0        | 0    | 0      | 2   |
| Readability     | 0        | 0    | 0      | 3   |
| Refactoring     | 0        | 0    | 0      | 0   |
| Best practices  | 0        | 0    | 0      | 0   |
| System design   | 0        | 0    | 0      | 0   |
| SOLID           | 0        | 0    | 0      | 0   |
| QA and testing  | 0        | 0    | 0      | 0   |
| **Total**       | 0        | 0    | 0      | 6   |

## Fix first

1. **SEC-01**: the "will likely not run here" warning prints a hook command with its real line breaks.
2. **DUP-01**: the project settings file names are written a second time, outside the data file.
3. **READ-01**: tests still away from the file named after their module.
4. **DUP-02**: the same test set-up helpers in two test files.
5. **READ-03**: `CONTRIBUTING.md` and `ARCHITECTURE.md` name different server composition roots.
6. **READ-02**: Claude Code wording in the generic adapter interface.

## Findings

### Security

### SEC-01 · Low · The other-OS warning prints a hook command with its real line breaks

- [x] **Where:** `packages/cli/src/agents/claude-code/restorer.ts:418-425`
- **Problem:** The warning "This hook or status line came from `<os>` and will likely not run here: `<command>`" appends the command as it is in the bundle. Review 6 (SEC-02) put the path, the reason and the error message of the other restore warnings through `printableLine`; this one was left out. The reporter still escapes escape sequences (`printable`), but not line breaks.
- **Why it matters:** A command in a bundle that holds a line break prints the rest on a new line, which can look like a separate message from agentnomad. Nothing runs and nothing is hidden from the review list (that list already uses `printableLine`), so this is cosmetic, but it is the same rule as review 5 SEC-03 and review 6 SEC-02.
- **Fix:** `${printableLine(command)}` in that message, with a test first: a hook command with `\n` gives one warning line. `ARCHITECTURE.md` section 7 says the warning "shows the command as written"; add "with line breaks escaped".
- **Effort:** S
- **Confidence:** high

### Duplication

### DUP-01 · Low · The project settings file names are written again outside the data file

- [x] **Where:** `packages/cli/src/agents/claude-code/project-paths.ts:14-18`, `packages/cli/src/agents/claude-code/env-files.ts:8`, `packages/cli/src/agents/claude-code/restorer.ts:416`
- **Problem:** `PROJECT_SETTINGS_FILES` (added for review 6 DUP-01) is a new literal list, `['.claude/settings.json', '.claude/settings.local.json']`. The same two names are already in the data file (`claude-code-paths.data.ts`, `project.claudeFiles`), which the docs call "the only file to change". `env-files.ts` and `restorer.ts` also write `'settings.json'` for the global file as a literal.
- **Why it matters:** If Claude Code adds or renames a settings file, the data file is changed and these lists are missed, so hooks in the new file would not get the other-OS warning or the `${VAR}` scan. Small, because both names are stable.
- **Fix:** Build `PROJECT_SETTINGS_FILES` from the data file (filter `PROJECT_CLAUDE_FILES` for names starting with `settings`, with `.claude/` in front), or add a `settingsFiles` list to the data file's schema for both scopes and use it in all three places. A test: every settings file in the data file is in the list.
- **Effort:** S
- **Confidence:** high

### DUP-02 · Low · The same test set-up helpers in two test files

- [ ] **Where:** `packages/cli/test/claude-code-auto-memory.test.ts:16-52`, `packages/cli/test/claude-code-project-collector.test.ts:14-49`
- **Problem:** When T82 moved the auto memory tests to their own file, the set-up helpers (the temporary home and project, the collector factory) were copied, not shared.
- **Why it matters:** A change to how a project collector is built for tests must be made twice. `CONTRIBUTING.md` says shared helpers live in `packages/cli/test/fakes.ts`.
- **Fix:** Move the helpers both files use into `fakes.ts` (or a small `claude-code-project-fixtures.ts` next to the tests) and import them in both.
- **Effort:** S
- **Confidence:** high

### Readability

### READ-01 · Low · Some tests are still not in the file named after their module

- [ ] **Where:**
  - server: `packages/server/test/crash-logging.test.ts:18-32` tests `createDatabasePool` of `server.ts` (belongs in `server.test.ts`); the file itself tests `logging/crash.ts` and should be `crash.test.ts`; `rate-limiter.test.ts` tests `postgres-rate-limiter.ts`, next to the new `rate-limit.test.ts`, so the two names read alike; the `BlobStore` tests are in `repositories.test.ts`.
  - CLI: `claude-code-restore-rules.test.ts` holds `hook-scripts.ts` tests; `setup-commands.test.ts:237-244` tests `setupLabel` (`cli/setup-outcomes.ts`); `managed-settings.test.ts` has no `claude-code-` in front and also holds `installPlugins` and `globalDestination` tests; `claude-code-command-review.test.ts` holds `runnableInMarkdown`, `LOADER_VARIABLE` and account-skills tests; `pull-command.test.ts:848-862` tests `listAllBundles` (`pull/saved-setups.ts`); `auth-commands.test.ts:633-679` holds the password-policy and `withSession` tests.
- **Problem:** Review 6 (READ-02) set the rule, now written in `CONTRIBUTING.md:97-98` and at the top of Part 2 of `ARCHITECTURE.md`: a module's tests go in the test file named after it. T82 moved most of them; these are what is left.
- **Why it matters:** A developer looking for the tests of `hook-scripts.ts` or `password-policy.ts` does not find a file by that name. No test is missing; this is only where they are.
- **Fix:** Move each group to a file named after its module (`claude-code-hook-scripts.test.ts`, `setup-outcomes.test.ts`, `claude-code-managed-settings.test.ts`, `claude-code-runnable-markdown.test.ts`, `loader-variables.test.ts`, `saved-setups.test.ts`, `password-policy.test.ts`, `local-session.test.ts`, `postgres-blob-store.test.ts`, `crash.test.ts`, `postgres-rate-limiter.test.ts`). Moves only: the list of test titles must be the same before and after.
- **Effort:** M
- **Confidence:** high

### READ-02 · Low · Claude Code wording in the generic adapter interface

- [x] **Where:** `packages/cli/src/agents/adapter.ts:39`
- **Problem:** The comment on `includeMemory` says "(subagent and auto memory)". Those are Claude Code's two kinds of memory; `adapter.ts` is the interface every agent implements, and each adapter already names its own memory through `memoryDescription`.
- **Why it matters:** The author of a second adapter reads this as part of the contract. Tiny.
- **Fix:** "Include the agent's memory (what `memoryDescription` names)."
- **Effort:** S
- **Confidence:** high

### READ-03 · Low · Two documents name different server composition roots

- [x] **Where:** `CONTRIBUTING.md:72-74`, `docs/ARCHITECTURE.md` section 12 and the server file reference
- **Problem:** `CONTRIBUTING.md` says the composition roots are `packages/cli/src/app.ts` and `packages/server/src/server.ts`. `ARCHITECTURE.md` says `server/src/api.ts` (`createApi`) is the composition root and "the only wiring", and that `server.ts` only reads the settings, opens the pool and calls it. The code matches `ARCHITECTURE.md`.
- **Why it matters:** A contributor adding a server service would look in the wrong file first.
- **Fix:** In `CONTRIBUTING.md`, name `packages/server/src/api.ts`.
- **Effort:** S
- **Confidence:** high

## Standards to adopt

- **Text from a bundle in a message:** every value that comes from a bundle and is printed on one line goes through `printableLine` (SEC-01 is the last place found that does not).
- **Names of Claude Code's files:** only in `claude-code-paths.data.ts`; other modules take named views of it (DUP-01).
- **Where tests live:** the file named after the module, as `CONTRIBUTING.md` says (READ-01); shared set-up in `fakes.ts` or `support/fixtures.ts` (DUP-02).

## What will break first at scale

Unchanged from review 6; none is a finding today.

1. **Bundle bytes in Postgres** (`packages/server/src/storage/postgres-blob-store.ts`): 50 MB per account in the shared Neon database. The `BlobStore` interface is ready for R2 (on the roadmap).
2. **The free Render plan** (`render.yaml`): sleeps after 15 idle minutes, so the first request waits about a minute. The CLI's wake-up check covers it; a paid plan removes it.
3. **One adapter file set per agent** (`packages/cli/src/agents/claude-code/restorer.ts`): when the second agent is written, the generic parts of the restorer (atomic writes, line endings, the conflict loop) should move to `agents/shared/`, as `ADDING-AN-AGENT.md` already says.

## Suggested order of work

1. **SEC-01, DUP-01, READ-02** together: all in `packages/cli/src/agents`, small, one branch.
2. **READ-01, DUP-02** together: test moves only, no source change; compare the test titles before and after.
3. **READ-03**: one sentence in `CONTRIBUTING.md`; can go with either branch.

## Not reviewed

- 16 tracked files skipped: `pnpm-lock.yaml`, the Drizzle snapshot files under `packages/server/drizzle/meta/` (generated), and binary assets (images under `docs/images/` and `.a1x6/images/`).
- Not run in this review: `pnpm test:e2e` locally (CI runs it on every OS, green on `7cb74d9`); the real keychain test locally (CI only, by design); anything against the real database or Render.
- Carried over, not a code finding: the Render build command in `render.yaml` (`--filter @agentnomad/server...`) has not yet run on Render, because nothing has been merged to `main` since it changed.
