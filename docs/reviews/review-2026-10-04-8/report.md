# Code Review — Agent Nomad — 2026-10-04 (review 8)

**Scope:** the whole repository on `dev` at `dc37930`, after the fixes of review 7 (T84 and T85).
**Stack:** pnpm monorepo, TypeScript strict, Node 22.13 or newer; packages `contracts`, `core`, `cli`, `server`, `e2e`; Hono, Drizzle and Postgres on the server; Vitest.
**Coverage:** 288 of 288 files, 39,268 lines. 279 files (35,715 lines) were read in full in this pass. The 9 older review files (3,553 lines, reviews 1 to 6) were not read again: `git diff` shows them unchanged since they were read in review 7.
**Checks run:** typecheck, lint and format check pass; tests pass (1,375 passed, 17 skipped, the OS-specific ones); `pnpm knip` clean; `pnpm audit --prod` clean ("No known vulnerabilities found"); CI green on `dc37930` on every OS and both Node versions (run 37203548775).

## Summary

The code is in good health. Every finding of review 7 is fixed and the fixes hold: the settings file names now come from the data file, the tests sit in files named after their modules in `cli` and `server`, and the two documents agree on the composition roots. This review found 4 new items, all Low. One is a real but unreachable bug that the review 7 fix introduced: the global collector would lose programs if a second global settings file were ever listed. The other three are leftovers of rules the project set for itself: the test-file naming rule is not applied in `core` and `contracts`, a few test files still build set-up that a shared helper already gives, and the threat model does not record the last security fix. Nothing found touches a user today.

## Scores

| Area                         | Score /10 | One-line reason                                                                        |
| ---------------------------- | --------- | -------------------------------------------------------------------------------------- |
| Correctness                  | 9.5       | One latent bug (BUG-01), unreachable with today's data.                                |
| Security                     | 10        | Nothing found; the review 7 fix holds and is tested.                                   |
| Performance                  | 10        | Nothing found.                                                                         |
| User experience              | 10        | Nothing found.                                                                         |
| Readability                  | 9.5       | The test-file rule stops at two packages (READ-01); one doc is a fix behind (READ-02). |
| Maintainability              | 9.5       | Some test set-up is still written twice (DUP-01).                                      |
| Architecture and scalability | 10        | Boundaries hold and are enforced by lint.                                              |
| Test coverage                | 9.5       | Broad and meaningful; no test covers two global settings files (part of BUG-01).       |

| Category    | Critical | High | Medium | Low |
| ----------- | -------- | ---- | ------ | --- |
| Bugs        | 0        | 0    | 0      | 1   |
| Security    | 0        | 0    | 0      | 0   |
| Duplication | 0        | 0    | 0      | 1   |
| Readability | 0        | 0    | 0      | 2   |
| All others  | 0        | 0    | 0      | 0   |

## Fix first

1. BUG-01: collect the programs of all global settings files in one call.
2. READ-01: apply the test-file rule in `core` and `contracts` too.
3. DUP-01: use the shared test helpers where they already fit.
4. READ-02: record the review 7 security fix in the threat model.

## Findings

### Bugs

### BUG-01 · Low · A second global settings file would lose the first file's programs

