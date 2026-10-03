# Code Review — Agent Nomad — 2026-10-03 (review 4)

**Scope:** the whole repo at `dev` `4c31cf8` (54 commits ahead of `main`), after the fixes T53 to T68.
**Stack:** pnpm monorepo, TypeScript strict, Node 22.13 or newer. Packages: `contracts` (Zod schemas), `core` (encryption, bundle format, merge), `cli` (the `agentnomad` command, Commander and clack), `server` (Hono, Drizzle, Neon Postgres), `e2e`. Tests with Vitest; server tests on PGlite.
**Coverage:** 243 of {{FILES}} files read in full, 33,614 lines. See `files.md` for one row per file.
**Checks run:** type check pass · lint pass · format check pass · tests pass (1,237 passed, 14 skipped, 50 files) · `pnpm audit --prod` pass (no known vulnerabilities) · `pnpm knip` pass (nothing unused) · migration check (`db:check`) pass.

**How it was done:** six reviewers each read one part of the repo line by line and confirmed their findings at exact lines (several by running the real code). The orchestrator then re-opened the lines behind every Medium finding and the main Low ones, merged findings two reviewers reported twice, and did the cross-file passes.

## Summary

The code is in good shape. There is no Critical and no High finding: 63 findings, 6 Medium and the rest Low. The 44 findings of the three earlier reviews were re-checked where the reviewers met them; all hold, with three small leftovers (READ-06, DEAD-03, QA-07) and one side effect of an earlier fix (BUG-02).

The two findings that matter most are in the pull safety review. One malformed hook or MCP server entry makes the review skip every hook or server in that file (SEC-01), and push can save plugin entries that pull then drops whole without a word (BUG-01). The third is a design gap that only bites with a second agent: the environment-variable scan knows only Claude Code's file names (ARCH-01).

The largest group is tests (15 QA findings): one test reads the developer's real Claude Code setup (QA-01), several flags never pass through the real option parser (QA-02), and a handful of tests cannot fail. The cheapest large win is one shared set of test fakes (DUP-01), which also removes the unchecked casts (BP-01).

Nothing found blocks a merge of `dev` into `main`. SEC-01 and BUG-01 are worth fixing first, because they weaken what the pull review promises.

## Scores

| Area                         | Score /10 | One-line reason                                                                                                     |
| ---------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| Correctness                  | 9         | No High bug; four narrow ones (plugin entries dropped on pull, a prune that can fail a request, two edge cases).    |
| Security                     | 9         | Encryption, auth and input checks hold; the pull review fails open on a malformed entry (SEC-01).                   |
| Performance                  | 8         | Fine for today's size; a double session check on list, and copies of the 5 MB bundle in memory.                     |
| User experience              | 8         | Clear messages overall; login drops the current session before the new one is proven (UX-01).                       |
| Readability                  | 8         | Well named and commented; a few stale comments, misplaced tests and one very long test file.                        |
| Maintainability              | 8         | Strict lint, knip and boundary rules; test fakes and server wiring are copied in several places.                    |
| Architecture and scalability | 8         | Clean package and adapter boundaries; `env/` and the agent guide still lean on Claude Code specifics.               |
| Test coverage                | 8         | 1,237 tests and cross-OS end-to-end runs; some flags are untested through the parser and a few tests prove nothing. |

| Category             | Critical | High  | Medium | Low    |
| -------------------- | -------- | ----- | ------ | ------ |
| Bugs                 | 0        | 0     | 1      | 3      |
| Security             | 0        | 0     | 1      | 2      |
| Database and queries | 0        | 0     | 0      | 1      |
| Performance          | 0        | 0     | 0      | 3      |
| User experience      | 0        | 0     | 0      | 4      |
| Dead code            | 0        | 0     | 0      | 3      |
| Duplication          | 0        | 0     | 0      | 8      |
| Readability          | 0        | 0     | 0      | 14     |
| Refactoring          | 0        | 0     | 0      | 0      |
| Best practices       | 0        | 0     | 0      | 4      |
| System design        | 0        | 0     | 1      | 3      |
| SOLID and OOP        | 0        | 0     | 0      | 0      |
| QA and testing       | 0        | 0     | 3      | 12     |
| **Total**            | **0**    | **0** | **6**  | **57** |

## Fix first

1. **SEC-01** · Medium · one malformed hook or MCP server hides every other one in that file from the pull review.
2. **BUG-01** · Medium · push saves plugin and program entries that pull refuses whole, with no message.
3. **QA-01** · Medium · the `agentnomad agents` test reads the real home folder and runs the real `claude`.
4. **QA-02** · Medium · `--allow-commands`, `--account-skills`, `--merge`, `status` and `delete` are never tested through the option parser.
5. **QA-03** · Medium · the pull version warning has no test; the test named for it checks the opposite case.
6. **ARCH-01** · Medium · the environment-variable scan is hard-wired to Claude Code's files (matters for the second agent).
7. **BUG-02** · Low · a failed cleanup inside the rate limiter turns a good login or save into a 500.
8. **UX-01** · Low · login and register end the current session before the new credentials are checked.
9. **DUP-01** · Low · one shared file of test fakes; the copies already behave differently.
10. **DB-01** · Low · `GET /bundles` checks the session twice.

## Findings

### Bugs

#### BUG-01 · Medium · Push saves plugins and programs that pull's stricter schema refuses whole, and pull says nothing

- [x] **Where:** push side, unchecked: `packages/cli/src/agents/claude-code/plugins.ts:93-105` (`marketplaceAddArgument` accepts any `https://` or `git@` string), `:156` (plugin id check looser than pull's), `packages/cli/src/agents/claude-code/global-collector.ts:169` (written with no schema check), `packages/cli/src/agents/claude-code/settings-commands.ts:73` (`programOf` accepts names starting with `.`, `_` or `-`). Pull side, strict and silent: `packages/cli/src/agents/claude-code/plugins.ts:37-59` (`PluginManifestSchema`: `add` refuses `%`, `&`, `;`; ids must start with a letter or digit), `packages/cli/src/agents/claude-code/after-restore.ts:37-49` (programs schema), `:51-64` (`readJson` returns `null` on any failure), `:97-98` and `:129-130` (`null` means "nothing to do", no message).
- **Problem:** The push side and the pull side check the same file with different rules. A marketplace saved from a `url` source with a percent-encoded path or a query string (`https://host/my%20market.json`, `…?a=1&b=2`) is saved by push; on pull `PluginManifestSchema` rejects the **whole** `plugins.json`, so not one plugin is offered and no warning is printed. Verified: plain URL `true`, `%20` `false`, `&` `false`. The same holds for a plugin id such as `.x@m` (push regex `[A-Za-z0-9._-]+@…` vs pull `[A-Za-z0-9][…]*@…`) and for a program named `_tool` in `programs.json`.
- **Why it matters:** A user's plugins silently fail to come back on the new PC, and nothing tells them why. Refusing such URLs on pull is right (they reach a command line); the bug is that push saves them and pull hides the refusal.
- **Fix:** Export the entry schemas (marketplace, plugin, program) and use them on both sides. On push, check each entry and move failures into the manifest's `skipped` list (push already reports `skipped`, e.g. "its marketplace is a local folder"). On pull, when `.agentnomad/plugins.json` or `programs.json` is present but unreadable, warn ("Saved plugins could not be read: …") instead of returning `nothingToDo` silently. Optionally parse per entry so one bad entry does not drop the rest.
- **Effort:** S
- **Confidence:** high

#### BUG-02 · Low · A failed housekeeping prune fails the user's login or save

- [x] **Where:** `packages/server/src/rate-limit/postgres-rate-limiter.ts:49-54`; wired at `packages/server/src/server.ts:67-69`
- **Problem:** About 1 in 100 calls to `hit` also runs `delete from rate_limits …` and `alsoPrune()` (`sessions.deleteExpired()`, added by the DB-02 fix), awaited with no `try/catch`, after the hit was already counted. If either delete fails (a dropped connection, a lock or statement timeout), `hit` throws, so `limitPerIp`, `guardedCheck` (login, account delete) or the bundle `writeLimit` answer 500 for a request that was fine. The bundle service does the same kind of cleanup "quietly" (`bundle-service.ts:108-114`: caught and logged).
- **Why it matters:** A housekeeping problem shows up to a random user as "Something went wrong on the server" on login or push; the prune also adds two unbounded deletes to that user's wait.
- **Fix:** Catch and log inside `hit` (add a `logError` dep like `BundleServiceDeps`), or start the prune without awaiting it and attach a `.catch` that logs. Test: `alsoPrune` that rejects → `hit` still resolves with the right status.
- **Effort:** S
- **Confidence:** high (by reading; no test makes the prune fail)

#### BUG-03 · Low · `installed_plugins.json` is read twice with different rules for "this project"

- [x] **Where:** `packages/cli/src/agents/claude-code/plugin-sync.ts:57-88` (its own schema; `install.projectPath !== projectDir` at `:83`); `packages/cli/src/agents/claude-code/plugins.ts:71-81` (`InstalledPluginsSchema`) and `:140-145` (uses `samePath`)
- **Problem:** Push decides which project plugins belong to a project with `samePath` (case-insensitive on Windows, normalized). Pull's "is it already installed here?" check uses plain string equality. On Windows, the same folder written as `e:\projects\app` by one and `E:\Projects\app` by the other (the current folder's drive-letter case depends on how the shell was started) counts as "not installed".
- **Why it matters:** Pull then offers to reinstall project plugins that are already there, on every pull, and runs `claude plugin install` again. Two readers of one file will drift further over time.
- **Fix:** One reader of `installed_plugins.json` in `plugins.ts` (one schema), used by both `readPluginManifest` and `readCurrentPlugins`, comparing with `samePath(..., platform)`.
- **Effort:** S
- **Confidence:** medium (depends on how Claude Code writes `projectPath`; the code mismatch itself is certain)

#### BUG-04 · Low · JSON merge turns an out-of-range number into `null`

