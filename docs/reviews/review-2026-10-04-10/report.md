# Code Review — Agent Nomad — 2026-10-04 (review 10)

**Scope:** the whole repository on `dev` at `eb70d3d` (after T88 and T89), without the earlier review records under `docs/reviews` (historical, out of scope).
**Stack:** pnpm monorepo, TypeScript (strict), Node ≥ 22.13; packages `contracts`, `core`, `cli`, `server`, `e2e`; Hono, Drizzle, Postgres (Neon, PGlite in tests), libsodium, Zod, Vitest.
**Coverage:** 280 of 280 files read in full, 35,061 lines.
**Checks run:** `pnpm check` (type check, lint, format, tests): pass on the T89 merge, 1376 passed and 17 skipped in 80 files (only review documents changed since); `pnpm knip`: clean; `pnpm audit --prod`: no known vulnerabilities; CI on `eb70d3d`: green (run 37210175356).

## Summary

No bug, security, database, performance or user-experience problem was found: every source file of the CLI, core, contracts and server reads clean, and the four findings of review 9 are fixed and verified. Four Low findings are left, all upkeep: three places in the docs point at a PRD that is not in the repository, one comment in the CLI describes work that finished long ago, the `test` script of three packages also runs compiled copies of the tests, and some test files still write out set-up that a helper next to them already provides.

## Scores

| Area                         | Score /10 | One-line reason                                                      |
| ---------------------------- | --------- | -------------------------------------------------------------------- |
| Correctness                  | 10        | No bug found in any file.                                            |
| Security                     | 10        | No finding; audit clean.                                             |
| Performance                  | 10        | No finding.                                                          |
| User experience              | 10        | No finding.                                                          |
| Readability                  | 9         | Docs cite a document readers cannot open; one stale comment.         |
| Maintainability              | 9         | Test set-up still repeated in a few files; three misleading scripts. |
| Architecture and scalability | 10        | No finding.                                                          |
| Test coverage                | 10        | No gap found; 1376 tests pass.                                       |

| Category       | Critical | High | Medium | Low |
| -------------- | -------- | ---- | ------ | --- |
| Readability    | 0        | 0    | 0      | 2   |
| Duplication    | 0        | 0    | 0      | 1   |
| Best practices | 0        | 0    | 0      | 1   |
| All others     | 0        | 0    | 0      | 0   |

## Fix first

All four are Low; none blocks a release. In order of value: BP-01, READ-01, DUP-01, READ-02.

## Findings

### READ-01 · Low · Docs point at "the PRD", which is not in the repository

- [x] **Where:** `docs/ROADMAP.md:47`; `docs/decisions/0001-libraries.md:22` and `:56`
- **Problem:** The roadmap says Claude Desktop is "Planned in the v1 PRD", and the library decision record says a choice "matches the PRD" and names "the PRD's user-only file fallback". The PRD lives outside the repository.
- **Why it matters:** `CONTRIBUTING.md` ("Finding IDs and task numbers in comments") says never to point at something a reader cannot open. A contributor cannot check these claims.
- **Fix:** Say the fact itself (for example "Planned as the first addition after Claude Code"; "one library, WASM preferred over native builds, as decided for v1"; "the user-only file fallback"), or link a document that is in the repository.
- **Effort:** S
- **Confidence:** high

### READ-02 · Low · Stale comment: "Commands are built in later tasks"

- [x] **Where:** `packages/cli/src/cli/commands.ts:59-62`
- **Problem:** The comment on the command handlers says "Commands are built in later tasks and plugged in here". Every command has been built since 1.0.
- **Why it matters:** It tells a new reader the file is unfinished.
- **Fix:** Reword to what is true now: the handlers are plugged in here, so parsing and help never depend on how a command works.
- **Effort:** S
- **Confidence:** high

### BP-01 · Low · `pnpm test` inside `contracts`, `core` or `server` also runs compiled test copies