- [x] **Where:** `packages/cli/src/agents/claude-code/global-collector.ts:166-172` (the loop) and `:102-105` (where `programs()` adds `.agentnomad/programs.json`)
- **Problem:** since T84 the collector loops over every file in `GLOBAL_SETTINGS_FILES` and calls `programs()` once per file. Each call adds its own `.agentnomad/programs.json` entry, and `uniqueByPath` then keeps only one of them.
- **Why it matters:** today the data file lists one global settings file, so this cannot happen. The day a second one is listed (the reason the loop exists), the programs of one file are silently left out of the bundle, and pull no longer offers to install them.
- **Fix:** gather the commands of every settings file first and call `programs()` once, or let `programs()` return the list and write the entry once after the loop. Add a test with two settings files.
- **Effort:** S
- **Confidence:** high (read in the code; not reachable with today's data)

### Duplication

### DUP-01 · Low · Test set-up written again where a shared helper exists

- [x] **Where:**
  - `packages/cli/test/claude-code-restorer.test.ts:36-51` makes the same temporary root, home, `.claude` and project folders as `useProjectFolders` in `claude-code-project-fixtures.ts:22-34`.
  - `createLocalState({ path: join(dir, 'state.json'), server: 's', platform })` is written by hand in `agent-boundary.test.ts:202-206`, `auth-commands.test.ts:383-387` and `:818-822`, `pull-command.test.ts:111-116`, `:138-142` and `:785-790`; `localStateIn(dir)` in `fakes.ts:160-165` does exactly this.
  - `setup-commands.test.ts:52-58` builds by hand the adapter that `fakeAdapter('claude-code', 'Claude Code', …)` in `fakes.ts` gives.
  - `push-command.test.ts:66-98` defines its own `fakeAdapter(options)`: the same name as the helper in `fakes.ts`, with another signature.
- **Problem:** CONTRIBUTING says to use the shared fakes "instead of a new copy". These copies remain.
- **Why it matters:** a change to the set-up (a new field of the local state, a new folder) must be made in several places, and two helpers with one name mislead a reader.
- **Fix:** use `useProjectFolders` and `localStateIn` in those files; use `fakeAdapter` from `fakes.ts` in `setup-commands.test.ts`; rename the helper in `push-command.test.ts` (for example `collectingAdapter`). Test titles stay the same.
- **Effort:** S
- **Confidence:** high

### Readability

### READ-01 · Low · The test-file rule is not applied in `core` and `contracts`

- [x] **Where:**
  - `packages/core/test/bundle-codec.test.ts` tests `gzip-bundle-codec.ts`.
  - `packages/core/test/crypto.test.ts` tests `sodium-crypto.ts` and, at `:168-213`, `envelopes.ts`.
  - `packages/core/test/paths.test.ts` tests `path-resolver.ts`.
  - `packages/contracts/test/answers.test.ts:201-214` ("client version header") tests `api/common.ts`.
  - `packages/cli/test/program.test.ts:264-278` tests `createApp` of `app.ts`.
  - `packages/cli/test/pull-command.test.ts:686-700` tests push only.
- **Problem:** CONTRIBUTING and ARCHITECTURE (Part 2) say a module's tests are in the file named after it, and ARCHITECTURE lists every exception. These files are neither named after the module they test nor in that list.
- **Why it matters:** the rule exists so tests are found by name; here the name points at an interface file (`bundle-codec.ts`, `crypto.ts`, `paths.ts`) that holds no logic.
- **Fix:** rename to `gzip-bundle-codec.test.ts`, `sodium-crypto.test.ts` and `path-resolver.test.ts`, move the two `envelopes` blocks to `envelopes.test.ts`, and move the three single tests to `api.test.ts`, `app.test.ts` and `push-command.test.ts`. Or name them as exceptions in ARCHITECTURE. Test titles stay the same.
- **Effort:** S
- **Confidence:** high

### READ-02 · Low · The threat model does not record the review 7 security fix

- [x] **Where:** `docs/security/threat-model.md:3` ("updated through T83"), the row of threat 13 (`:48`, which cites T69 and T71 only) and the findings tables, which end at number 44 (`:128-132`)
- **Problem:** review 7's SEC-01 (the other-OS warning printed a hook command with its real line breaks; fixed in T84) has no row, while the same kind of finding, number 43, has one.
- **Why it matters:** the document says it lists every finding and its fix; a reader checking threat 13 does not see that the warning line is covered too.
- **Fix:** add finding 45 under a "review 7" heading, cite T84 in the row of threat 13, and change the header to "updated through T84".
- **Effort:** S
- **Confidence:** high

## Standards to adopt

- **Test files:** one rule for all five packages: the file is named after the module, or it is named in the exception list of ARCHITECTURE Part 2. Bring `core` and `contracts` in line (READ-01).
- **Test set-up:** temporary folders through `useProjectFolders`, local state through `localStateIn`, a detect-only adapter through `fakeAdapter` (DUP-01).
- **Security fixes:** every SEC finding of a review gets a row in the threat model in the same task that fixes it (READ-02).

## What will break first at scale

Nothing new since review 7; the same three hold.

1. **The free host and database.** One Render free instance and one Neon database serve every user; the first request after sleep waits about a minute (`render.yaml`, `packages/cli/src/api/http-api-client.ts`).
2. **Ciphertext in Postgres.** Encrypted bytes live in `bundle_blobs`; at many users the 50 MB per account adds up. The `BlobStore` interface is ready for object storage (`packages/server/src/storage/`).
3. **One restorer for one agent.** The generic parts of `agents/claude-code/restorer.ts` must move to `agents/shared/` when the second adapter is written, as ADDING-AN-AGENT already says.

## Suggested order of work

1. BUG-01 on its own: code and a new test.
2. READ-01 and DUP-01 together: both only move or reuse test code; compare the list of test titles before and after.
3. READ-02: one document.

## Not reviewed

- Binary files (images under `docs/images` and `.a1x6/images`), `pnpm-lock.yaml`, and the generated Drizzle snapshots under `packages/server/drizzle/meta`.
- The 9 review files of reviews 1 to 6 were not read again in this pass (unchanged since review 7).
- Not checked: the live Render deploy and the production database. Migrations were not run and no real database was contacted.