- [x] **Where:** `packages/core/src/merge-strategies.ts:41-46` (`hasUnsafeInteger`), used at `:57` and `:118`
- **Problem:** T45 keeps a JSON file side by side when it holds "a number a merge would change". The check only looks for integers outside the safe range. A number too large for a double (`1e400`) parses to `Infinity`; `Number.isInteger(Infinity)` is false, so the file is merged, and `JSON.stringify(Infinity)` writes `null`. Confirmed: `{"limit":1e400}` comes back as `{"limit":null}`.
- **Why it matters:** A pull with `--merge` silently changes a value in the user's settings file. Rare (such numbers are unusual in config), which is why it is Low.
- **Fix:** Treat any non-finite number as unsafe too: `typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))`, and add the case next to the T45 test in `merge-strategies.test.ts:109-114`.
- **Effort:** S
- **Confidence:** high

### Security

#### SEC-01 · Medium · One malformed hook or MCP server hides every hook or server in that file from the pull review

- [x] **Where:** `packages/cli/src/agents/claude-code/command-review.ts:46-54` (schemas `Hook`, `Hooks`, `Servers`), `:109-110` (hooks parsed as one record), `:199-200` (servers parsed as one record); the same all-or-nothing parse in `packages/cli/src/agents/claude-code/settings-commands.ts:9-18,32-33` (`commandsInSettings`)
- **Problem:** `Hooks.safeParse(json['hooks'])` and `Servers.safeParse(json['mcpServers'])` validate the whole block at once. If any single entry does not match (one hook with `args: [1]`, a stray `"_note": "…"` string under `hooks`, one server set to `null`), `success` is false and the code falls back to `{}`: **no** hook or **no** MCP server from that file is listed for review. The file itself is still written. Verified with the real source:
  ```
  hooks valid      -> 1 entry      hooks + bad args -> 0      hooks + note str -> 0
  mcp valid        -> 1 entry      mcp + null entry -> 0
  ```
  On the restore side, `commandsInSettings` fails the same way, so home-folder scripts are refused (safe), but inline commands such as `curl … | sh` in the valid hooks are restored without being shown.
- **Why it matters:** "Nothing runs without being shown" is a core rule (ARCHITECTURE §1 rule 5). The review fails open: one bad sibling silences every other entry. Whether Claude Code then runs the valid hooks or servers depends on how it treats a partly invalid settings file; I could not confirm that, hence medium confidence on impact.
- **Fix:** Parse per item, and fail closed. Walk `hooks` as `Record<string, unknown>`, then each group and each hook with its own `safeParse`; walk `mcpServers` per server. When an item cannot be read, add a review entry such as `{label: 'hook PreToolUse (unreadable)', command: <the raw JSON, printable>}` so pull asks about it. Do the same in `commandsInSettings` (skip only the bad item). One shared per-item walker in `settings-commands.ts` can serve both files.
- **Effort:** S
- **Confidence:** high that the review drops everything (reproduced); medium that Claude Code runs the remaining entries.

#### SEC-02 · Low · A ` ```! ` block is missed when an earlier code block holds a fence line of the other character