- [x] **Where:** `packages/contracts/package.json:17`, `packages/core/package.json:17`, `packages/server/package.json:17`
- **Problem:** Their `test` script is a bare `vitest run`. Run from the package folder it uses no project config, so it also picks up the compiled tests that `tsc --build` leaves in `dist/` (verified in `core`: 17 files and 577 tests, among them stale `dist/test/*.test.js`) and resolves workspace packages to `dist` instead of source. The CLI package already does it right: `vitest run --root ../.. --project @agentnomad/cli`.
- **Why it matters:** A developer who runs the tests of one package gets doubled, possibly stale results, against the root config's stated rule ("never the compiled copies").
- **Fix:** Use the CLI's form in all three: `vitest run --root ../.. --project @agentnomad/<name>`. Run each once to confirm the file and test counts match that project's share of `pnpm test`.
- **Effort:** S
- **Confidence:** high

### DUP-01 · Low · Test set-up still written out where a helper exists (left after T89)

- [ ] **Where:**
  - `packages/cli/test/env.test.ts`: `createShellProfileWriter({ path, kind: 'posix', label })` written out at `:247`, `:255`, `:288`, `:301`, `:320` although `bashrc()` (`:207`) builds it; the Windows `calls` recorder three times (`:329-338`, `:367-372`, `:385-389`)
  - `packages/cli/test/http-api-client.test.ts`: the `AbortSignal.timeout` spy twice (`:491-503`, `:508-523`)
  - `packages/cli/test/claude-code-plugins.test.ts`: `readPluginManifest({ baseDir: base, platform, scope })` five times (`:28-32`, `:58-62`, `:71-75`, `:172-176`, `:194-198`)
  - `packages/cli/test/claude-code-restore-rules.test.ts`: the same `hookScripts` set twice (`:69-73`, `:130-134`)
  - `packages/cli/test/auth-commands.test.ts:807-811` makes its own data key instead of `useDataKey`; `packages/cli/test/auto-memory.test.ts:54-58` equals `:67-71`; `packages/cli/test/account-skills.test.ts` builds the same skill as `saved` (`:79`) and `skill` (`:218`); `packages/cli/test/fakes.ts:87` writes `32` where core exports `DATA_KEY_BYTES`
  - `packages/server/test/limits-and-logs.test.ts`: the `prelogin` helper twice (`:49-50`, `:69-70`); `packages/server/test/auth-routes.test.ts`: the prelogin-and-parse `ask` twice (`:83-86`, `:93-96`); the zero UUID literal in `packages/server/test/repositories.test.ts:61`, `:435`, `:445` and `packages/server/test/bundle-routes.test.ts:233`
- **Problem:** Each is the same few lines written more than once inside one file, or a literal that has a named constant.
- **Why it matters:** A change to the set-up has to be made in every copy; a missed one makes the tests disagree.
- **Fix:** One local helper or constant per case, in the same file (or `support/fixtures.ts` for the UUID). Test names and assertions stay as they are.
- **Effort:** S
- **Confidence:** high for the first four bullets, medium for the last two (smaller repeats; check each before changing)

## Standards to adopt

- Package `test` scripts: `vitest run --root ../.. --project @agentnomad/<name>` (as `packages/cli`).
- Docs and comments point only at files in the repository (`CONTRIBUTING.md`).
- Test set-up used twice in a file gets one helper in that file; set-up used across files lives in the package's `fakes.ts` or `fixtures.ts`.

## What will break first at scale

Unchanged from review 9, and none is a finding today: bundle bytes in Postgres (`packages/server/src/storage/postgres-blob-store.ts`; the `BlobStore` interface is the planned way out), the per-request rate-limit write (`packages/server/src/rate-limit/postgres-rate-limiter.ts`), and the single free Render instance (`render.yaml`).

## Suggested order of work

1. BP-01, READ-01, READ-02 together: text edits in two docs, one comment and three scripts.
2. DUP-01: test files only; compare test names before and after.

## Not reviewed

The 13 earlier review records under `docs/reviews` (historical). Generated and vendored files (`node_modules`, `dist`, `pnpm-lock.yaml`, `packages/server/drizzle/meta`). `pnpm check` and `pnpm knip` were not run again for this review: the tree differs from the T89 merge, where both passed, only in review documents, and CI on `eb70d3d` is green.
