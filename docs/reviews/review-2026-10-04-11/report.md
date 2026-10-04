# Code Review — Agent Nomad — 2026-10-04 (review 11)

**Scope:** the whole repository on `dev` at `310732c` (after T90 and T91), without the earlier review records under `docs/reviews` (historical, out of scope).
**Stack:** pnpm monorepo, TypeScript (strict), Node ≥ 22.13; packages `contracts`, `core`, `cli`, `server`, `e2e`; Hono, Drizzle, Postgres (Neon, PGlite in tests), libsodium, Zod, Vitest.
**Coverage:** 280 of 280 files read in full, 34,919 lines.
**Checks run:** `pnpm check` (type check, lint, format, tests): pass on the T91 merge, 1376 passed and 17 skipped in 80 files (only review documents changed since); `pnpm knip`: clean; `pnpm audit --prod`: no known vulnerabilities; CI on `310732c`: green (run 37217135495).

## Summary

No bug, security, database, performance or user-experience problem was found: every source file of the CLI, core, contracts and server reads clean, and the four findings of review 10 are fixed and verified. Two Low findings are left, both upkeep. A few tests still write out something a shared helper or named constant already provides, mostly ones T91 added after those tests were written, and `CONTRIBUTING.md` does not name those helpers yet. In core, the size of the password key and of any encryption key is written with the names of two other keys' sizes.

## Scores

| Area                         | Score /10 | One-line reason                                                      |
| ---------------------------- | --------- | -------------------------------------------------------------------- |
| Correctness                  | 10        | No bug found in any file.                                            |
| Security                     | 10        | No finding; audit clean.                                             |
| Performance                  | 10        | No finding.                                                          |
| User experience              | 10        | No finding.                                                          |
| Readability                  | 9         | Two key sizes in core carry the name of another key.                 |
| Maintainability              | 9         | Some tests write out what a shared helper or constant already gives. |
| Architecture and scalability | 10        | No finding.                                                          |
| Test coverage                | 10        | No gap found; 1376 tests pass.                                       |

| Category    | Critical | High | Medium | Low |
| ----------- | -------- | ---- | ------ | --- |
| Readability | 0        | 0    | 0      | 1   |
| Duplication | 0        | 0    | 0      | 1   |
| All others  | 0        | 0    | 0      | 0   |

## Fix first

Both are Low; neither blocks a release. In order of value: DUP-01, READ-01.

## Findings

### DUP-01 · Low · Tests write out what a shared helper or named constant already provides

- [x] **Where:**
  - The `stopHook(command)` helper (`packages/cli/test/claude-code-project-fixtures.ts:77`) builds settings with one Stop hook. Written out instead in `packages/cli/test/claude-code-command-review.test.ts:115`, `:131`, `:141`, `:383` (the file imports `stopHook` and uses it at `:356`) and `packages/cli/test/claude-code-restorer.test.ts:443-446` (imports it, uses it at `:136`).
  - `packages/cli/test/http-api-client.test.ts:165` filters the calls by hand although `fakeServer` returns `apiCalls()` for that (`:117`).
  - The global scope key is passed as the quoted `'global'` where `GLOBAL_SCOPE_KEY` exists and the lines next to it use it: `packages/cli/test/local-state.test.ts:28`, `:29`, `:32`, `:33`; `packages/cli/test/auth-commands.test.ts:394`, `:398`; `packages/cli/test/push-command.test.ts:438`; `packages/cli/test/agent-boundary.test.ts:268`, `:286`; `packages/contracts/test/api.test.ts:195`.
  - File names that have an exported constant: `'secrets.json'` in `packages/cli/test/secret-store.test.ts:48`, `:55`, `:183`, `:197` (`SECRETS_FILE`, which `packages/e2e/src/pc.ts` uses) and `'state.json'` in `packages/cli/test/local-state.test.ts:47` (`STATE_FILE`, which `fakes.ts` uses).
  - `CONTRIBUTING.md:119-133` lists the shared test helpers and says "Use them instead of a new copy", but does not name the newer ones: `stopHook`, `claudeCodeAdapter`, `setMemoryDirectory`, `linkFolder`, `useZxcvbnChecker`, `fakeManagedSystem`, `bundleRow`, `preloginRequest`.
- **Problem:** Each is a value or a few lines a helper or constant in the same package already gives. Most of the helpers were added by T91 after these tests were written.
- **Why it matters:** A reader cannot tell whether the hand-written copy differs on purpose, and a change to the helper or the constant does not reach it. A contributor who reads `CONTRIBUTING.md` will not find the new helpers and will write another copy.
- **Fix:** Use the helper or the constant at each place (for the two hook settings with more keys, spread it: `{ statusLine: …, ...stopHook(command) }`). A value an assertion compares against (`toBe`, `toEqual`, a URL in an expected request) stays a literal. Add the newer helpers to the list in `CONTRIBUTING.md`. Test names and results stay as they are.
- **Effort:** S
- **Confidence:** high

### READ-01 · Low · Two key sizes in core are written with the name of another key

- [x] **Where:** `packages/core/src/sodium-crypto.ts:59`, `:71`, `:87`; `packages/core/test/envelopes.test.ts:24`, `:31`, `:32`
- **Problem:** `deriveKeys` sizes the password key with `AUTH_KEY_BYTES` (`:59`), and `seal` and `open` check every key they get against `DATA_KEY_BYTES` (`:71`, `:87`), also when the key is the password key that wraps the data key. All three are 32 bytes, so the code is correct, but there is no name for "the size of an encryption key", and the tests write `32` for the password key.
- **Why it matters:** A reader of `deriveKeys` or `seal` sees a size named after a different key and has to work out that the names are borrowed. The constants are part of the stored key format, so they cannot change, but the borrowed names hide which size each line really means.
- **Fix:** One named constant in core for the XChaCha20-Poly1305 key size (for example `AEAD_KEY_BYTES = 32`), used for the password key in `deriveKeys`, for the key check in `seal` and `open`, and to define `DATA_KEY_BYTES`. Use it in `envelopes.test.ts` for the password keys. No value changes; the reference vector in `sodium-crypto.test.ts` proves it.
- **Effort:** S
- **Confidence:** high

## Standards to adopt

- Test set-up: when a shared helper or a named constant exists for something, use it; a block of five or more identical lines used twice in a file gets one helper in that file. Short arrangements of two or three statements may repeat, so each test still reads on its own. A value an assertion compares against stays a literal.
- A new shared test helper is named in the Tests section of `CONTRIBUTING.md` in the same change.
- A size in crypto code carries the name of the thing it sizes.

## What will break first at scale

Unchanged from review 10, and none is a finding today: bundle bytes in Postgres (`packages/server/src/storage/postgres-blob-store.ts`; the `BlobStore` interface is the planned way out), the per-request rate-limit write (`packages/server/src/rate-limit/postgres-rate-limiter.ts`), and the single free Render instance (`render.yaml`).

## Suggested order of work

1. DUP-01: test files and one docs list; compare test names before and after.
2. READ-01: one constant in core and its uses; the key reference vector must still pass.

## Not reviewed

The earlier review records under `docs/reviews` (historical). Generated and vendored files (`node_modules`, `dist`, `pnpm-lock.yaml`, `packages/server/drizzle/meta`) and the 8 images under `.a1x6/images` and `docs/images`. `pnpm check` and `pnpm knip` were not run again for this review: the tree differs from the T91 merge, where both passed, only in review documents, and CI on `310732c` is green.