- [x] **Where:** `packages/cli/src/agents/claude-code/runnable-markdown.ts:17-27`
- **Problem:** Any fence line with an empty info string closes the current block, whatever its character (`` ` `` vs `~`) or length. Markdown (CommonMark) closes a fence only with the same character and at least the same length. Text such as ` ``` / example / ~~~ / ``` / ```! / curl … | sh / ``` ` is read as: the `~~~` closes the first block, the next ` ``` ` opens a plain block, and the real ` ```! ` block is then inside that plain block and is not reported. Verified: `runnableInMarkdown(...)` returned `[]`.
- **Why it matters:** The ` ```! ` block runs by itself when the skill loads; the pull review is the only place it is shown. The trigger is an unusual (or deliberately crafted) Markdown file, so the risk is low.
- **Fix:** Remember the opening fence's character and length; close only on a line of the same character, at least that long, with nothing after it; treat a fence indented 4 or more spaces as plain text. Add the case above to the tests.
- **Effort:** S
- **Confidence:** high for the detector; medium that Claude Code's own parser would run that block (it follows CommonMark as far as I know).
- **Fixed differently (T69):** the closing rule is as above, but a fence still opens at any indentation. A block inside a list item is indented with the item, so reading a fence indented 4 or more spaces as plain text would hide a block that runs. The review fails toward showing.

#### SEC-03 · Low · Review lists print commands from a bundle with their line breaks

- [x] **Where:** `packages/cli/src/pull/pull-command.ts:336-343` (each `entry.command` joined into the review message); `packages/cli/src/ui/printable.ts:8` keeps `\n` (0x0a) and tab.
- **Problem:** `printable` (T44) stops escape sequences so a bundle cannot redraw the review list. A hook or MCP command from a pulled bundle can still hold newlines, though, and they are printed as real line breaks. A command like `curl … | sh\n  ~ statusLine: ccstatusline  (changed)` then adds lines that look like extra, harmless review entries. `command-review.ts:77-79` does not flatten the command.
- **Why it matters:** it is the same goal T44 protects ("make a review list look harmless"). It cannot hide the real command, which is still printed first, so the risk is low.
- **Fix:** show the single-line fields of a review entry (`label`, `command`) with line breaks escaped. For example, add `printableLine(text)` that also maps `\n`, `\r` and tab to `\u{…}`, and use it for `entry.label` and `entry.command`.
- **Effort:** S
- **Confidence:** medium

### Database and queries

#### DB-01 · Low · `GET /bundles` checks the session twice

- [x] **Where:** `packages/server/src/http/routes/bundles.ts:75` and `:82`
- **Problem:** `routes.use('/bundles', requireSession(auth))` and `routes.use('/bundles/*', requireSession(auth))`. In Hono 4.13.9 the `/bundles/*` pattern also matches `/bundles`, so the list route runs `requireSession` twice: two SHA-256 hashes and two session queries per request. Confirmed with the real `createApp` and a counting fake: `GET /bundles` → 2 `authenticate` calls, `GET /bundles/x/y` → 1.
- **Why it matters:** One extra round trip to Neon on every list (status, pull and every command that lists). Results stay correct.
- **Fix:** Keep only `routes.use(\`${API_ROUTES.bundles}/*\`, requireSession(auth))`(it covers`/bundles`too) and add a test that counts`authenticate` calls for the list.
- **Effort:** S
- **Confidence:** high (reproduced)

### Performance

#### PERF-01 · Low · A download holds the 5 MB bundle three times

- [x] **Where:** `packages/server/src/http/routes/bundles.ts:112-113`; `packages/server/src/db/schema.ts:32-33`
- **Problem:** The driver returns a `Buffer`; `bytea.fromDriver` copies it into a new `Uint8Array` (already backed by a plain `ArrayBuffer`); the route copies it again (`new Uint8Array(ciphertext)`) only to satisfy the `c.body` type.
- **Why it matters:** Up to about 15 MB per concurrent download on Render's free instance (512 MB). Small today, the first memory limit to hit with parallel pulls.
- **Fix:** Type the blob store's bytes as `Uint8Array<ArrayBuffer>` (what `fromDriver` really returns) and pass `ciphertext` straight to `c.body`; drop the copy and its comment.
- **Effort:** S
- **Confidence:** medium (the copies are certain; the memory figure is an estimate)

#### PERF-02 · Low · The Linux / Node 24 CI job runs the whole test suite twice

- [x] **Where:** `.github/workflows/ci.yml:53-54` (`pnpm check` runs `vitest run`) and `:70-73` (`pnpm test:coverage` runs it again with coverage)
- **Problem:** The same 1,200+ tests run twice in the job that also does the audit, the migration check, knip, the package build and the e2e steps, all under a 15-minute timeout (`:23`).
- **Why it matters:** A few minutes per push on the slowest job, and less headroom before the timeout as tests grow.
- **Fix:** In that one job, run `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:coverage` instead of `pnpm check` (coverage still fails on a failing test; keep `continue-on-error` off for it there), and `pnpm check` in the others.
- **Effort:** S
- **Confidence:** high

#### PERF-03 · Low · Render installs and compiles the whole monorepo to deploy the server

- [x] **Where:** `render.yaml:16` (`corepack pnpm install --frozen-lockfile && corepack pnpm build`); root `package.json:16` (`build` = `tsc --build` over all five packages, `tsconfig.json:3-9`)
- **Problem:** The API needs only `contracts` and `server`, but the build installs every workspace's dependencies (CLI keychain bindings, PGlite, Vite, ESLint, …) and compiles `core`, `cli` and `e2e` too.
- **Why it matters:** Slower deploys on the free plan, and a type error in the CLI or e2e code (which `buildFilter` does not watch) blocks the next server deploy.
- **Fix:** `corepack pnpm install --frozen-lockfile --filter @agentnomad/server... && corepack pnpm exec tsc --build packages/server`.
- **Effort:** S
- **Confidence:** medium (the commands are certain; check that Render's build still finds `typescript` with the filtered install)

### User experience

#### UX-01 · Low · Login and register drop the current login before the new credentials are checked

- [x] **Where:** `packages/cli/src/auth/auth-commands.ts:135-149` (`readyForNewLogin` calls `logOut`), run first at `:176` (register) and `:224` (login), before the username, password, prelogin and login at `:226-268`.
- **Problem:** after "You are already logged in on this PC. Log out and continue?" (or `--yes`), the working session is ended on the server and removed from the PC immediately. A mistyped password, a taken username, a "no" at the no-recovery warning (`:181-184`, which then says only "No account was created."), Ctrl+C at the password prompt, or a bad `--password-stdin` all leave the user logged out of the account they had.
- **Why it matters:** a typo costs a working login, and getting it back needs the old account's password. A script with `login --yes` that fails leaves the PC with no login at all, and every later push or pull fails.
- **Fix:** gather and check the new credentials first: ask the username and password, then prelogin and login (or register). Only when the new session and data key are in hand, log out the old session and save the new one. If that order is kept on purpose, say in the question that the current login ends even if the new one fails.
- **Effort:** S
- **Confidence:** high

#### UX-02 · Low · Logout says "Could not reach the server" for every failure

- [x] **Where:** `packages/cli/src/auth/auth-commands.ts:157-171`
- **Problem:** every error from `api.auth.logout()` other than `unauthorized` shows "Could not reach the server, so only this PC was logged out." That includes a 429 `rate_limited`, a 500 `internal_error` and an `InvalidResponseError` (a wrong server or a proxy page), where the server was reached.
- **Why it matters:** the message points the user at their network when the cause is a rate limit or a server fault. It also hides the server's own message and the Retry-After that `describeError` (`cli/error-messages.ts:14-24`) would show.
- **Fix:** keep the network wording for `NetworkError`. For other errors, warn "The server did not end the session (`describeError(error)`), so only this PC was logged out. …".
- **Effort:** S
- **Confidence:** high

#### UX-03 · Low · `agentnomad env` in the home folder lists the global setup twice

- [x] **Where:** `packages/cli/src/env/env-command.ts:38-48`; compare the refusal push and pull apply at `packages/cli/src/push/push-command.ts:160-172` and `packages/cli/src/pull/pull-command.ts:162-170`.
- **Problem:** `env` always collects the current folder as a project. In the home folder (where a new terminal starts), the project collector reads `~/.claude/settings.json` as `.claude/settings.json` and walks `~/.claude/skills`, `agents`, … a second time (`agents/claude-code/project-collector.ts:84-109`). Every variable is then listed as used by both "Claude Code global" and "Claude Code this project". BUG-05 (T60) made the home folder and the agent's folder never a project in push and pull, but `env` was not included.
- **Why it matters:** the output is misleading (the home folder is not a project) and the global folders are read twice.
- **Fix:** skip the project scan when `projectFolderRefusal(cwd, { homedir, baseDir: found.baseDir, … })` is not null. `EnvCommandDeps` then needs `homedir` and `platform`.
- **Effort:** S
- **Confidence:** high

#### UX-04 · Low · `delete --agent <id>` with nothing saved for that agent shows an empty checklist

- [x] **Where:** `packages/cli/src/commands/setup-commands.ts:150-167`
- **Problem:** the "nothing saved" check looks at all setups (`setups.length === 0`), not at the ones that match the flags. With `--agent X` and no `--global`/`--project`, when X has no saved setup but another agent does, `chosen` is empty and the user gets "Which saved setups to delete…" with no options. With `--global`/`--project`, the same situation gives the clear "No saved setup matches. Run `agentnomad list` to see them." (`:155-157`). Without a terminal it fails as "needs an answer" with a flag hint, though no flag can answer it.
- **Why it matters:** the same mistake gives different answers depending on the flags. One of those answers is a question with nothing to choose.
- **Fix:** after `matching`, if `chosen.length === 0` throw the same "No saved setup matches" error, whatever flags were given.
- **Effort:** S
- **Confidence:** medium (the code path is confirmed; how clack draws a multiselect with no options was not checked)

### Dead code

#### DEAD-01 · Low · `syncPlugins` is kept only for tests

- [x] **Where:** `packages/cli/src/agents/claude-code/plugin-sync.ts:135` (`SyncPluginsDeps`), `:247-250` (`syncPlugins`); used only in `packages/cli/test/claude-code-plugins.test.ts` and `packages/cli/test/managed-settings.test.ts`
- **Problem:** Since T61, production calls `askPluginSync` in the plan step and `installPlugins` in the follow-up (`after-restore.ts:108,119`). `syncPlugins` (ask then install in one call) is no longer used by the CLI; `knip` does not flag it because test files count as users.
- **Why it matters:** The tests exercise a combination production never runs, and a reader may think pull still asks and installs in one go.
- **Fix:** Remove `syncPlugins` and `SyncPluginsDeps`; point those tests at `askPluginSync` + `installPlugins`.
- **Effort:** S
- **Confidence:** high
- **Also found by a second reviewer:** `packages/cli/src/agents/claude-code/plugin-sync.ts:247-250`; callers `packages/cli/test/claude-code-plugins.test.ts:225`, `packages/cli/test/managed-settings.test.ts`

#### DEAD-02 · Low · `restoreEnvValues` is only used by tests, and its helper's comment is stale

- [x] **Where:** `packages/cli/src/env/env-restore.ts:45-56` (`restoreEnvValues`), `:27-32` (comment: "Shared by the restore and pull's no-terminal pre-check"); only callers are in `packages/cli/test/env-secrets.test.ts:409-578`. Production pull calls `planEnvRestore` and `writeEnvValues` directly (`pull/pull-command.ts:450, 531`).
- **Problem:** T59 split the restore into plan and apply. The combined function stays only so the tests can call it, and the no-terminal pre-check named in the comment was removed by T59. knip does not flag it because the test project counts as a user.
- **Why it matters:** a reader thinks there are two production paths for env restore and looks for a pre-check that no longer exists.
- **Fix:** move the tests to `planEnvRestore` + `writeEnvValues` (or a small helper in the test file), delete `restoreEnvValues`, and change the comment on `splitEnvValues` to "used by `planEnvRestore`".
- **Effort:** S
- **Confidence:** high

#### DEAD-03 · Low · `UserRepository.create` is only used by tests, and `bytea` is exported for one file

- [x] **Where:** `packages/server/src/db/repositories.ts:38-39`; `packages/server/src/db/user-repository.ts:58`; `packages/server/src/db/schema.ts:30`
- **Problem:** Since DB-03, register calls `createWithSession`; no file in `src` calls `users.create` (all call sites are in `test/`). `bytea` is exported but only used inside `schema.ts`, against the T65 rule "a name used only in its own file is not exported" (knip does not see it because `index.ts` re-exports the module).
- **Why it matters:** Every future `UserRepository` (the docs plan other storage) must implement a method production never calls.
- **Fix:** Tests create users with a helper in `test/support/` (direct insert or `createWithSession`), and `create` leaves the interface; or keep it and tag it `@public` as test support. Drop `export` from `bytea`.
- **Effort:** S
- **Confidence:** high

### Duplication

#### DUP-01 · Low · The same test fakes are copied into many files, and the copies behave differently

- [ ] **Where:**
  - logged-in SecretStore: `setup-commands.test.ts:123`, `push-command.test.ts:143`, `pull-command.test.ts:110`, `agent-boundary.test.ts:104`, plus `interfaces.test.ts:14`
  - empty (logged-out) SecretStore literal: `setup-commands.test.ts:219`, `push-command.test.ts:712`, `pull-command.test.ts:732`
  - scripted prompter: `setup-commands.test.ts:148`, `push-command.test.ts:157`, `pull-command.test.ts:124`, `agent-boundary.test.ts:118` (`auth-commands.test.ts:90` has its own variant)
  - recording reporter: `setup-commands.test.ts:164`, `push-command.test.ts:174`, `pull-command.test.ts:141`, `agent-boundary.test.ts:135`
  - in-memory bundle server: `setup-commands.test.ts:70`, `push-command.test.ts:100`, `pull-command.test.ts:66`
- **Problem:** Each test file defines its own copy. The copies have drifted. Push's server enforces `expectedRevision` and answers 409 like the real API (`push-command.test.ts:125-134`); pull's server ignores it and always stores (`pull-command.test.ts:75-79`). Setup-commands' scripted prompter returns `undefined` when it runs out of answers; push's and pull's throw `No answer scripted`.
- **Why it matters:** Pull tests that push from several PCs (`:684-721`, `:820-852`) run against a server that never refuses a stale upload. A push bug hidden by that would pass there. Every interface change has to be made in four or five places.
- **Fix:** Add one `packages/cli/test/fakes.ts` next to `stub-restorer.ts` with `memorySecretStore({ loggedIn })`, `scriptedPrompter` (throws when out of answers), `recordingReporter` and `fakeBundleServer` (enforces revisions like the real API). Point every test at it.
- **Effort:** M
- **Confidence:** high
- **Also found by a second reviewer:** `scripted` / `scriptedPrompter`: `agent-boundary.test.ts:118-133`, `auth-commands.test.ts:90-112`, `push-command.test.ts:157`, `pull-command.test.ts:124`, `setup-commands.test.ts:148`. `recorder` / `recordingReporter`: `agent-boundary.test.ts:135-145`, `auth-commands.test.ts:114-127`, `push-command.test.ts:174`, `pull-command.test.ts:141`, `setup-commands.test.ts:164`. `loggedIn` / `memorySecrets`: `agent-boundary.test.ts:104-116`, `auth-commands.test.ts:62-84`, `push-command.test.ts:143`, `pull-command.test.ts:110`, `setup-commands.test.ts:123`. Inline reporters: `claude-code-account-skills.test.ts:226-232`, `claude-code-after-restore.test.ts:73-79`, `claude-code-restorer.test.ts:1107-1113`. Inside one file: the "damage the wrapped key" steps at `auth-commands.test.ts:415-419` are repeated at `:768-772`.

#### DUP-02 · Low · The API is wired in three places, and no test runs the production wiring

- [x] **Where:** `packages/server/src/server.ts:57-93`; `packages/server/test/support/app.ts:31-68`; `packages/e2e/src/local-server.ts:59-80`
- **Problem:** Each builds keys, limiter, auth service, bundle service and app by hand. Only production wires `alsoPrune` (expired sessions) and logs cleanup failures. The two copies leave `shouldSweep` at its random default (`Math.random() < 0.02`, `bundle-service.ts:106`) while their `logError` throws, so about 1 save in 50 in route and e2e tests also runs the sweep, and a sweep failure would fail a random test. `createServerFromEnv` itself is only tested for `/health` (`limits-and-logs.test.ts:275-284`).
- **Why it matters:** A wiring mistake in `server.ts` is not caught by any test, and each new dependency has to be added three times.
- **Fix:** One `createApi({ db, keys, clientIp, logger, now, randomBytes, shouldPrune, shouldSweep, logError })` in `src`; `createServerFromEnv` only reads settings and builds the Neon pool, and test support and e2e call `createApi` with PGlite and `shouldSweep: () => false`.
- **Effort:** S
- **Confidence:** high

#### DUP-03 · Low · Two different implementations of "which project scripts do the hooks run"

- [x] **Where:** `packages/cli/src/agents/claude-code/project-collector.ts:39-59` (push) and `packages/cli/src/agents/claude-code/restore-rules.ts:118-134` (`projectHookScripts`, pull)
- **Problem:** For the global setup one function, `hook-scripts.ts` `hookScripts`, serves both push and pull. For projects there are two, with different rules: the collector accepts an absolute path that is inside the project (`/home/ana/app/scripts/a.sh` → `scripts/a.sh`), while `projectHookScripts` skips every word starting with `/`, a drive letter, `~`, `$` or `%`. Such a script is saved by push and then refused by pull with "not part of a Claude Code setup".
- **Why it matters:** Push and pull disagree about the same setup, and any future rule change must be made twice.
- **Fix:** Move the project rule next to `hookScripts` in `hook-scripts.ts` as one function that takes the project folder when it has one, and call it from both the collector and the restorer.
- **Effort:** S
- **Confidence:** high (code read on both sides); low impact, since absolute hook paths rarely move between PCs

#### DUP-04 · Low · "Parse JSON text with a schema, `null` on failure" is written six times

- [x] **Where:** `packages/cli/src/agents/claude-code/after-restore.ts:51-64`, `plugins.ts:107-114`, `command-review.ts:57-64`, `settings-commands.ts:21-28`, `managed-settings.ts:72-80`, `account-skills.ts:65-74`
- **Problem:** The same try / `JSON.parse` / `safeParse` / `null` block in six files, each with small differences (bytes vs text, file vs bundle entry).
- **Why it matters:** Small, but it is how BUG-01's silent `null` crept in: none of the copies can report _why_ a file was dropped.
- **Fix:** One helper, e.g. `parseJsonWith(schema, text | bytes): { value } | { problem }`, in `settings-commands.ts` (already the "parsing" module) or `system/`, returning the problem so callers can warn.
- **Effort:** S
- **Confidence:** high

#### DUP-05 · Low · The "Claude Code global setup / project "x"" label is built in four places

- [x] **Where:** `packages/cli/src/push/push-command.ts:109-110`, `packages/cli/src/pull/pull-command.ts:109-110`, `packages/cli/src/commands/setup-commands.ts:41-42`, `packages/cli/src/pull/saved-setups.ts:126`
- **Problem:** the same rule (`global setup` or `project "<name>"`, sometimes with the agent's display name in front) is written four times, from three input shapes (`PushItem.scope`, `SavedSetup.projectName`, twice).
- **Why it matters:** the wording appears in user messages and in the "Not saved / Not restored" list. A change (quoting, a new scope kind) has to be made four times to keep the messages the same.
- **Fix:** one `setupLabel(displayName: string | null, projectName: string | null)` in `cli/setup-outcomes.ts` (or `ui/`), used by all four.
- **Effort:** S
- **Confidence:** high

#### DUP-06 · Low · Test fixtures are copied across the test files

- [x] **Where:**
  - KDF settings literal equal to `DEFAULT_KDF_PARAMS`: `test/bundle-service.test.ts:47-53` and `:88-94`, `test/repositories.test.ts:25-31`, `test/schema.test.ts:14-20`
  - The same user fixture twice in one file: `test/bundle-service.test.ts:44-56` and `:84-97`
  - PGlite plus migrations set up by hand: `test/schema.test.ts:12` and `:27-32` (same as `test/support/database.ts:9-23`)
  - A `register` helper in four files: `account-routes.test.ts:28-41`, `auth-routes.test.ts:39-43`, `bundle-routes.test.ts:36-49`, `limits-and-logs.test.ts:31-46`; `b64` and `bytes` helpers in five files
- **Problem:** The same setup is written out many times.
- **Why it matters:** A change to the register body or the KDF bounds means editing every copy.
- **Fix:** `test/support/fixtures.ts` with `b64`, `bytes`, `newUser()` and `registerUser(app, name, options)`; use `DEFAULT_KDF_PARAMS`; `schema.test.ts` uses `createTestDatabase`.
- **Effort:** S
- **Confidence:** high

#### DUP-07 · Low · Pull tests copy a 15-line push setup because `pushFrom` has no `env` option

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:779-793` and `:862-876` (identical), helper at `:167-192`
- **Problem:** Two tests need push to see `GITHUB_TOKEN`, so they rebuild `createPushCommand` with every dependency instead of calling `pushFrom`. They also use a different state file name (`s.json`) from `pushFrom` (`state.json`).
- **Why it matters:** A change to `PushDeps` must be made three times in this file. The different state file is an easy way to get a confusing result.
- **Fix:** Add `env?: Record<string, string>` to `pushFrom`'s options and call it from both tests.
- **Effort:** S
- **Confidence:** high

#### DUP-08 · Low · Core tests carry their own hex helper

- [x] **Where:** `packages/core/test/crypto.test.ts:17-18`; `packages/core/test/project-names.test.ts:25-26`
- **Problem:** Both define `hex = (bytes) => Array.from(bytes, …padStart(2,'0')).join('')`, the same as `toHex` in `packages/contracts/src/encoding.ts:21-23`, which core already depends on.
- **Fix:** `import { toHex } from '@agentnomad/contracts'` in both tests.
- **Effort:** S
- **Confidence:** high

### Readability

#### READ-01 · Low · Names that say something other than what the code does

- [x] **Where:** `packages/cli/src/agents/claude-code/plugin-sync.ts:11,299` (`ClaudeCli`, `createClaudeCli`) also run `npm` (`after-restore.ts:69,94,163`); `hookScripts` names three different things: the exported function (`hook-scripts.ts:40`), an inner function of the project collector (`project-collector.ts:39`) and a `Set` parameter (`restore-rules.ts:69,87,142`); `unknown-files.ts:50` hard-codes `'.agentnomad/'` instead of `RESERVED_DIR` / `HOME_SCRIPTS_PREFIX` from `global-paths.ts`.
- **Problem / why it matters:** A reader of `after-restore.ts` sees `cli(npmPath)` returning a `ClaudeCli`; a search for `hookScripts` lands in three unrelated places; the literal path breaks silently if the reserved folder name changes.
- **Fix:** Rename to `ProgramCli` / `createProgramCli` (or `LauncherCli`); rename the collector's inner function to `projectHookScriptFiles` and the `Set` parameters to `allowedScripts`; use the constant.
- **Effort:** S
- **Confidence:** high

#### READ-02 · Low · A doc comment sits on the wrong declaration in `saved-setups.ts`

- [x] **Where:** `packages/cli/src/pull/saved-setups.ts:54-56` and `:85`
- **Problem:** the comment "Every saved setup of the account (all pages), names decrypted; unreadable names are left out." is stacked on top of the `MAX_PAGES` comment and constant. `listSavedSetups` at `:85`, which it describes, has no doc of its own. Editor hovers show the wrong text for both.
- **Why it matters:** `listSavedSetups` quietly drops setups whose name does not decrypt. That is the one thing a caller needs to know, and it is missing where they look.
- **Fix:** move the line onto `listSavedSetups`.
- **Effort:** S
- **Confidence:** high

#### READ-03 · Low · The restorer test file is 1191 lines and tests several other modules

- [ ] **Where:** `packages/cli/test/claude-code-restorer.test.ts:939-988` (`isClaudeProcess`, `createClaudeRunningCheck` from `running-claude.ts`), `:1019-1042` (`windowsNameProblem`), `:1080-1191` (the adapter's `planRestore`)
- **Problem:** One file covers the restorer, the running-Claude process check, the Windows name rules and the adapter's plan step. `PluginManifestSchema` is likewise tested in three files (`claude-code-after-restore.test.ts:163-184`, `claude-code-command-review.test.ts:363-385`, `claude-code-plugins.test.ts:164-175`).
- **Why it matters:** Someone looking for the tests of `running-claude.ts` or of the plan step will not find them by file name. A file this long is slow to review, and new cases tend to land wherever is open.
- **Fix:** Move `running Claude Code` to `claude-code-running.test.ts`, and the plan-step block to `claude-code-adapter.test.ts`, or to `agent-registry.test.ts`, which already tests the adapter. Keep the manifest-schema cases in `claude-code-plugins.test.ts` only.
- **Effort:** S
- **Confidence:** high

#### READ-04 · Low · An invisible non-breaking space in a test case

- [ ] **Where:** `packages/cli/test/system.test.ts:80`
- **Problem:** The case `['a non-breaking space', 'a b']` contains a raw U+00A0 (bytes `c2 a0`, checked with `od -c`). In an editor it looks like a normal space.
- **Why it matters:** A formatter, a copy-paste or an editor setting can silently turn it into a normal space. The test would then check an ordinary space, and the NBSP case would quietly disappear.
- **Fix:** Write it as `'a\u00a0b'`.
- **Effort:** S
- **Confidence:** high

#### READ-05 · Low · Tests filed under the wrong file or describe block

- [ ] **Where:**
  - `setup-commands.test.ts:260-314`: local-state tests (T56, BUG-06) in the `list`/`status`/`delete` file
  - `setup-commands.test.ts:352-455`: `account delete` tests. The code is in `auth/auth-commands.ts`, and `auth-commands.test.ts:802-840` also tests account delete.
  - `secret-store.test.ts:212-244`: two `createFileStore` tests inside `describe('createSecretStore')`
  - `system.test.ts:263-292`: pure parsers (`aclPrincipals`, `principalsToRemove`) inside "the real programs", so they get a temp folder and a 30 s timeout they do not need
  - `env-secrets.test.ts:666`: a `quotePosix` assertion inside "marks variables the settings set"
  - `program.test.ts:276-283`: repeats `:215-221` (a command error becomes exit 1 with its message), using a stale message "coming in T33"
  - `env-secrets.test.ts`: the file name says "secrets", but it tests five `env/` modules
- **Problem:** Tests sit away from the code they cover, or under a heading that says something else.
- **Why it matters:** Someone changing `auth-commands.ts` or `local-state.ts` will not find half of its tests, and coverage looks thinner or thicker than it is.
- **Fix:** Move account-delete cases to `auth-commands.test.ts` and local-state cases to a `local-state.test.ts`. Rename the describe in `secret-store.test.ts`. Move the two ACL parser tests out of the real-program block. Delete `program.test.ts:276-283`. Rename `env-secrets.test.ts` to `env.test.ts`.
- **Effort:** S
- **Confidence:** high

#### READ-06 · Low · Code comments still say cursors are tamper-checked (BUG-07 fix incomplete)

- [x] **Where:** `packages/server/src/db/bundle-cursor.ts:53`; `packages/server/src/db/repositories.ts:26` and `:147-148`
- **Problem:** "Throws InvalidCursorError for anything this server did not produce" and "A list cursor that was not produced by this server (or was changed)". The cursor is base64url JSON that is only format-checked; anyone can build one (`repositories.test.ts:527` does). BUG-07 asked for the wording to change; ARCHITECTURE.md now says "format-checked", these comments do not.
- **Why it matters:** A later change could rely on cursors being signed. Harmless today: the query is always scoped to the user.
- **Fix:** Say "a cursor that is not well-formed" in all three places.
- **Effort:** S
- **Confidence:** high

#### READ-07 · Low · The 5 MB limit is written as a literal next to the constant

- [x] **Where:** `packages/server/src/http/routes/bundles.ts:125-127`; `packages/server/test/schema.test.ts:228`
- **Problem:** `maxSize: MAX_BUNDLE_BYTES`, but the message is the literal "A saved setup can be at most 5 MB"; the schema test uses `5 * 1024 * 1024 + 1`. `overLimit` (`bundle-service.ts:35-38`) builds its MB figure from the constant, so the same job is done two ways.
- **Why it matters:** If the limit changes, the message and the test lie.
- **Fix:** Build the sentence from `MAX_BUNDLE_BYTES / 1024 / 1024` (same text today) and use the constant in the test.
- **Effort:** S
- **Confidence:** high

#### READ-08 · Low · SERVER_SECRET comments leave out the rate-limit pseudonyms

- [x] **Where:** `packages/server/.env.example:7-9`; `packages/server/src/db/env.ts:24-26`
- **Problem:** Both say the secret keys "the auth-key hashes and fake prelogin salts". It also keys the rate-limit pseudonyms (`server-keys.ts:12`, `:55`), as ARCHITECTURE.md section 3 says.
- **Why it matters:** Small: someone reading only the env file does not know every use of the secret.
- **Fix:** Add "and the rate-limit keys" in both places.
- **Effort:** S
- **Confidence:** high

#### READ-09 · Low · The project name's 400-byte limit can never be reached, and two tests describe the wrong case

- [x] **Where:** `packages/contracts/src/bundle.ts:44-47`; `packages/contracts/test/bundle.test.ts:11-14`; `packages/core/test/project-names.test.ts:115-123`
- **Problem:** After NFC the name must be at most 100 UTF-16 units; one unit is at most 3 bytes of UTF-8 (a 4-byte character takes 2 units), so the name is at most 300 bytes and `utf8Length(stored) <= 400` is never the rule that refuses. The test "refuses one that grows past 400 bytes" (`'שּׁ'.repeat(100)`) is refused by the 100-unit rule (it normalises to 300 units). The test "fits the API size limit even for the longest name in 4-byte characters" uses 50 emoji (200 bytes); the real worst case is 100 three-byte characters (300 bytes).
- **Why it matters:** A reader trusts the 400-byte rule and the tests that seem to prove it; the second test does not test the worst case it names. Nothing is unsafe: 24 + 300 + 16 = 340 bytes fits `MAX_NAME_ENC_BYTES` (512).
- **Fix:** Keep the byte check as a guard but say in the comment that the 100-unit rule bounds it at 300 bytes; rename the bundle test to "grows past 100 characters (Hebrew presentation forms)"; use `'￿'.repeat(100)` (or another 3-byte character) for the worst case in the project-names test.
- **Effort:** S
- **Confidence:** high (computed with Node: `'שּׁ'.repeat(100).normalize('NFC').length` is 300)

#### READ-10 · Low · A broken table row in ARCHITECTURE.md

- [x] **Where:** `docs/ARCHITECTURE.md:782`
- **Problem:** The `knip.json` row ends with an extra empty cell (`|     |`), so the row has three cells in a two-column table.
- **Fix:** Remove the trailing `     |`.
- **Effort:** S
- **Confidence:** high

#### READ-11 · Low · "What the server can see" leaves out the CLI version and the IP address

- [x] **Where:** `SECURITY.md:152-154`; `docs/security/threat-model.md:122-123` (accepted risks) and `:3` ("Reviewed: 2026-09-26", although the file now records T55, T56 and T66)
- **Problem:** Both lists name the username, device names and setup metadata. Since T57 every request also carries the CLI version (`x-an-client`), which the server logs (`docs/ARCHITECTURE.md:463-465`), and the server sees each visitor's IP (stored only as a keyed pseudonym in `rate_limits`, `docs/ARCHITECTURE.md:449-451`).
- **Why it matters:** These are the user-facing privacy promises; they should match what the server receives, even when the extra items are harmless.
- **Fix:** Add "the agentnomad version of each request, and your IP address (kept only as a keyed pseudonym for rate limits)" to both lists; change the threat model header to "Reviewed 2026-09-26, updated through T66".
- **Effort:** S
- **Confidence:** high

#### READ-12 · Low · ROADMAP.md still says the runnable review will move behind the adapter

- [x] **Where:** `docs/ROADMAP.md:54-56`; also `:133` (the "claude.ai account items" stage sits after v2 and is missing from the stage table at `:5-11`)
- **Problem:** The roadmap says the review "will move behind the adapter (an `inspector.runnable` hook) with the second agent". T61 already did it, as `Restorer.reviewRunnable` (`packages/cli/src/agents/adapter.ts:134`), and ADDING-AN-AGENT.md already describes that.
- **Why it matters:** A contributor planning the second agent reads two different stories, and the hook name in the roadmap does not exist.
- **Fix:** Replace the bullet with "The runs-programs review is per adapter (`Restorer.reviewRunnable`); each agent describes its own." Move the claude.ai section up to the other v1.x stages and add it to the table.
- **Effort:** S
- **Confidence:** high

#### READ-13 · Low · Two different exported types are both called `FileConflict`

- [ ] **Where:** `packages/core/src/merge.ts:2-7` (`path`, `existing`, `incoming`); `packages/cli/src/agents/adapter.ts:84-88` (`path`, `question`)
- **Problem:** core's type is the input of a merge strategy; the CLI's is a question for pull's plan step. Both are exported from their package index under the same name.
- **Why it matters:** A file that needs both (an adapter's restorer does) must alias one, and a reader seeing `FileConflict` cannot tell which one is meant.
- **Fix:** Rename the CLI one to `ConflictToAsk` (or core's to `MergeInput`).
- **Effort:** S
- **Confidence:** high

#### READ-14 · Low · A test picks its secret by comparing the request body text

- [x] **Where:** `packages/e2e/test/plaintext.test.ts:55-62`
- **Problem:** `const tricky = body === JSON.stringify(...) ? ... : secret;` decides the expected secret by string-comparing the parameter, instead of passing it in the `it.each` row.
- **Why it matters:** A reader must work out the special case; adding a row with its own secret means touching the condition.
- **Fix:** Make each row `[name, body, secret]` and drop the condition.
- **Effort:** S
- **Confidence:** high

### Best practices

#### BP-01 · Low · Unchecked casts in test fakes

- [ ] **Where:** `packages/cli/test/setup-commands.test.ts:119`, `:160`, `:381`; `packages/cli/test/pull-command.test.ts:73`, `:137`, `:907`; `packages/cli/test/push-command.test.ts:105`
- **Problem:** Fakes are built as `{...} as unknown as ApiClient`, `as unknown as Prompter` and `{} as ApiClient['auth']`. CONTRIBUTING.md ("How we write code") says no unchecked casts. `push-command.test.ts:157-172` shows the typed alternative: a `Prompter` built without a cast.
- **Why it matters:** When an `ApiClient` or `Prompter` method is renamed or added, these fakes still compile. The test then fails at runtime with "x is not a function", far from the cause, or keeps passing on a path that no longer exists.
- **Fix:** Build the fakes from typed shared helpers (DUP-01). For a partial API, write a typed `fakeApi({ bundles: {...} })` that fills the rest with methods that reject `'not used'`, as `push-command.test.ts:120-121` does.
- **Effort:** S
- **Confidence:** high

#### BP-02 · Low · `pnpm test` writes to the developer's real OS keychain

- [ ] **Where:** `packages/cli/test/secret-store.test.ts:260-306`
- **Problem:** The "real OS keychain" test writes and deletes two entries under the service `agentnomad-test` on every run, on every OS. Lines 294-299 also read the real `agentnomad` service through `createSecretStore`. CONTRIBUTING.md ("Tests") says tests "must never read or write the real home folder, the real keychain or the hosted API". ARCHITECTURE section 11 says CI uses the real keychain on purpose.
- **Why it matters:** The risk is small: it uses a random `.invalid` server and cleans up in `finally`. But it contradicts the written rule. On a developer's Mac it can show a keychain prompt in the middle of a run, and a crash between `set` and `finally` leaves a test entry behind.
- **Fix:** Run the test only when an environment variable is set (CI already sets `AGENTNOMAD_EXPECT_KEYCHAIN` on Linux; add one for macOS and Windows CI), or write the exception into CONTRIBUTING.md.
- **Effort:** S
- **Confidence:** high

#### BP-03 · Low · `fromHex` accepts any text and the encoding helpers have no tests of their own

- [x] **Where:** `packages/contracts/src/encoding.ts:25-28` (`fromHex`), `:31-33` (`sameBytes`); callers `packages/server/src/auth/server-keys.ts:64`, `packages/server/src/http/routes/bundles.ts:143`
- **Problem:** `fromHex` drops an odd last character and turns non-hex pairs into 0 (`fromHex('abc')` → 1 byte, `fromHex('zz')` → `[0]`). `sameBytes` is not constant-time, and nothing says so. No test file imports `toBase64`, `fromBase64`, `toHex`, `fromHex` or `sameBytes` directly; they are covered only through other packages.
- **Why it matters:** Today every caller passes checked input (the header is schema-checked; the stored hash was written by the server), so nothing is wrong now. But these are the one shared copy every package uses (T62); a future caller with unchecked input gets wrong bytes instead of an error, or uses `sameBytes` on a secret.
- **Fix:** In `fromHex`, throw unless the text matches `/^(?:[0-9a-f]{2})*$/i`; add a JSDoc line to `sameBytes`: "not constant-time; never for secrets". Add `contracts/test/encoding.test.ts` with round trips (empty, all 256 byte values) and the invalid-hex cases.
- **Effort:** S
- **Confidence:** high

#### BP-04 · Low · CI cancels an older run on `main`, which the release gate then cannot find

- [x] **Where:** `.github/workflows/ci.yml:14-17` (`cancel-in-progress: true` for every ref); `.github/workflows/release.yml:163-175` (needs a successful CI run for the tagged commit)
- **Problem:** Two pushes to `main` within one CI run (about 10 minutes) cancel the first run. That commit then never gets a successful CI run, so tagging it fails the `ci-passed` gate; Render's `checksPass` also never deploys it.
- **Why it matters:** Only a nuisance (tag the later commit, or re-run CI), but the failure message "No successful CI run for …" does not say the run was cancelled.
- **Fix:** Cancel only on feature branches: `cancel-in-progress: ${{ github.ref != 'refs/heads/main' && github.ref != 'refs/heads/dev' }}`.
- **Effort:** S
- **Confidence:** medium (GitHub's documented concurrency behaviour; not observed in this repo's runs)

### System design

#### ARCH-01 · Medium · The generic env scan only knows Claude Code's files

- [ ] **Where:** `packages/cli/src/env/env-references.ts:9-26` (`CLAUDE_OWN_VARIABLES`, `MCP_FILES = {'.mcp.json', '.agentnomad/claude.json'}`, `SETTINGS_FILES = {'settings.json', '.claude/settings.json', '.claude/settings.local.json'}`) and `:61` (`fileLabel` → `~/.claude.json`); used for every agent by `packages/cli/src/push/push-command.ts:306` and `packages/cli/src/env/env-command.ts:46-47`; the Claude adapter imports these constants back from the generic folder at `packages/cli/src/agents/claude-code/command-review.ts:5`.
- **Problem:** `env/` is shared code that push and `env` run for any adapter, but which files hold `${VAR}` references, how the reserved `claude.json` entry is labelled, and which variable names the agent sets itself are Claude Code facts hard-coded there. There is no adapter hook for it, and `docs/ADDING-AN-AGENT.md` does not mention it. The T61 boundary lint rule covers `push/`, `pull/` and `cli/` only, so this is not caught.
- **Why it matters:** the roadmap's next agents (Codex, Gemini CLI, OpenCode, Cursor) keep MCP servers and settings in other files. For them, push would offer no environment values to save and `agentnomad env` would report "no environment variables" while their MCP servers need some. The bug is silent. It also breaks the stated rule "a new agent is a new folder plus one line" (ARCHITECTURE §6).
- **Fix:** move the file lists, own-variable names and labels into the adapter, for example an optional `envReferenceFiles: { mcp: Set<string>; settings: Set<string>; ownVariables: Set<string>; label?(path): string }` on `AgentAdapter` (or a `scanEnv(files)` on the collector). Have `scanEnvReferences` take it as a parameter, and move `MCP_FILES`/`SETTINGS_FILES` into `agents/claude-code/` so `command-review.ts` imports them from its own folder. Add `env/` to the `no-restricted-imports` files, and add a case to `test/agent-boundary.test.ts` that saves an env value for the fake agent.
- **Effort:** M
- **Confidence:** high

#### ARCH-02 · Low · The agent guide tells new adapters to import from the Claude Code adapter's folder

- [ ] **Where:** `docs/ADDING-AN-AGENT.md:101-111`, `:137-143`, `:186`, `:241`; the helpers live in `packages/cli/src/agents/claude-code/detector.ts` (`findExecutable`, `nodeDetectorSystem`, `DetectorSystem`) and `claude-code/file-gathering.ts` (`createFileGatherer`, `uniqueByPath`)
- **Problem:** The guide's sample code for the example adapter imports `../claude-code/detector.ts` and `../claude-code/file-gathering.ts`. These helpers are agent-independent, but they sit inside one adapter's folder, so the second adapter would depend on the first. The lint rule in `eslint.config.js:27-41` only guards `push/`, `pull/` and `cli/`.
- **Why it matters:** A change made for Claude Code in those files (for example to how links are followed or how the version is read) silently changes every other adapter, and the boundary T61 built for commands does not exist between adapters.
- **Fix:** Move the generic helpers to `packages/cli/src/agents/shared/` (or `system/`, next to `files.ts` and `run-program.ts`), re-export them from the old paths if needed, and update the guide. Optionally extend the lint rule so `agents/<a>/` cannot import `agents/<b>/`.
- **Effort:** S
- **Confidence:** high

#### ARCH-03 · Low · The restore side imports the global collector for one error class

- [x] **Where:** `packages/cli/src/agents/claude-code/claude-json-merge.ts:12` imports `ClaudeJsonError` from `packages/cli/src/agents/claude-code/global-collector.ts:37-43`
- **Problem:** The `~/.claude.json` merge (restore) depends on the global collector module (push) only to reuse its error class, so the restorer's import graph pulls in the whole collector (plugins, programs, account skills).
- **Why it matters:** Push and pull halves were split on purpose (SOLID-05); this import ties them back together and makes the collector harder to change on its own.
- **Fix:** Move `ClaudeJsonError` into `claude-json-merge.ts` (or a small `claude-json.ts` holding the path rule, the key selection and the error) and import it from the collector.
- **Effort:** S
- **Confidence:** high

#### ARCH-04 · Low · Module-boundary rules are checked by a regex over source text, not by the lint rule the project uses for boundaries

- [ ] **Where:** `packages/cli/test/claude-code-modules.test.ts:15-32`
- **Problem:** `imports()` matches only `import … from '…';`. An `export … from`, a dynamic `import()`, or a double-quoted specifier gets past the check. The project already enforces boundaries with ESLint `no-restricted-imports` (`eslint.config.js`, T61), which handles all of these forms.
- **Why it matters:** The SOLID-05 guarantee ("settings parsing has no file access") can be broken in a way this test does not see. Boundary rules also end up in two places that work differently.
- **Fix:** Add a `files: ['packages/cli/src/agents/claude-code/{settings-commands,restore-rules,command-review,auto-memory}.ts']` block to `eslint.config.js` with `no-restricted-imports` patterns `node:*` (for settings-commands) and `./file-gathering.ts`. Then drop the regex tests and keep the `~/.claude.json` merge tests.
- **Effort:** S
- **Confidence:** high

### QA and testing

#### QA-01 · Medium · `agentnomad agents` test runs against the real home, PATH and managed settings

- [ ] **Where:** `packages/cli/test/bin.test.ts:13-25`, `packages/cli/test/bin.test.ts:49-56`
- **Problem:** `agentnomad()` calls `spawnSync` without an `env` option, so the child gets the developer's environment. `src/bin.ts:19-21` passes `process.env` and `homedir()` to the app. The `agents` test therefore detects the real `~/.claude` (or the real `CLAUDE_CONFIG_DIR`), finds and runs the real `claude --version` from the real PATH (`agents/claude-code/detector.ts:201`), and shows managed-settings notices read from this PC (`/etc/claude-code`, `C:\Program Files\ClaudeCode`, and `reg query` on Windows) through `showNotices` in `agents/agents-command.ts:33`.
- **Why it matters:** CONTRIBUTING says tests "must never read or write the real home folder". The test also spawns whatever `claude` is first on the developer's PATH. Its result depends on the machine. It still passes because it only checks for the words "Claude Code" and "supported agent", so a regression in detection would not be caught either. SOLID-01 removed this same real-PC read from the unit tests, but this end-to-end path still does it.
- **Fix:** Give the child a temp home and an empty PATH, as `agent-registry.test.ts:86-92` does for the adapter:
  ```ts
  const home = mkdtempSync(join(tmpdir(), 'agentnomad-bin-'));
  spawnSync(process.execPath, [...], { cwd: cliRoot, encoding: 'utf8', timeout: 60_000,
    env: { PATH: '', HOME: home, USERPROFILE: home, APPDATA: home, SystemRoot: process.env.SystemRoot } });
  ```
  Then assert the exact "not found" line. The machine-wide managed-settings paths are still read, because they do not depend on the env. That is acceptable for an end-to-end smoke test, or it can be gated behind an env override if one is added.
- **Effort:** S
- **Confidence:** high

#### QA-02 · Medium · `--allow-commands`, `--account-skills`, `status` and `delete` never go through the parser in any test

- [ ] **Where:** `packages/cli/test/program.test.ts:115-212`; the untested mapping is in `packages/cli/src/cli/program.ts:157-163` (push `partsOf`), `:194-202` (pull `allowCommands`, `parts`, `--merge`), `:217-233` (`status`, `delete`)
- **Problem:** `program.test.ts` is the only test that calls `runCli` (checked with `grep -rln runCli packages/cli/test`). It routes `logout`, `list`, `agents`, `env`, push with `--agent/--global/-y/--memory`, pull with `--project/--overwrite`, register, login and account delete. It never passes `--allow-commands`, `--account-skills`, `--no-account-skills` or `--merge` on its own, and never runs `status` or `delete`. The command tests for push and pull call the handlers with options objects they build themselves, so they skip the flag-to-option mapping.
- **Why it matters:** `--allow-commands` is the flag that lets pull install plugins and run new hooks without asking. If the mapping turned it on by mistake, or dropped it, or if `delete --yes` lost its `yes`, every test would still pass.
- **Fix:** Add routing cases for each of these: `pull --global --yes --allow-commands` → `{ global: true, yes: true, allowCommands: true }`, `pull` with no flag → no `allowCommands` key, `push --account-skills` / `--no-account-skills` → `parts: Map{account-skills → true/false}`, `pull --merge` → `conflict: 'merge'`, `status --project x` → `{ global: false, project: 'x' }`, `delete --global --yes` → `{ global: true, yes: true }`.
- **Effort:** S
- **Confidence:** high

#### QA-03 · Medium · The pull test named "warns when this PC runs an older Claude Code" only checks that no warning appears

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:754-769`; the code path it should cover is `packages/cli/src/pull/pull-command.ts:319`
- **Problem:** The test pushes with the real adapter and an empty `PATH`, so the bundle has no version stamp. It then pulls with a detector reporting `1.0.0` and asserts `line.includes('was saved from')` is **false**. The comment on line 756 says it fakes a newer version on this PC, but it sets `'1.0.0'`. No test anywhere makes pull show the version warning. `agentVersionNotice` is unit-tested on its own (`claude-code-paths-data.test.ts:131-139`), but the pull wiring (`adapter.inspector?.versionNotice?.(bundle.agentVersion, version)`) is not; `grep versionNotice packages/cli/test` finds nothing.
- **Why it matters:** If pull stopped passing the stamp, or stopped showing the note, users would get no "update Claude Code" warning and no test would fail. The test name says this case is covered when it is not.
- **Fix:** Push with an adapter whose detector reports `'9.0.0'` (wrap `claudeAdapter(a.home)`), pull with `'1.0.0'`, and expect a line containing `This setup was saved from Claude Code 9.0.0`. Keep the no-stamp case as a second test with an accurate name.
- **Effort:** S
- **Confidence:** high

#### QA-04 · Low · A bare `rejects.toThrow()` lets tests pass for the wrong reason

- [ ] **Where:** `packages/cli/test/api-client.test.ts:227-232`; `packages/cli/test/auth-commands.test.ts:493-498`, `packages/cli/test/auth-commands.test.ts:505-509`
- **Problem:** "builds bundle paths only from valid params" gives the fake server no steps (`fakeServer([])`). If the `BundleParamsSchema.parse` in `http-api-client.ts:236` were removed, `new URL` would normalise `../../account` and send the request. The fake fetch would then throw `unexpected request` (`api-client.test.ts:67`), and the test would still pass. "a weak piped password stops register **with the reason**" never checks the reason.
- **Why it matters:** The path guard keeps a forged scope key from reaching another API route. Its only test cannot fail when the guard is removed.
- **Fix:** Assert what was refused and that nothing was sent:
  ```ts
  const { client, calls } = fakeServer([]);
  await expect(
    client.bundles.get({ agent: 'claude-code', scopeKey: '../../account' }),
  ).rejects.toBeInstanceOf(ZodError);
  expect(calls).toHaveLength(0);
  ```
  At `auth-commands.test.ts:495`, add `.rejects.toThrow(/at least|guess/)` with the zxcvbn message the CLI shows. At `:507`, add the username rule's message.
- **Effort:** S
- **Confidence:** high

#### QA-05 · Low · Directory listings are compared in OS order without sorting

- [ ] **Where:** `packages/cli/test/claude-code-restorer.test.ts:746`, `:828`, `:854`
- **Problem:** `expect(await readdir(dir)).toEqual(['a.md', 'b.md'])` (and `['check.py', 'run.cmd']`) assumes `readdir` returns names sorted. Node returns them in the file system's order. NTFS and APFS sort them; ext4 with `dir_index` returns hash order, and the hash seed is set per file system; tmpfs order depends on the kernel version.
- **Why it matters:** These tests can fail on a contributor's Linux PC, or on a CI runner image with a different file system, without any code change. The same file already sorts in other places (`[...report.written].sort()` at `:312`, `:849`).
- **Fix:** `expect((await readdir(dir)).sort()).toEqual([...])`.
- **Effort:** S
- **Confidence:** medium. Linux CI passes today. Whether it fails elsewhere depends on the file system, which I could not check from here.

#### QA-06 · Low · The project "link into a folder for keys" test never reaches the keys rule

- [ ] **Where:** `packages/cli/test/claude-code-project-collector.test.ts:180-191`
- **Problem:** The test is titled "never follows a link into a folder for keys, and says so". It links `.claude/skills/x` to `~/.ssh`, which is outside the project, and it expects the reason "it links to a place outside the project". In `file-gathering.ts:73-84`, the `within` check runs first and returns that reason. The `isSensitiveHomePath` check after it is never reached for a project. The next test (`:193-198`) already covers "outside the project".
- **Why it matters:** For a project, the keys rule only matters when the project folder contains a key folder, for example a project at `~` or a repo that holds `.ssh/`. No test covers that case, so removing the rule would go unnoticed. The test title also says something the test does not check.
- **Fix:** Rename this test to match what it checks. Add a case where the project is the home folder and links to `.ssh`: put `.ssh/id_ed25519` inside `project`, call the collector with `homedir: project`, and expect `'it links into a folder for keys and logins'`.
- **Effort:** S
- **Confidence:** high

#### QA-07 · Low · The `readRegistry` test can never fail, so the first review's QA-01 fix is incomplete for it

- [ ] **Where:** `packages/cli/test/system.test.ts:333-342`; parser at `packages/cli/src/agents/claude-code/managed-settings.ts:213-215`
- **Problem:** On Windows the test asserts `value === null || typeof value === 'string'`, which the return type already guarantees. The regex that pulls the value out of `reg query` output never runs on sample output in any test. When `reg` succeeds but the line does not match (for example a `REG_MULTI_SZ` value), `readRegistry` returns `''` instead of `null`. `detectManagedSettings` then lists an `hklm`/`hkcu` source with no keys.
- **Why it matters:** The first review (`review-2026-10-03.md`, QA-01) asked for real tests of these thin wrappers. For `readRegistry` the test that was added proves nothing, so a broken regex or a change in `reg` output would go unnoticed.
- **Fix:** Move the parsing into a pure `parseRegSettings(stdout)` and test it with captured `reg query` output: `REG_SZ`, `REG_EXPAND_SZ`, a value with spaces, and no match (decide between `null` and `''` and assert it).
- **Effort:** S
- **Confidence:** high

#### QA-08 · Low · "Never sends a readable byte" would still pass with encryption removed

- [ ] **Where:** `packages/cli/test/push-command.test.ts:281-290`
- **Problem:** The test searches the uploaded bytes, read as latin1, for `SECRET-PLAN-XYZ`. The bundle is gzipped before it is encrypted, and gzip alone already hides this marker. Checked with `node -e "zlib.gzipSync(JSON.stringify({files:[{path:'CLAUDE.md',content:'SECRET-PLAN-XYZ'}]})).toString('latin1').includes('SECRET-PLAN-XYZ')"`, which prints `false`.
- **Why it matters:** The test's name claims something it cannot check. Encryption is still proven elsewhere: `received()` decrypts at line 237, and the e2e plaintext check (`packages/e2e/src/plaintext.ts`) looks for encoded and compressed forms. So this is a misleading test, not a gap.
- **Fix:** Also assert the upload is not gzip (`gunzipSync(ciphertext)` throws), or reuse the e2e plaintext helper. Otherwise rename the test to say what it really checks.
- **Effort:** S
- **Confidence:** high

#### QA-09 · Low · Three refusal cases check `toContain('')`, which is always true

- [ ] **Where:** `packages/cli/test/program.test.ts:201`, `:202`, `:205`
- **Problem:** The cases for an empty project name, a project name with a line break, and an invalid username pass `''` as the expected message. `expect(err).toContain('')` always passes, so they only check the exit code and that no handler ran.
- **Why it matters:** If one of these inputs were refused for the wrong reason (another option error, a commander change), the test would not notice.
- **Fix:** Expect the commander prefix plus the schema text, e.g. `"option '--project <name>' argument"` and `"option '--username <name>' argument"`, or the specific `ProjectNameSchema` / username messages.
- **Effort:** S
- **Confidence:** high

#### QA-10 · Low · `interfaces.test.ts` only tests its own fakes

- [ ] **Where:** `packages/cli/test/interfaces.test.ts:13-84`
- **Problem:** The memory SecretStore, the fake adapter, the registry and the restorer are all defined in this file, and the three tests only call them. No production code runs except the `SECRET_NAMES` constant and the test helper `stubRestorer`. The comment on line 13 says this is "the kind of fake later command tests will use", but each later test file wrote its own copy (DUP-01).
- **Why it matters:** The file adds test count and upkeep but cannot catch a regression. Its one real job, checking that the fakes match the interfaces, is already done by `tsc` in every other test file. The real registry is tested in `agent-registry.test.ts`.
- **Fix:** Delete the file, or turn `memorySecretStore` into the shared fake from DUP-01 and drop the self-tests.
- **Effort:** S
- **Confidence:** high

#### QA-11 · Low · "The apply step has no prompter" is checked on the test's own object

- [ ] **Where:** `packages/cli/test/push-command.test.ts:611`, `packages/cli/test/pull-command.test.ts:571`
- **Problem:** `expect('prompter' in desktop.applyDeps).toBe(false)` checks the `applyDeps` object the test itself built without a prompter (`push-command.test.ts:209-221`, `pull-command.test.ts:215-233`). It says nothing about the production types.
- **Why it matters:** The T59 rule is that apply cannot ask. That rule lives in the `PushApplyDeps` / `PullApplyDeps` types. If someone added `prompter` to those types, this assertion would still pass.
- **Fix:** Use a type-level check, e.g. `expectTypeOf<PushApplyDeps>().not.toHaveProperty('prompter')` (Vitest `expectTypeOf`), and the same for `PullApplyDeps`.
- **Effort:** S
- **Confidence:** high

#### QA-12 · Low · Each test starts a new database, so the limit tests time out under load

- [x] **Where:** `packages/server/test/support/database.ts:18-23` (new PGlite plus all migrations in every `beforeEach`); `packages/server/test/bundle-routes.test.ts:299-330` (100 PUTs, then 121 DELETEs, in one test each); `packages/server/test/repositories.test.ts:373-399`
- **Problem:** Measured on this PC with nothing else running: `bundle-routes.test.ts` takes 25 s for 30 tests; "refuses a new setup past 100" takes 1.2 s, "120 saves and deletes" 0.9 s. With the default 5 s test and 10 s hook timeouts, that does not leave much room. Seen twice on this floor: worker-t65 noted "refuses a new setup past 100" timing out with three test runs on the PC, and god noted two server tests timing out on a macOS CI runner during the T65 run (a re-run passed).
- **Why it matters:** Red CI runs that pass on re-run teach people to ignore failures.
- **Fix:** Seed the first 99 setups with one SQL insert (blobs and bundles) and send only the last PUT through the API; start one PGlite per file and `TRUNCATE` between tests; or set `testTimeout`/`hookTimeout` for the server project in `vitest.config.ts`.
- **Effort:** S
- **Confidence:** medium (timings measured; the timeouts were seen by others and not reproduced here)

#### QA-13 · Low · Some tests only check code that lives in the test, or cannot fail

- [x] **Where:**
  - `packages/server/test/interfaces.test.ts:7-53`: tests a memory BlobStore and a `statusFor` switch both defined in the test; no route or other test uses them ("the kind of fake later route tests will use": none does).
  - `packages/server/test/contracts.test.ts:8-20`: parses two contract schemas, already covered in `packages/contracts/test/api.test.ts`.
  - `packages/server/test/limits-and-logs.test.ts:265-272`: `.catch((error) => expect(…))` passes without checking anything if the promise resolves.
  - `packages/server/test/rate-limiter.test.ts:100-102`: asserts the object's key names, a leftover of the DEAD-02 refactor that TypeScript already enforces.
- **Problem:** These tests pass whatever the server code does.
- **Why it matters:** They inflate the test count and give false confidence; the PUT outcome-to-status mapping they claim to cover is really tested in `bundle-routes.test.ts`.
- **Fix:** Delete `interfaces.test.ts`, `contracts.test.ts` and the key-name test; write the third as `await expect(createServerFromEnv(…)).rejects.toThrow(/DATABASE_URL/)` followed by a `not.toContain('hunter2')` on the caught error.
- **Effort:** S
- **Confidence:** high

#### QA-14 · Low · `interfaces.test.ts` tests fakes written inside the test

- [x] **Where:** `packages/core/test/interfaces.test.ts:19-36` (fake `CryptoService`, fake `overwrite` strategy), `:39-58`
- **Problem:** The first two tests call objects defined in the same file, so they would pass whatever `core/src` does. The third (`HOME_PLACEHOLDER` is `{{HOME}}`) repeats `paths.test.ts:105-107`. What they mean to prove (a full `CryptoService` fits where `Aead` or `Digest` is asked) is already checked by the type checker wherever the real service is passed.
- **Why it matters:** Tests that cannot fail add run time and give a false sense of coverage.
- **Fix:** Delete the file, or turn it into a type-only check (`expectTypeOf<CryptoService>().toMatchTypeOf<Aead>()`).
- **Effort:** S
- **Confidence:** high

#### QA-15 · Low · One failing cross-OS chain skips the other chain's later steps

- [x] **Where:** `.github/workflows/ci.yml:190-214` (`needs: e2e-step-1`, `needs: e2e-step-2`)
- **Problem:** `e2e-step-2` needs the whole `e2e-step-1` matrix, which holds both chains (mac-win-mac and linux-win-linux). If step 1 fails on macOS, step 2 and 3 of the Linux chain are skipped too, although its step 1 passed. `fail-fast: false` does not change this.
- **Why it matters:** A macOS-only problem hides whether Linux → Windows → Linux still works, so one CI run shows less than it could.
- **Fix:** Split the chains into separate jobs (e.g. `mac-step-1/2/3` and `linux-step-1/2/3`, reusing the `&e2e-steps` anchor), so each chain only needs its own previous step.
- **Effort:** S
- **Confidence:** high

## Standards to adopt

- **Reading JSON with a schema:** one helper that returns the value or the reason it failed, used everywhere (DUP-04; about ten copies across `agents/claude-code`, `env/`, `api/`, `secrets/`). A caller can then warn, which is what BUG-01 and SEC-01 are missing.
- **Lists from untrusted files are parsed per item:** one bad entry must not drop its siblings, and in the pull review an unreadable entry is shown, not skipped (SEC-01, BUG-01).
- **One rule module per job, used by push and pull:** project hook scripts (DUP-03), the reader of `installed_plugins.json` (BUG-03), and "is this path under that folder", which exists five times with different case rules (`hook-scripts.ts`, `restore-rules.ts`, `global-paths.ts`, `global-collector.ts`, `project-collector.ts`).
- **Test fakes live in one place:** `packages/cli/test/fakes.ts` and `packages/server/test/support/fixtures.ts`, typed, with no `as unknown as` (DUP-01, DUP-06, BP-01).
- **Background cleanup on the server:** the chance is injected, and a failure is caught and logged, never passed to the user's request (BUG-02; the bundle sweep already works this way).
- **One wiring of the API:** a `createApi(...)` used by production, the server tests and the e2e local server (DUP-02).
- **Boundaries are lint rules:** extend the agent boundary rule to `env/` and between adapters, and replace the regex test (ARCH-01, ARCH-02, ARCH-04).
- **A test's name says what it checks, and it can fail:** no `toContain('')`, no bare `toThrow()`, no assertions on objects the test built itself (QA-03 to QA-14).
- **Agent-specific facts stay in the adapter:** file names, own variables and labels (ARCH-01); generic helpers move out of `claude-code/` (ARCH-02).

## What will break first at scale

1. **Postgres round trips per request.** Every signed-in request costs a session lookup (two on list, DB-01), every auth request and save costs a rate-limit write, and 1 in 100 adds two unbounded deletes (BUG-02). On a free Neon database this is the first ceiling. Files: `packages/server/src/db/session-repository.ts`, `packages/server/src/rate-limit/postgres-rate-limiter.ts`, `packages/server/src/http/routes/bundles.ts`.
2. **Memory, on both sides.** The server buffers a 5 MB upload and holds a download up to three times (PERF-01) on a 512 MB instance. The CLI reads every file of a setup into memory on push and keeps every prepared setup in memory on pull. A large `skills/` folder hits the 5 MB encrypted limit first, and there is no way to split a setup. Files: `packages/server/src/http/routes/bundles.ts`, `packages/cli/src/agents/claude-code/file-gathering.ts`, `packages/cli/src/pull/pull-command.ts`.
3. **Adding the second agent and more contributors.** The Claude Code names in `env/` (ARCH-01), helpers that live in `claude-code/` (ARCH-02) and the hand-wired `--account-skills` flag in `cli/program.ts` are the first generic edits a new adapter needs. For the team, the copied test fakes (DUP-01), the 1,191-line restorer test (READ-03) and CI time (PERF-02, QA-12, QA-15) grow with every change.

## Suggested order of work

1. **The pull review and plugins: SEC-01, BUG-01, SEC-02, SEC-03, BUG-03, DUP-03, DUP-04.** Same files (`command-review.ts`, `settings-commands.ts`, `plugins.ts`, `after-restore.ts`); the shared JSON helper and per-item parsing fix the two top findings together.
2. **Server: BUG-02, DB-01, DUP-02, PERF-01, DEAD-03, READ-06, READ-07, READ-08, QA-12, QA-13, DUP-06.** One task; DUP-02 gives the tests the production wiring and stops the random sweep in tests, which also helps the slow-runner timeouts (QA-12).
3. **CLI behaviour: UX-01, UX-02, UX-03, UX-04, BUG-04, DEAD-01, DEAD-02, DUP-05, READ-01, READ-02, ARCH-03.** Small, independent fixes.
4. **Test quality: DUP-01 and BP-01 first, then QA-01 to QA-11, QA-14, DUP-07, DUP-08, READ-03, READ-04, READ-05, READ-14, BP-02.** Shared fakes first, so the new tests are written once.
5. **Agent boundary: ARCH-01, ARCH-02, ARCH-04, READ-13.** Best done before the second agent starts.
6. **CI, deploy and docs: BP-03, BP-04, PERF-02, PERF-03, QA-15, READ-09, READ-10, READ-11, READ-12.**

## Not reviewed

- Skipped by rule, 16 files: `pnpm-lock.yaml`, the 7 drizzle snapshots in `packages/server/drizzle/meta/`, and 8 images (`.a1x6/images`, `docs/images`).
- Git-ignored files (`packages/server/.env`, `node_modules`, build output, `coverage/`) and the untracked `CLAUDE.local.md`.
- Not run: `pnpm test:e2e` (CI runs it on every push; the run for `4c31cf8` passed) and anything against the production database or the hosted API.
- Open questions the reviewers could not settle from the code: whether Claude Code still runs the valid hooks of a partly invalid settings file (SEC-01, impact), how Claude Code writes `projectPath` on Windows (BUG-03), and how clack draws a checklist with no options (UX-04). These findings say so in their Confidence line.
- Noted, no finding raised: pull writes through a symlinked folder inside a project (`restorer.ts:171-177`, `followLink: true`), while push refuses links that lead out of a project. The content written is the user's own setup, but a cloned repository can choose where it lands. This needs a decision, not a fix.
