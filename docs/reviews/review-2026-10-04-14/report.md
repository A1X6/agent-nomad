# Code Review — Agent Nomad — 2026-10-04 (review 14)

**Scope:** the whole repository on `dev` at `5758178`, without the earlier review records under `docs/reviews` (historical, out of scope). The code is the code of `59e8dd0` (review 13): only review documents were added since.
**Stack:** pnpm monorepo, TypeScript (strict), Node ≥ 22.13; packages `contracts`, `core`, `cli`, `server`, `e2e`; Hono, Drizzle, Postgres (Neon, PGlite in tests), libsodium, Zod, Vitest.
**Coverage:** 280 of 280 files read in full again for this review, 34,952 lines. Nothing was carried over from an earlier reading.
**Checks run:** `pnpm check` (type check, lint, format, tests): pass, 1376 passed and 17 skipped in 80 files; `pnpm knip`: clean; `pnpm audit --prod`: no known vulnerabilities (all three on `59e8dd0`; no code changed since). CI on `5758178`: green (run 37221111495).

## Summary

No finding. A second full reading of every file found no bug and no security, database, performance or user-experience problem, and nothing to fix in readability, structure or tests. The tests use the shared helpers and named constants, the documentation lists are complete (every exported helper of the shared test files is named in `CONTRIBUTING.md`), and the checks and CI pass. Nothing blocks a release.

## Scores

| Area                         | Score /10 | One-line reason                                    |
| ---------------------------- | --------- | -------------------------------------------------- |
| Correctness                  | 10        | No bug found in any file.                          |
| Security                     | 10        | No finding; audit clean.                           |
| Performance                  | 10        | No finding.                                        |
| User experience              | 10        | No finding.                                        |
| Readability                  | 10        | No finding; the documentation lists are complete.  |
| Maintainability              | 10        | No finding; shared helpers and constants are used. |
| Architecture and scalability | 10        | No finding.                                        |
| Test coverage                | 10        | No gap found; 1376 tests pass.                     |

| Category | Critical | High | Medium | Low |
| -------- | -------- | ---- | ------ | --- |
| All      | 0        | 0    | 0      | 0   |

## Fix first

Nothing to fix.

## Findings

None.

## Standards to adopt

Unchanged from review 12, and the code follows them:

- Test set-up: a multi-line structure that a shared helper builds, a rule a helper holds, or a constant named in `CONTRIBUTING.md` passed as an argument, is taken from the helper or the constant. One-expression idioms and short arrangements of two or three statements may repeat. A value an assertion compares against stays a literal, and so do the strings that pin a stored or wire format.
- A new shared test helper, or a new shared test file, is named in the Tests section of `CONTRIBUTING.md` in the same change.
- A new export of a file is named in that file's row of `docs/ARCHITECTURE.md` Part 2 when the row lists what the file holds.

Looked at again and left, with the reason:

- `packages/cli/src/env/env-section.ts:25` checks a saved value against the shell-profile block markers with its own pattern. `packages/cli/test/env.test.ts:148-150` builds the refused values from `BLOCK_START` and `BLOCK_END`, so a drift fails a test. No finding.
- Tests that look up what the code wrote by its written-out name (a reserved bundle path such as `.agentnomad/claude.json`, a backup name such as `CLAUDE.md.agentnomad-backup-<stamp>`) compare against an expected value: the literal pins the stored format. `packages/cli/test/claude-code-restorer.test.ts:215` places a file under the backup name the restorer must avoid; a drift of the marker fails the `-2` assertion two lines below. No finding.
- `packages/cli/test/claude-code-after-restore.test.ts:16-21` writes out its own managed settings (plugins blocked, MCP servers not) instead of `fileManagedSettings`, which blocks both: a different value, not a copy. No finding.

## What will break first at scale

Unchanged, and none is a finding today: bundle bytes in Postgres (`packages/server/src/storage/postgres-blob-store.ts`; the `BlobStore` interface is the planned way out), the per-request rate-limit write (`packages/server/src/rate-limit/postgres-rate-limiter.ts`), and the single free Render instance (`render.yaml`).

## Suggested order of work

Nothing is open. Next steps are the owner's: merging `dev` into `main` and releasing.

## Not reviewed

The earlier review records under `docs/reviews` (historical). Generated and vendored files (`node_modules`, `dist`, `pnpm-lock.yaml`, `packages/server/drizzle/meta`) and the 8 images under `.a1x6/images` and `docs/images`.
