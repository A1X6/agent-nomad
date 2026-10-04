# Code Review — Agent Nomad — 2026-10-04 (review 13)

**Scope:** the whole repository on `dev` at `59e8dd0` (after T93), without the earlier review records under `docs/reviews` (historical, out of scope).
**Stack:** pnpm monorepo, TypeScript (strict), Node ≥ 22.13; packages `contracts`, `core`, `cli`, `server`, `e2e`; Hono, Drizzle, Postgres (Neon, PGlite in tests), libsodium, Zod, Vitest.
**Coverage:** 280 of 280 files, 34,952 lines. 278 files are byte for byte the files read in full for review 12 earlier the same day (the two sets of numbered file dumps were compared: 23 of 25 are identical, and the other two differ only in the two files below), so their review 12 reading stands and they were not read a second time. The two files T93 changed, `CONTRIBUTING.md` and `docs/ARCHITECTURE.md`, were checked again: the changed lines and the lists around them.
**Checks run:** on `59e8dd0`: `pnpm check` (type check, lint, format, tests): pass, 1376 passed and 17 skipped in 80 files; `pnpm knip`: clean; `pnpm audit --prod`: no known vulnerabilities. CI: green on the T93 commit `f667882` (run 37220513953, 12 of 12 jobs).

## Summary

No finding. The one finding of review 12 is fixed and verified: `docs/ARCHITECTURE.md` names `AEAD_KEY_BYTES` in the `crypto.ts` row, and the Tests section of `CONTRIBUTING.md` names `stub-restorer.ts` and `stubRestorer`. A check of every exported helper of the shared test files against `CONTRIBUTING.md` finds each one named. Nothing else changed since review 12, which found no bug, security, database, performance or user-experience problem in any file.

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

## What will break first at scale

Unchanged, and none is a finding today: bundle bytes in Postgres (`packages/server/src/storage/postgres-blob-store.ts`; the `BlobStore` interface is the planned way out), the per-request rate-limit write (`packages/server/src/rate-limit/postgres-rate-limiter.ts`), and the single free Render instance (`render.yaml`).

## Suggested order of work

Nothing is open. Next steps are the owner's: merging `dev` into `main` and releasing.

## Not reviewed

The earlier review records under `docs/reviews` (historical). Generated and vendored files (`node_modules`, `dist`, `pnpm-lock.yaml`, `packages/server/drizzle/meta`) and the 8 images under `.a1x6/images` and `docs/images`. The 278 unchanged files were not read a second time for this review (see Coverage).
