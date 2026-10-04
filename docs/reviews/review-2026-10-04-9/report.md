# Code Review — Agent Nomad — 2026-10-04 (review 9)

**Scope:** the whole repository on `dev` at `6fb612d` (after T86 and T87).
**Stack:** pnpm monorepo, TypeScript (strict), Node ≥ 22.13; packages `contracts`, `core`, `cli`, `server`, `e2e`; Hono, Drizzle, Postgres (Neon, PGlite in tests), libsodium, Zod, Vitest.
**Coverage:** 278 of 291 files read in full, 35,148 of 39,767 lines. The other 13 files are the earlier review records under `docs/reviews` (4,619 lines), which were not read again.
**Checks run:** `pnpm check` (type check, lint, format, tests): pass, 1376 passed and 17 skipped in 80 files; `pnpm knip`: clean; `pnpm audit --prod`: no known vulnerabilities; CI on `6fb612d`: green.

## Summary

No bug, security, database or performance problem was found: every source file of the CLI, core, contracts and server reads clean. The four findings of review 8 are fixed and verified. What is left is upkeep, all Low: two documents that say less than the code does, finding IDs in comments that no document explains how to look up, test set-up that is still written by hand in many test files, and one library imported in two ways.

## Scores

| Area                         | Score /10 | One-line reason                                                                 |
| ---------------------------- | --------- | ------------------------------------------------------------------------------- |
| Correctness                  | 10        | No bug found in the 278 files read; all checks pass.                            |
| Security                     | 10        | No finding; audit clean; threat model rows match the code.                      |
| Performance                  | 10        | No finding; queries are indexed, paged and batched.                             |
| User experience              | 10        | No finding; every command has clear messages and exit codes.                    |
| Readability                  | 9         | Two documents out of step (READ-01); finding IDs cannot be looked up (READ-02). |
| Maintainability              | 9         | Test set-up repeated by hand (DUP-01); one library imported two ways (BP-01).   |
| Architecture and scalability | 10        | Clear package and agent boundaries, checked by tests.                           |
| Test coverage                | 9         | Behaviour is covered; the cost is the repeated set-up (DUP-01).                 |

| Category       | Critical | High | Medium | Low |
| -------------- | -------- | ---- | ------ | --- |
| Bugs           | 0        | 0    | 0      | 0   |
| Security       | 0        | 0    | 0      | 0   |
| Database       | 0        | 0    | 0      | 0   |
| Performance    | 0        | 0    | 0      | 0   |
| UX             | 0        | 0    | 0      | 0   |
| Dead code      | 0        | 0    | 0      | 0   |
| Duplication    | 0        | 0    | 0      | 1   |
| Readability    | 0        | 0    | 0      | 2   |
| Refactoring    | 0        | 0    | 0      | 0   |
| Best practices | 0        | 0    | 0      | 1   |
| Architecture   | 0        | 0    | 0      | 0   |
| SOLID          | 0        | 0    | 0      | 0   |
| QA             | 0        | 0    | 0      | 0   |

## Fix first

1. READ-01: two documents say less than the code does.
2. READ-02: finding IDs in comments cannot be looked up.
3. DUP-01: test set-up repeated by hand.
4. BP-01: Zod imported in two ways.

## Findings

### READ-01 · Low · Two documents say less than the code does

- [x] **Where:** `docs/security/threat-model.md:5-6`; `docs/ARCHITECTURE.md:851`
- **Problem:** The threat model's header says "8 findings, all fixed on the `t38-security-review` branch", while its Findings section lists 52 and says it is updated through T84. The file reference describes `plaintext.ts` as searching "as text and base64 at any alignment"; the code also searches JSON-escaped, URL-encoded and hex forms, and what a body inflates to (gzip, zlib, raw deflate).
- **Why it matters:** A reader of the header thinks the security review stopped at 8 findings; a reader of the file reference thinks the leak check is weaker than it is.
- **Fix:** Make the header count match the Findings table and name where later findings were fixed; complete the `plaintext.ts` row.
- **Effort:** S
- **Confidence:** high

### READ-02 · Low · Finding IDs in comments cannot be looked up

- [x] **Where:** 291 citations such as `(BUG-02)` or `(DB-01)` in `packages/**/*.ts`; `CONTRIBUTING.md` (no rule); `packages/cli/src/push/push-command.ts:65` ("carry-over D"); `packages/cli/test/claude-code-command-review.test.ts:173` ("decided: a")
- **Problem:** Comments and test titles cite review finding IDs, but the same ID exists in every review (there are nine) and no document says how to find the review a citation means. Two references point at nothing a reader can open ("carry-over D", "decided: a").
- **Why it matters:** A new developer cannot follow a citation to its reason without asking.
- **Fix:** Add a short rule to `CONTRIBUTING.md`: what the IDs are, where the reviews live (`docs/reviews`), and how to find the one a line means (`git log -S '<ID>' -- <file>` gives the commit and task). Write the two unresolvable references in plain words. Do not rewrite the 291 citations.
- **Effort:** S
- **Confidence:** high

