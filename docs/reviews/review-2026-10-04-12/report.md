# Code Review — Agent Nomad — 2026-10-04 (review 12)

**Scope:** the whole repository on `dev` at `744fa87` (after T92), without the earlier review records under `docs/reviews` (historical, out of scope).
**Stack:** pnpm monorepo, TypeScript (strict), Node ≥ 22.13; packages `contracts`, `core`, `cli`, `server`, `e2e`; Hono, Drizzle, Postgres (Neon, PGlite in tests), libsodium, Zod, Vitest.
**Coverage:** 280 of 280 files read in full, 34,950 lines.
**Checks run:** `pnpm check` (type check, lint, format, tests): pass on the T92 merge, 1376 passed and 17 skipped in 80 files (only review documents changed since); `pnpm knip`: clean; `pnpm audit --prod`: no known vulnerabilities; CI on `744fa87`: green (run 37219820248).

## Summary

No bug, security, database, performance or user-experience problem was found: every source and test file reads clean, and the two findings of review 11 are fixed and verified (the tests use the shared helpers and constants, and core has one name, `AEAD_KEY_BYTES`, for the size of an encryption key). One Low finding is left, in the documentation only: two lists that T92 touched or should have touched are each one name short. Nothing blocks a release.

## Scores

| Area                         | Score /10 | One-line reason                                    |
| ---------------------------- | --------- | -------------------------------------------------- |
| Correctness                  | 10        | No bug found in any file.                          |
| Security                     | 10        | No finding; audit clean.                           |
| Performance                  | 10        | No finding.                                        |
| User experience              | 10        | No finding.                                        |
| Readability                  | 9         | Two documentation lists are each one name short.   |
| Maintainability              | 10        | No finding; shared helpers and constants are used. |
| Architecture and scalability | 10        | No finding.                                        |
| Test coverage                | 10        | No gap found; 1376 tests pass.                     |

| Category    | Critical | High | Medium | Low |
| ----------- | -------- | ---- | ------ | --- |
| Readability | 0        | 0    | 0      | 1   |
| All others  | 0        | 0    | 0      | 0   |

## Fix first

One Low finding: DOC-01.

## Findings

### DOC-01 · Low · Two documentation lists are each one name short

- [ ] **Where:**
  - `docs/ARCHITECTURE.md:659`: the file reference row for core's `crypto.ts` names everything the file exports (the six interfaces, `DerivedKeys` and `DecryptionError`) but not `AEAD_KEY_BYTES`, which T92 added there (`packages/core/src/crypto.ts:34`).
  - `CONTRIBUTING.md:119-152`: the Tests section says "Shared test helpers live in these files" and names every helper of `fakes.ts`, the two Claude Code fixture files, the server's `support/` and the core and contracts `fixtures.ts`, but not `packages/cli/test/stub-restorer.ts` and its `stubRestorer` (used by `fakes.ts:245`, `env.test.ts:615` and `push-command.test.ts:90`). `docs/ARCHITECTURE.md:637` does list that file as shared set-up.
- **Problem:** Both lists read as complete, and each is missing one name. Other rows of the file reference name the constants their file holds (`TEMP_MARKER` at `:738`, `RESERVED_DIR` at `:768`).
- **Why it matters:** A reader looking for where the encryption key size lives does not find it in the file reference. A contributor who needs a restorer for a test adapter does not find `stubRestorer` in the list that says "use them instead of a new copy", and may write another.
- **Fix:** Add `AEAD_KEY_BYTES` (the size of every key `Aead` takes) to the `crypto.ts` row. Add `packages/cli/test/stub-restorer.ts` with `stubRestorer` (a restorer that writes nothing, for tests about other parts) to the list in `CONTRIBUTING.md`. Documentation only; no code changes.
- **Effort:** S
- **Confidence:** high

## Standards to adopt

Unchanged from review 11, and the code follows them:

- Test set-up: a multi-line structure that a shared helper builds, a rule a helper holds (such as which calls count as API calls), or a constant named in `CONTRIBUTING.md` passed as an argument, is taken from the helper or the constant. One-expression idioms and short arrangements of two or three statements may repeat, so each test still reads on its own. A value an assertion compares against stays a literal, and so do the strings that pin a stored or wire format.
- A new shared test helper, or a new shared test file, is named in the Tests section of `CONTRIBUTING.md` in the same change.
- A new export of a file is named in that file's row of `docs/ARCHITECTURE.md` Part 2 when the row lists what the file holds.

Looked at and left, with the reason:

- `packages/cli/src/env/env-section.ts:25` checks a saved value against the shell-profile block markers with its own pattern instead of `BLOCK_START` and `BLOCK_END`. The markers are a stored format that never changes in place, and `packages/cli/test/env.test.ts:148-150` builds the refused values from the two constants, so a drift between the constants and the pattern fails a test. No finding.
- Reserved bundle paths written out in tests (`.agentnomad/plugins.json`, `.agentnomad/programs.json`, `.agentnomad/auto-memory/…`) pin the stored bundle format. No finding.

## What will break first at scale

Unchanged from review 11, and none is a finding today: bundle bytes in Postgres (`packages/server/src/storage/postgres-blob-store.ts`; the `BlobStore` interface is the planned way out), the per-request rate-limit write (`packages/server/src/rate-limit/postgres-rate-limiter.ts`), and the single free Render instance (`render.yaml`).

## Suggested order of work

1. DOC-01: two documentation lines; `pnpm format:check` must still pass.

## Not reviewed

The earlier review records under `docs/reviews` (historical). Generated and vendored files (`node_modules`, `dist`, `pnpm-lock.yaml`, `packages/server/drizzle/meta`) and the 8 images under `.a1x6/images` and `docs/images`. `pnpm check` and `pnpm knip` were not run again for this review: the tree differs from the T92 merge, where both passed, only in review documents, and CI on `744fa87` is green.