### DUP-01 · Low · Test set-up repeated by hand

- [ ] **Where:**
  - A temporary folder made and removed by hand (`mkdtemp` and `rm` in hooks), although `useProjectFolders` exists in `packages/cli/test/claude-code-project-fixtures.ts`: `agent-boundary.test.ts:51-57`, `auth-commands.test.ts:381-407` and `:812-820`, `bin.test.ts:13-19`, `claude-code-adapter.test.ts:27-33`, `claude-code-detector.test.ts:205-211`, `claude-code-global-collector.test.ts:433-442`, `claude-code-unknown-files.test.ts:10-20`, `env.test.ts:207-214`, `local-state.test.ts:12-20`, `pull-command.test.ts:59-65`, `push-command.test.ts:60-66`, `secret-store.test.ts:24-30`, `setup-commands.test.ts:41-49`, `system.test.ts:219-228` (all in `packages/cli/test`).
  - The same crypto service and data key `beforeAll` in `pull-command.test.ts`, `push-command.test.ts`, `setup-commands.test.ts` and `agent-boundary.test.ts`.
  - `claude-code-restorer.test.ts:94-99` and `:887-892` build the project collector by hand; the fixture `collect()` does it.
  - `claude-code-after-restore.test.ts:149-153`, `:190-194`, `:213-217`: the same plugins fixture three times.
  - `push-command.test.ts:484-488` and `:654-657`: the same 6 MB codec twice.
  - `secret-store.test.ts:128-137` and `:145-154`, `:216-220` and `:245-249`: the same `createFileStore` blocks.
  - `packages/server/test/repositories.test.ts:141-148` and `:166-173`: the same session helper twice, and three more sessions written out (`:69-74`, `:126-131`, `:186-191`); `packages/server/test/bundle-service.test.ts:41-49` repeats the `input()` helper of `:60-67`.
- **Problem:** The same set-up is written out in many test files.
- **Why it matters:** A change to how tests make a temporary folder or a key has to be made in up to 14 places.
- **Fix:** One shared temporary-folder hook for all CLI tests (generalize `useProjectFolders` or add a plain `useTempDir` next to it) and one shared crypto and data key helper; reuse the existing fixtures in the places listed; one session helper in the server's `support/fixtures.ts`. Test titles and assertions stay the same.
- **Effort:** M
- **Confidence:** high

### BP-01 · Low · Zod imported in two ways

- [x] **Where:** `packages/server/src/db/bundle-cursor.ts:1`, `packages/server/src/db/env.ts:1`, `packages/server/src/port.ts:1`, `packages/server/src/http/validate.ts:2`
- **Problem:** These four files use `import { z } from 'zod'`; the other 26 files that import Zod use `import * as z from 'zod'`.
- **Why it matters:** Two patterns for one job; the next file copies whichever it sees.
- **Fix:** Use `import * as z from 'zod'` (`import type * as z` in `validate.ts`) in the four files.
- **Effort:** S
- **Confidence:** high

## Standards to adopt

- **Zod:** `import * as z from 'zod'` everywhere (BP-01).
- **Temporary folders and keys in tests:** the shared hooks, never `mkdtemp` in a test file (DUP-01).
- **Finding IDs in comments:** the rule to add to `CONTRIBUTING.md` (READ-02).

## What will break first at scale

1. **Bundle bytes in Postgres** (`packages/server/src/storage/postgres-blob-store.ts`): 50 MB per account in the database; the `BlobStore` interface is the planned way out (object storage).
2. **Rate-limit counters in Postgres** (`packages/server/src/rate-limit/postgres-rate-limiter.ts`): one write per limited request; the `RateLimiter` interface allows a faster store.
3. **One free Render instance** (`render.yaml`): sleeps when idle, so the first request waits; the CLI's wake-up check covers it for now.

## Suggested order of work

1. READ-01, READ-02 and BP-01 together: documents, two comments and four import lines; no behaviour changes.
2. DUP-01: test files only; compare test titles before and after.

## Not reviewed

- The 13 earlier review records under `docs/reviews` (reviews 1 to 8, 4,619 lines) were not read again in this review: they are records of past reviews, not code or current documentation. They are marked `not re-read` in `files.md`.
- Generated and ignored files (`node_modules`, `dist`, `pnpm-lock.yaml`), per the scope rules.
- The deployed server on Render and the live database: not touched.
