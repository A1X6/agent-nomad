# Code Review — Agent Nomad — 2026-10-03 (review 5)

**Scope:** the whole repo at `dev` `b49a335`, after the review 4 fixes T69 to T74.
**Stack:** pnpm monorepo, TypeScript strict, Node 22.13 or newer. Packages: `contracts` (Zod schemas), `core` (encryption, bundle format, merge), `cli` (the `agentnomad` command, Commander and clack), `server` (Hono, Drizzle, Neon Postgres), `e2e`. Tests with Vitest; server tests on PGlite.
**Coverage:** 253 of 253 files read in full, 35,512 lines. See `files.md` for one row per file.
**Checks run:** type check pass · lint pass · format check pass · tests pass (1,291 passed, 15 skipped, 52 files) · `pnpm audit --prod` pass (no known vulnerabilities) · `pnpm knip` pass (nothing unused) · CI on `b49a335` pass.

**How it was done:** six reviewers each read one part of the repo line by line and confirmed their findings at exact lines (several by running the real code offline). The orchestrator then re-opened the code behind every Medium finding and the main bugs, merged one finding two reviewers reported twice, and did the cross-file passes.

## Summary

The code is in good shape and the review 4 fixes hold. There is no Critical and no High finding: 57 findings, 4 Medium and the rest Low. Of the 63 review 4 fixes, the reviewers found none that is wrong, one with a side effect (BUG-06: the stricter `fromHex` makes `verifyAuthKey` throw on a stored hash that is not hex) and eight that are incomplete (SEC-02, ARCH-03, READ-01, READ-04, READ-15, QA-03, QA-04, DUP-03).

Three of the four Medium findings are in the pull safety review, which reads commands with one helper (`commandWords`, `commandsInSettings`). A hook written with separate `args` loses its script on push and is refused on pull (BUG-01). A changed script named inside a quoted compound command, or next to `;`, is written without being shown as something that runs (SEC-01). A command block nested inside another open code fence is not reported (SEC-02). The fourth is on the server: downloads have no per-account limit (SEC-03).

Two Low bugs are worth doing with them, because they can lose a choice the user never made: pull records a setup as fully pulled when it left differing files unasked (BUG-05), and a login made while the keychain failed stays in the plain secrets file (BUG-04).

The rest is cleanup: leftover copies of test helpers, tests filed away from their code, docs that did not follow the latest changes, and a few Claude Code names left in generic code.

Nothing found blocks a merge of `dev` into `main`. The four Medium findings existed before review 4 (SEC-02 in a narrower form), so the merge does not make anything worse.

## Scores

| Area                         | Score /10 | One-line reason                                                                                                                                             |
| ---------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness                  | 9         | No High bug; exec-form hooks lose their scripts (BUG-01) and five narrow Low bugs.                                                                          |
| Security                     | 9         | Encryption, auth and input checks hold; the pull review can miss a script or a nested command block (SEC-01, SEC-02), and downloads are unlimited (SEC-03). |
| Performance                  | 8         | Fine for today's size; database round trips per request and whole bundles in memory are the first ceilings.                                                 |
| User experience              | 9         | Clear messages; five small Low items (a success line that can be untrue, a column out of line).                                                             |
| Readability                  | 8         | Well named and commented; some tests away from their code, docs behind the latest changes.                                                                  |
| Maintainability              | 8         | Strict lint, knip, shared fakes; a few helpers and rules are still written more than once.                                                                  |
| Architecture and scalability | 9         | Clean package and adapter boundaries; three small Claude Code leftovers in generic code.                                                                    |
| Test coverage                | 9         | 1,291 tests, cross-OS end-to-end runs; a few rules untested and three tests that cannot fail.                                                               |

| Category             | Critical | High  | Medium | Low    |
| -------------------- | -------- | ----- | ------ | ------ |
| Bugs                 | 0        | 0     | 1      | 5      |
| Security             | 0        | 0     | 3      | 3      |
| Database and queries | 0        | 0     | 0      | 0      |
| Performance          | 0        | 0     | 0      | 0      |
| User experience      | 0        | 0     | 0      | 5      |
| Dead code            | 0        | 0     | 0      | 4      |
| Duplication          | 0        | 0     | 0      | 9      |
| Readability          | 0        | 0     | 0      | 15     |
| Refactoring          | 0        | 0     | 0      | 0      |
| Best practices       | 0        | 0     | 0      | 1      |
| System design        | 0        | 0     | 0      | 4      |
| SOLID and OOP        | 0        | 0     | 0      | 0      |
| QA and testing       | 0        | 0     | 0      | 7      |
| **Total**            | **0**    | **0** | **4**  | **53** |

## Fix first

1. **SEC-01** · Medium · the pull review misses a changed script named inside `bash -c "...; ..."` or next to `;`, so it is written unflagged, even with `--yes --overwrite`.
2. **BUG-01** · Medium · a hook written as `command` plus `args` loses its script: push does not save it, pull refuses it.
3. **SEC-02** · Medium · a command block nested inside another open code fence is never reported (review 4's SEC-02 fix is incomplete).
4. **SEC-03** · Medium · downloads have no per-account limit, so one account can loop 5 MB downloads.
5. **BUG-05** · Low · pull records a setup as fully pulled when it left differing files unasked; the next push can replace them without a question.
6. **BUG-04** · Low · a login made while the keychain failed stays in the plain secrets file once the keychain works again.
7. **BUG-06** · Low · `verifyAuthKey` throws instead of answering false for a stored hash that is not hex (side effect of review 4's BP-03).
8. **SEC-04** · Low · bundle file paths are printed with their line breaks in pull's messages.
9. **QA-07** · Low · the e2e leak check ignores what the stale PC uploads.
10. **ARCH-04** · Low · the agent-boundary lint rule does not cover `commands/`.

## Findings

### Bugs

#### BUG-01 · Medium · Hooks in exec form (`command` + `args`) lose their scripts: push skips them, pull refuses them

- [ ] **Where:** `packages/cli/src/agents/claude-code/settings-commands.ts:66-75` (`commandsInSettings` keeps `hook.command` only and drops `hook.args`). Every caller inherits this: `hook-scripts.ts:49` and `:95` (scripts push collects and pull allows), `global-collector.ts:59` and `:78`, `restorer.ts:121-126` (`hooksForOtherOs`), `unknown-files.ts:45` (`hookScriptNames`).
- **Problem:** Claude Code runs a hook in exec form when `args` is set: `command` is the executable and each `args` element is one argument, with no shell. The hooks reference recommends this form whenever a path holds a placeholder. `command-review.ts:111` already treats `command + args` as what runs. The collector, the allow list and the other-OS warning only look at `command`. A probe showed it:
  - `{"command":"node","args":["/home/a/.claude/hooks/check.js"]}` → `hookScripts` returns `[]`.
  - The same hook in shell form returns `["hooks/check.js"]`.
  - On pull, `globalDestination('hooks/check.js', …)` answers `refused: no hook or status line in this setup runs it`.
- **Why it matters:**
  - A hook written in the documented exec form breaks on every other PC: push never saves its script (it is outside the synced folders) and says nothing.
  - `agentnomad push` also reports `hooks/` as unknown, because `hookScriptNames` misses the script.
  - A Windows-only `.ps1` passed in `args` gets no "will likely not run here" warning.
- **Fix:** Make `commandsInSettings` return the run words, not only a command line: for exec form, `[command, ...args]` as separate words, with no shell splitting (an `args` element may hold spaces); for shell form, `commandWords(command)`. Then let `hookScripts`, `projectHookScripts` and `hooksForOtherOs` use those words. Add a collector, restorer and unknown-files test with an exec-form hook.
- **Effort:** S–M
- **Confidence:** high (probe, plus the Claude Code hooks reference)

#### BUG-02 · Low · The program locator only recognises npm packages whose name equals the command

- [ ] **Where:** `packages/cli/src/agents/claude-code/programs.ts:77-92`. Tests cover only the same-name case: `packages/cli/test/claude-code-global-collector.test.ts:473-510`.
- **Problem:** The lookup reads `node_modules/<command>/package.json` beside the launcher. A scoped package (`@scope/tool` providing `tool`) or a package whose bin name differs (`@mermaid-js/mermaid-cli` → `mmdc`, `typescript` → `tsc`) is never found, so it is saved with `npm: null`. The scoped branch at `:89` (`name.split('/').pop() === command`) cannot match for a real scoped install, because that install is never at `node_modules/<command>`.
- **Why it matters:** Pull then only says "Install it for them to work" (`after-restore.ts:121-125`). It never offers the `npm install -g name@version` that the feature exists for.
- **Fix:**
  - On macOS and Linux, `realpath` the launcher (npm links it into `lib/node_modules/<pkg>/…`) and walk up to its `package.json`.
  - On Windows, read the `.cmd` shim, which names `node_modules\<pkg>\…`.
  - Add a scoped-package test.
- **Effort:** M
- **Confidence:** high

#### BUG-03 · Low · Temp files left by an interrupted atomic write are pushed as setup files

- [ ] **Where:** `packages/cli/src/agents/shared/file-gathering.ts:66-67` and `:160` (`isMarkerCopy` skips the backup and incoming markers only). The marker is a bare literal in two places: `packages/cli/src/system/files.ts:53` (`.agentnomad-tmp-`) and `packages/cli/src/agents/claude-code/unknown-files.ts:63`.
- **Problem:** `writeFileAtomically` writes `.<name>.agentnomad-tmp-<hex>` next to the target. If the process dies before the rename, that file stays in, for example, `skills/x/`. `walk` collects it and push saves it to every PC. Only `unknown-files` knows the marker, and only for top-level names.
- **Why it matters:** Half-written copies spread to other PCs, which is clutter and can be a broken file.
- **Fix:** Export one `TEMP_MARKER` (in `system/files.ts`, or in core next to `BACKUP_MARKER`). Skip it in `isMarkerCopy` and use it in `unknown-files.ts`.
- **Effort:** S
- **Confidence:** high (code); low impact (needs a crash mid-write)

#### BUG-04 · Low · A login made while the keychain was failing is stranded in the plain file once the keychain works again

- [ ] **Where:** `packages/cli/src/secrets/create-secret-store.ts:35-56`; `packages/cli/src/auth/auth-commands.ts:146` (`readyForNewLogin` checks only the store it was given)
- **Problem:** The file login is moved into the keychain only when the keychain holds **no** session token (`if (token === null)`, line 41). Scenario: the user is logged in (keychain). The keychain fails for a while (locked, a "Deny" click; the case the comment at lines 22-24 describes), so `createSecretStore` returns the file store. `login` (or `register`) then sees no login in the file (`hasLocalSession(file)` is false), does not ask "already logged in", and saves the new login in the file. When the keychain works again it still holds the old token, so `createSecretStore` returns the keychain and the new login stays in `secrets.json` for good.
- **Why it matters:** Later commands run as the old login while `useAccount` already switched the local state to the new account (`auth-commands.ts:297`), and the new data key stays in a plain file the comment promises is "neither stranded nor left in plain text". If the two logins are different accounts, push and pull use the old account's keys without saying so.
- **Fix:** When the keychain works and the file also holds a full login, decide which is newer instead of ignoring the file: simplest is to prefer the file login (it can only have been written while the keychain failed, so it is the later one), move it into the keychain and log the old keychain session out (or at least warn). Add a test with both stores holding a login.
- **Effort:** S
- **Confidence:** high on the code path; the trigger (a keychain that fails and then recovers between two logins) is rare.

#### BUG-05 · Low · Pull records a setup as fully pulled when it left differing files unasked

- [ ] **Where:** `packages/cli/src/pull/pull-command.ts:525-546`
- **Problem:** `applyOne` calls `setRevision(..., { partial: declined })` (lines 525-527) before it looks at `notAsked` (line 538). A setup whose restore met a differing file the plan never asked about is reported as not done (exit 1, "Pull again with --merge or --overwrite"), yet the local state now says this PC has that revision, with no partial note.
- **Why it matters:** `status` then shows the setup as up to date, and the next `push` from this PC passes `decide` (`push-command.ts:343-368`: not partial, `onServer === known`) and replaces the saved copy, including the local versions of the files the user never chose about, for every PC, without a question. That is the exact case the `#partial` note exists to stop for declined commands. The path is rare (a file that changes between plan and apply, or an agent's own restore step meeting a conflict), and the test at `packages/cli/test/pull-command.test.ts:529-562` checks the error but not the recorded revision.
- **Fix:** When `notAsked` is not empty, record the revision with `partial: true` (so push asks first), or do not record it; add the state check to that test.
- **Effort:** S
- **Confidence:** medium (the code path is certain; whether recording the revision is intended is not written anywhere).

#### BUG-06 · Low · `verifyAuthKey` throws, instead of returning false, for a stored hash that is not hex

- [ ] **Where:** `packages/server/src/auth/server-keys.ts:62-69`; cause: `packages/contracts/src/encoding.ts:26-27` (T72 made `fromHex` throw); test: `packages/server/test/server-keys.test.ts:16-23`
- **Problem:** `verifyAuthKey` runs `fromHex(storedHash.slice(AUTH_HASH_PREFIX.length))` before it checks the prefix. Since T72 (review 4 BP-03), `fromHex` throws "Not a hex string" for anything that is not even-length hex. The comment at lines 65-66 says the check runs "even for an unknown format" and only `known && matches` decides the result, but a stored hash in another format now throws before that point. Confirmed with `fromHex`: `'argon2id$v=19$m=65536$abc'` and `'hmac-sha256-v2$<64 hex>$salt'` throw, while `''`, `'auth-hash'` and `'hmac-sha256-v9$<64 hex>'` do not. The "unknown-format" test only uses the last kind (`stored.replace('v1', 'v9')`, hex payload), so it cannot catch this.
- **Why it matters:** Nothing breaks today, because every stored hash is v1 and an unknown user passes `''`. But the file says a new scheme will be added "as v2 next to v1". If a v2 hash with a non-hex part reaches this code (for example during a rollout, or when the v2 branch falls through to v1), login and account delete answer 500 instead of 401. The time taken would then depend on the stored format, which the comment says must not happen.
- **Fix:** Decode inside a guard that never throws, for example `const expected = known && /^[0-9a-f]{64}$/.test(rest) ? fromHex(rest) : new Uint8Array(32);`. Then call `subtle.verify` as now and return `known && matches`. Add `'argon2id$v=19$abc'` and `'hmac-sha256-v1$zz'` to the test at `server-keys.test.ts:16-23`, each expecting `false`.
- **Effort:** S
- **Confidence:** high (the throw is reproduced; the path from login to here is read in `auth-service.ts:147-151` and `:169-171`)

### Security

#### SEC-01 · Medium · The pull review misses a changed script when the command names it inside a quoted compound command or next to shell punctuation

- [ ] **Where:** `packages/cli/src/agents/claude-code/command-review.ts:238-255` (`scriptsRun`; whole-word match at `:248`); words from `settings-commands.ts:81-88` (`commandWords`). The same splitting in `hook-scripts.ts:50` and `:96` decides what push collects.
- **Problem:** A script counts as "run" only when one shell word equals its path or ends with `/<path>`. A probe ran an unchanged hook here, with `skills/x/run.sh` changed in the incoming setup:

  | Hook command                                | What the review returns      |
  | ------------------------------------------- | ---------------------------- |
  | `bash ~/.claude/skills/x/run.sh`            | `["script skills/x/run.sh"]` |
  | `bash -c "~/.claude/skills/x/run.sh; true"` | `[]`                         |
  | `bash ~/.claude/skills/x/run.sh;`           | `[]`                         |

  The same gap hits `pwsh -Command "& '…/run.ps1' -Flag"` and `cmd /c "…\run.cmd && …"`.

- **Why it matters:** T38 and T44 promise that a changed script behind an unchanged hook is shown before it is written. Here the script is written without being flagged as something that runs:
  - When it differs from the local copy, the user only gets the generic "differs" question. `--yes --overwrite` answers that question, although `--yes` must never accept new code.
  - When it is not on this PC yet, nothing is asked at all.

  It affects scripts in the synced folders (`skills/`, `commands/`, `agents/`, `rules/`…) and project scripts under `.claude/`, which `restore-rules.ts:140` allows without a hook.

- **Fix:** Match a script path anywhere in a word, bounded by start, `/`, or a shell delimiter on the left, and by end or one of `` ;&|)<>"'` `` or whitespace on the right. Alternatively, split each word further on shell operators before matching. Use the same helper in `hookScripts` and `projectHookScripts`, so push saves such scripts too. Add the three probe cases as tests.
- **Effort:** S
- **Confidence:** high for the mechanism (probe); medium for how common such hooks are (`bash -c "…; …"` is a usual hook shape)

#### SEC-02 · Medium · A ` ```! ` block nested in an open plain fence is never reported (T69's SEC-02 fix is incomplete)

- [ ] **Where:** `packages/cli/src/agents/claude-code/runnable-markdown.ts:21-25` (any fence line opens a block, at any indentation) and `:28-47` (inside a plain block, only inline `` !`…` `` placeholders are scanned; a ` ```! ` opener is neither a close nor reported).
- **Problem:** Once a plain fence is open, every ` ```! ` block until its close is invisible to the review. A probe ran `runnableInMarkdown` on three files:

  | Markdown                                                  | Result          |
  | --------------------------------------------------------- | --------------- |
  | `~~~` / ` ```! ` / `curl … \| sh` / ` ``` ` / `~~~`       | `[]`            |
  | 4-space-indented ` ``` ` / ` ```! ` / `echo hi` / ` ``` ` | `[]`            |
  | ` ``` ` / ``example: !`date` `` / ` ``` `                 | ``["!`date`"]`` |

  In the second file, CommonMark reads the 4-space line as indented code, not a fence. So T69's "open at any indentation" rule now fails toward **hiding** the real ` ```! ` block that follows it.

- **Why it matters:** A pulled skill, command or subagent could run a command block without it ever being listed. The module's own rule at `:43-44` ("the docs exempt no part of the file, so a placeholder inside an ordinary code block counts too") assumes Claude Code does not honour enclosing fences, and that assumption is applied to inline placeholders but not to ` ```! ` blocks.
- **Fix:** While a plain block is open, still treat a line matching `^\s*(`{3,}|~{3,})\s*!\s*$` as a command opener (or at least report the lines after it, up to the next closing fence). Add the first two cases above as tests.
- **Effort:** S
- **Confidence:** high for the behaviour (probe). Medium for exploitability: whether Claude Code would run a ` ```! ` inside a `~~~` block was not verified; check its skill preprocessing.

#### SEC-03 · Medium · Downloads and lists have no per-account limit

- [ ] **Where:** `packages/server/src/http/routes/bundles.ts:76-82` (`writeLimit` is defined), `:120` and `:172` (it is used only on PUT and DELETE), `:85-116` (GET list and GET download have no limit); `packages/server/src/rate-limit/rate-limiter.ts:53-57` (the only rule for signed-in bundle routes is writes)
- **Problem:** A signed-in client can call `GET /bundles/:agent/:scopeKey` as often as it likes. Each call reads up to 5 MB from Postgres (`bundle_blobs`) and sends it out of Render. The per-IP limits cover only the auth routes, and `writesPerAccount` covers only saves and deletes. The test at `bundle-routes.test.ts:322-323` says so on purpose: "Reading is not limited this way."
- **Why it matters:** Anyone can get an account (5 registrations per IP per hour). One account that downloads the same full 5 MB setup in a loop moves gigabytes an hour out of Neon and Render. On free tiers that can use up the shared transfer and compute for every user, so a single cheap account can take the service down.
- **Fix:** Add a `readsPerAccount` rule to `RATE_LIMITS` (for example 600 an hour, far above what `pull` needs for 100 setups) and apply it to the download route with the same middleware shape as `writeLimit`. The list route is cheap and could stay unlimited, or share the rule. Add a route test like the writes test. The `429 rate_limited` code already exists, so installed 1.0.3 CLIs understand it.
- **Effort:** S
- **Confidence:** high that no limit exists (read in code and stated by the test); medium on the cost estimate, which depends on the hosting plan.

#### SEC-04 · Low · Bundle file paths are printed with their line breaks in pull's messages (SEC-03 covered the review lines only)

- [ ] **Where:** `packages/cli/src/pull/pull-command.ts:248` (conflict question `${path} already exists here…`), `:354` (`Skipped ${[...blocked].join(', ')}`), `:540` (`Left as they are … ${notAsked.join(', ')}`); bundle paths may hold `\n` (`packages/contracts/src/bundle.ts:60-64` refuses only NUL, backslash, absolute, empty, `.` and `..` segments)
- **Problem:** These messages go through the reporter's or prompter's `printable`, which keeps line breaks (`ui/printable.ts:168-176`). SEC-03's fix uses `printableLine` for each review entry's label and command (line 341), but the file paths printed in the same review warning and in the conflict question can still add lines.
- **Why it matters:** A bundle path such as `a.md\n  ~ hook …` can make the skip warning or a conflict question show text that looks like extra entries or advice. Impact is small: the bundle is sealed with the user's own data key, and these lines come after or outside the allow question.
- **Fix:** Pass bundle paths through `printableLine` wherever they are joined into one line (`[...blocked].map(printableLine)`, `notAsked.map(printableLine)`, `printableLine(path)` in the default question).
- **Effort:** S
- **Confidence:** medium (confirmed by reading; not exercised).

#### SEC-05 · Low · The drift issue still renders raw HTML images from the changelog

- [ ] **Where:** `packages/cli/scripts/drift/drift.ts:210-216` (`inert`), used at `:262`
- **Problem:** `inert` escapes `@` mentions and Markdown `![` images, as its comment promises ("an image cannot load from elsewhere"), but leaves HTML such as `<img src="https://…">`, which GitHub renders in issue bodies.
- **Why it matters:** A changelog line with an HTML image would load it in the drift issue. The source is Anthropic's own changelog, so the risk is low; the comment overstates what the function does.
- **Fix:** Also neutralise `<` (e.g. replace it with `&lt;`), or wrap each changelog line in inline code.
- **Effort:** S
- **Confidence:** high

#### SEC-06 · Low · A test fixture uses fragments of the maintainer's real claude.ai synced-skills folder name

- [ ] **Where:** `packages/cli/test/claude-code-account-skills.test.ts:27` (`const ACCOUNT = '7c844940_79950eec'`)
- **Problem:** the two 8-hex parts are the first 8 characters of the two IDs in the real synced-skills folder on the maintainer's PC (`~/.claude/skills/synced/7c844940-…_79950eec-…`, the same IDs appear in this floor's skill paths). The repository is public.
- **Why it matters:** low. They are not secrets and are truncated, but they are identifiers of a real account or organization, and CONTRIBUTING asks to keep real data out of tests. A made-up value tests the same thing.
- **Fix:** use an obviously fake value in the real shape, e.g. `'00000000-0000-4000-8000-000000000000_11111111-1111-4111-8111-111111111111'`.
- **Effort:** S
- **Confidence:** high that the fragments match the real folder; medium on what the two IDs identify (user or organization).

### User experience

#### UX-01 · Low · "Added … as local skills" is said even when the restorer wrote none of a skill's files

- [ ] **Where:** `packages/cli/src/agents/claude-code/after-restore.ts:244-254`
- **Problem:** `added` comes from the plan (`now.toAdd`), not from `report.written`. Files the restorer refuses or skips are only warned about, and the success line still names every skill. Examples: a Windows-invalid name such as `con.md` or `a:b.md` from a macOS bundle, or a write error.
- **Why it matters:** The user is told a skill was added when it is missing or partial.
- **Fix:** Build the success list from skill names that have at least one written file. Name the others ("not added: …") next to the warnings.
- **Effort:** S
- **Confidence:** high

#### UX-02 · Low · Unrelated processes count as "Claude Code is running"

- [ ] **Where:** `packages/cli/src/agents/claude-code/running-claude.ts:80-84`
- **Problem:** Both patterns match anywhere in a command line, not only on the program being run. A probe returned `true` for both of these:
  - `/usr/bin/vim /home/a/projects/claude` (an editor open on a folder named `claude`)
  - `npm install -g @anthropic-ai/claude-code`
- **Why it matters:**
  - Pull's plan keeps asking to close Claude Code. "I closed it, continue" loops until the user picks Skip (`claude-code-adapter.ts:125-137`).
  - With `--yes`, `~/.claude.json` is left unmerged with a false "was running" warning (`claude-json-merge.ts:169-174`).
- **Fix:** Test the first word of the line (quoted or not) for the `claude`/`Claude` program name. Accept the `@anthropic-ai/claude-code` path only when the first word is `node`/`node.exe`. Add the two lines above as `false` cases.
- **Effort:** S
- **Confidence:** high for the match (probe); low impact

#### UX-03 · Low · Push remembers a typed project name before anything is saved

- [ ] **Where:** `packages/cli/src/push/push-command.ts:181-198` (`rememberProject` in `projectName`), called from the plan step at `:213`
- **Problem:** The plan step is meant to only ask (T59), but it writes the folder's project name to `state.json` as soon as it is typed. If the user then cancels a later question (memory, optional parts, env values, "replace a newer copy?") or the setup is skipped, the name stays remembered, and the next push uses it without asking again.
- **Why it matters:** A typo in the name becomes sticky and silent; the only way out is to pass `--project` or edit `state.json`. Other PCs then see the setup under the typo once a push goes through.
- **Fix:** Return the name from the plan and call `rememberProject` in the apply step after the project upload succeeds (pull already remembers it only after restoring, `pull-command.ts:528-529`).
- **Effort:** S
- **Confidence:** high

#### UX-04 · Low · `agentnomad env` misaligns the "used by" column when a variable is set in settings

- [ ] **Where:** `packages/cli/src/env/env-command.ts:24-29`
- **Problem:** The three status texts are padded by hand: `'set in settings'` is 15 characters after `slice(2)`, `'set here      '` and `'missing here  '` are 14, so rows with "set in settings" push their "used by" text one column right.
- **Why it matters:** Cosmetic only; the list is the command's whole output.
- **Fix:** Keep the three labels unpadded and `padEnd` them to the longest label's length.
- **Effort:** S
- **Confidence:** high (lengths checked with node)

#### UX-05 · Low · The Windows short-name rule refuses long names that can never be 8.3 aliases

- [ ] **Where:** `packages/core/src/path-resolver.ts:11-12` (`SHORT_NAME = /~\d+(\.[^.]*)?$/`), used at `:41`; reached on pull through `packages/cli/src/agents/claude-code/restorer.ts:293-294`.
- **Problem:** any segment that ends in `~<digits>` (plus any extension) is refused on Windows as "a Windows short name". Run on the real function: `release-notes~3` → refused, `notes~2024.md` → refused (also `SSH~1`, `PROGRA~1`, `backup~1.txt`, which are right). An 8.3 alias has at most 8 characters before the dot and at most 3 after it, so `release-notes~3` (15) and `notes~2024.md` cannot reach another file under that name.
- **Why it matters:** a file pushed from macOS or Linux with such a name (draft and version names like `plan~2.md` are short and stay refused; long ones like `release-notes~3.md` are not aliases) is skipped on every Windows pull with a misleading reason. The rule is security-relevant (T43), so it errs the safe way; this is about the message and a lost file, not a hole.
- **Fix:** refuse only names that fit 8.3: base (before the first dot) at most 8 characters containing `~<digits>`, extension at most 3, e.g. `/^[^.]{0,6}~\d{1,6}(\.[^.]{0,3})?$/` with the base length checked to be ≤ 8. Keep `SSH~1`, `PROGRA~1/x.md`, `backup~1.txt` refused in `paths.test.ts:55-57` and add `release-notes~3.md` as allowed.
- **Effort:** S
- **Confidence:** medium (the refusal is reproduced; the 8.3 length rule is Windows' documented format, not tested on NTFS here)

### Dead code

#### DEAD-01 · Low · `FileGatherer.relativeInside` has no caller outside its own file

- [ ] **Where:** `packages/cli/src/agents/shared/file-gathering.ts:50-51` (interface) and `:177` (returned). It is used only inside the file, through the closure at `:102` and `:107`. `hook-scripts.ts:46` calls `bundlePathInside` directly. A repo-wide search of src and tests found no other use. knip does not report interface members.
- **Fix:** Drop it from the interface and the returned object.
- **Effort:** S
- **Confidence:** high

#### DEAD-02 · Low · `SecretStore.set` is used only by tests

- [ ] **Where:** `packages/cli/src/secrets/secret-store.ts:124` (interface), implementations at `packages/cli/src/secrets/keychain-store.ts:97-99` and `packages/cli/src/secrets/file-store.ts:187-191`; callers only in `packages/cli/test/secret-store.test.ts:84-127` and `packages/cli/test/fakes.ts:53`
- **Problem:** Production saves through `setMany` (`auth/local-session.ts:22`, `secrets/create-secret-store.ts:48`); no file under `packages/cli/src` or `packages/e2e/src` calls `set`. knip cannot see interface members.
- **Why it matters:** Every store and fake must implement and test a method nothing uses, and two ways to save a secret invite a half-saved login.
- **Fix:** Remove `set` from the interface and both stores; switch the tests to `setMany`.
- **Effort:** S
- **Confidence:** high

#### DEAD-03 · Low · `putMeta`'s "another first save won the race" branch can no longer run

- [ ] **Where:** `packages/server/src/db/bundle-repository.ts:101-108` (the user row is locked first) and `:121-134` (`onConflictDoNothing`, then a second lock and "Saved setup vanished")
- **Problem:** Since T47, every save locks the user row (`for update`) before it reads the setup. Two first saves of the same setup therefore run one after the other. The second one's `lockCurrent()` is a new statement under READ COMMITTED, so it already sees the row the first one committed. It takes the "current exists" path and never reaches the insert. `onConflictDoNothing`, the second `lockCurrent()` and its error are left over from before the user lock. The comment "Another first save won the race" describes something that cannot happen now. No test reaches it, because PGlite has one connection.
- **Why it matters:** Readers trust the wrong guard. Someone may "simplify" the user lock away because the insert looks race-safe, or keep code that cannot be tested.
- **Fix:** Either remove the `onConflictDoNothing` branch and state in one comment that the user lock serializes all saves of an account, or keep it as a safety net and reword the comment: "Unreachable while saves lock the user row; kept so a missing lock fails safe."
- **Effort:** S
- **Confidence:** medium (worked out from Postgres READ COMMITTED locking, not reproduced, since PGlite cannot run two transactions at once)

#### DEAD-04 · Low · Core re-exports `GLOBAL_SCOPE_KEY`, and only core's own test uses that path

- [ ] **Where:** `packages/core/src/project-names.ts:13-14` (`export { GLOBAL_SCOPE_KEY };`); users: `packages/core/test/project-names.test.ts:8,78-79` only. Production imports it from contracts: `packages/cli/src/pull/saved-setups.ts:3,95`, `packages/server/src/bundles/bundle-service.ts:1,129`.
- **Problem:** one constant has two public import paths. knip does not flag it because the test counts as a user.
- **Why it matters:** the same kind of leftover review 4 cleaned up (T65 rule: a name only used in its own package is not exported); a reader sees two sources of truth for a value that is part of the stored format.
- **Fix:** drop the re-export and its comment; import `GLOBAL_SCOPE_KEY` from `@agentnomad/contracts` in the core test.
- **Effort:** S
- **Confidence:** high (`grep -rn GLOBAL_SCOPE_KEY packages/*/src packages/*/test`)

### Duplication

#### DUP-01 · Low · Path rules and "inside a folder" checks are written many times, with different case rules

- [ ] **Where:**
  - `platform === 'win32' ? win32 : posix` is repeated in `auto-memory.ts:34`, `hook-scripts.ts:42` and `:91`, `managed-settings.ts:82`, `plugin-sync.ts:72`, `plugins.ts:163` and `:192`, `programs.ts:73`, `unknown-files.ts:40` and `:79`, and `file-gathering.ts:88`. The shared helper `pathsOf` already exists at `shared/detector-system.ts:40-41`.
  - `createFileGatherer` is built only to get its `path` at `restorer.ts:135-136`, `global-collector.ts:50` and `project-collector.ts:38`.
  - `readSyncedSkills` takes a whole `FileGatherer` but uses only `.path` (`account-skills.ts:53-58`).
  - Two helpers are both named `under`: case-insensitive at `hook-scripts.ts:28-31`, case-sensitive at `restore-rules.ts:53` (with `underAnyCase` at `:55`).
  - `isNeverSynced` is written twice: `global-collector.ts:45` and `project-collector.ts:30`.
- **Problem and why it matters:** One rule lives in about a dozen places, and the same name means two different case rules. The next Windows or macOS case fix has to find every copy.
- **Fix:**
  - Use `pathsOf(platform)` from `agents/shared` everywhere.
  - Have `readSyncedSkills` take a `PlatformPath`.
  - Add one `underFolder(path, folder, { ignoreCase })` helper in `agents/shared/` and use it in both files.
- **Effort:** S
- **Confidence:** high

#### DUP-02 · Low · `detector.ts` still parses JSON by hand

- [ ] **Where:** `packages/cli/src/agents/claude-code/detector.ts:60-64`
- **Problem:** It runs `try { Schema.safeParse(JSON.parse(text)) } catch`, which is exactly `parseJsonWith` from `system/json.ts` (T69 DUP-04). Every other reader in this folder uses that helper. The two exceptions keep the raw parse on purpose to wrap the cause in `ClaudeJsonError`: `claude-json-merge.ts:101-103` and `:122-124`, and `global-collector.ts:118-124`.
- **Fix:** `valueOrNull(parseJsonWith(PackageVersionSchema, manifest))`.
- **Effort:** S
- **Confidence:** high

#### DUP-03 · Low · The shared-fakes fix (review 4 DUP-01) missed a few hand-made fakes, and one behaves differently

- [ ] **Where:**
  - `packages/cli/test/claude-code-plugins.test.ts:281-291`: own `confirm` prompter (`answers.shift() ?? false`) and own reporter
  - `packages/cli/test/agent-registry.test.ts:57-61`: own reporter
  - `packages/cli/test/auth-commands.test.ts:130-135`: four `bundles` methods that reject `not used`, which is what `fakeApi` in `fakes.ts:17-31` does
  - `packages/cli/test/auth-commands.test.ts:927-933`: a KDF params literal that repeats `DEFAULT_KDF_PARAMS` with the fast values already in `fastCrypto` (`:52-60`)
  - `packages/cli/test/auth-commands.test.ts:987`: the literal `'Wrong password'` although `WRONG_PASSWORD_MESSAGE` is imported at `:6` and used at `:124`
- **Problem:** CONTRIBUTING ("Tests") says to use `fakes.ts` instead of a new copy. The plugins prompter is the copy with a real cost: when it runs out of answers it silently answers `false`, while the shared `scriptedPrompter` throws `No answer scripted`. Review 4 named exactly this drift ("returns `undefined` when it runs out" in setup-commands).
- **Why it matters:** in `claude-code-plugins.test.ts`, a new or extra question from `askPluginSync` gets a quiet "no" and the test may still pass (for example `skips what is already here`, `:353-362`, runs with the default `[true, true]`). The literal at `:987` means the account-delete test and the auth server fake can drift from the contract string the CLI compares against (`auth-commands.ts:344`).
- **Fix:** in `run()` use `scriptedPrompter(options.answers ?? [true, true]).prompter` and `recordingReporter({ levels: false })`, reading `asked`/`lines` from them; in `agent-registry.test.ts` use `recordingReporter({ levels: false })`; build the auth fake server's `api` with `fakeApi({ auth: { ... } })`; use `{ ...DEFAULT_KDF_PARAMS, memoryKiB: 19_456, passes: 2 }` (or one shared `FAST_KDF_PARAMS` const) in both places; use `WRONG_PASSWORD_MESSAGE` at `:987`.
- **Effort:** S
- **Confidence:** high

#### DUP-04 · Low · `claude-code-modules.test.ts` keeps a block the ARCH-04 fix made redundant, and its name no longer fits

- [ ] **Where:** `packages/cli/test/claude-code-modules.test.ts:13-28`
- **Problem:** after ARCH-04 the module boundary is enforced by ESLint (`eslint.config.js:88-94`), and the regex checks were removed. What is left under the title "settings parsing is its own module" only calls `commandsInSettings` and `programOf`, which are tested in full in `claude-code-global-collector.test.ts:305-325` and `:438-451` and `claude-code-command-review.test.ts:413-422`. The rest of the file (`:30-108`) tests only `createClaudeJsonMerge`.
- **Why it matters:** the title says a boundary is tested here when it is not; someone looking for the merge tests will not guess "modules".
- **Fix:** delete `:13-28` and rename the file to `claude-code-claude-json-merge.test.ts`.
- **Effort:** S
- **Confidence:** high

#### DUP-05 · Low · Small file helpers are copied across test files although `fakes.ts` is the shared place

- [ ] **Where:** `CollectedFile` builders: `packages/cli/test/claude-code-restorer.test.ts:64-68` (`file`), `push-command.test.ts:64-68` (`text`, identical), `env.test.ts:50-54` (`file`, JSON variant); `put`/`read`: `claude-code-restorer.test.ts:58-62` and `pull-command.test.ts:63-67` (identical). Same builders in other batches: `claude-code-adapter.test.ts:35`, `claude-code-command-review.test.ts:13`, `claude-code-after-restore.test.ts:43`, `claude-code-account-skills.test.ts:181`, `claude-code-modules.test.ts:31`.
- **Problem:** CONTRIBUTING.md ("Tests") says shared fakes live in `packages/cli/test/fakes.ts`; DUP-01 moved the big fakes there, but these one-liners exist in 8 files under 4 names (`file`, `text`, `json`, `saved`).
- **Why it matters:** When `CollectedFile` gains a field, every copy changes; the different names for the same builder make tests harder to scan.
- **Fix:** Add `collected(path, content: string | Uint8Array, executable = false)` and `collectedJson(path, value)` plus `writeTestFile(path, content)` to `fakes.ts` (or a sibling `test-files.ts`), and use them everywhere.
- **Effort:** S
- **Confidence:** high

#### DUP-06 · Low · The storage-limit rule is written twice, in the service and in the repository

- [ ] **Where:** `packages/server/src/bundles/bundle-service.ts:157-167` (early check); `packages/server/src/db/bundle-repository.ts:110-119` (check inside the transaction)
- **Problem:** The same business rule is written in two different forms. The service refuses with `!current && used.setups >= maxSetups` and `growth > 0 && used.bytes + growth > maxBytes`. The repository refuses with `used.setups + (current ? 0 : 1) > maxSetups` and `bytes > maxBytes && write.sizeBytes > current.sizeBytes`. They agree today. The repository (data layer) also imports `USER_STORAGE_LIMITS` and decides a business limit.
- **Why it matters:** If the rule changes (a new limit, or a plan with higher limits), both copies must change the same way. If only one changes, the early check and the locked check disagree. A save then either stores 5 MB before being refused, or passes the early check and fails inside the transaction.
- **Fix:** One pure function, for example `storageLimitPassed(used, currentSize: number | null, newSize): StorageLimit | null`, next to `overLimit` in `bundle-service.ts` (or in `repositories.ts`). Both places call it: the repository with numbers it read under the locks, the service with numbers it read early. Unit-test the function once.
- **Effort:** S
- **Confidence:** high

#### DUP-07 · Low · The server does base64url and SHA-256 two ways each

- [ ] **Where:** base64url: `packages/server/src/encoding.ts:4-6` (`toBase64Url` by string replacement, used for session tokens) and `packages/server/src/db/bundle-cursor.ts:50` and `:57` (`Buffer` `'base64url'`); SHA-256: `packages/server/src/auth/session-tokens.ts:17-19` (`subtle.digest`, then hex) and `packages/server/src/bundles/bundle-service.ts:100-102` (a local `sha256`, bytes)
- **Problem:** The server has its own `encoding.ts` for "server-only text conversions", but the cursor encoder uses Node's `Buffer` instead. The digest call is also written in two files.
- **Why it matters:** Small. It is against the project's "one implementation per job" rule (T62), and the next file to need either one has two to choose from.
- **Fix:** Add `fromBase64Url` and `sha256(bytes)` to `src/encoding.ts`. `bundle-cursor.ts` then uses `toBase64Url(utf8(json))` and `fromBase64Url`, and both digest callers use `sha256`. Keep the cursor's decode errors as `InvalidCursorError`.
- **Effort:** S
- **Confidence:** high

#### DUP-08 · Low · Server test helpers are still copied across test files

- [ ] **Where:**
  - SHA-256 of a body: `packages/server/test/bundle-routes.test.ts:16`, `packages/server/test/bundle-service.test.ts:16`, inline at `packages/server/test/account-routes.test.ts:41` and `packages/server/test/support/fixtures.ts:95`
  - Read the error code from a response: `account-routes.test.ts:72-74`, `auth-routes.test.ts:32-34`, `bundle-routes.test.ts:67-69`
  - Scope key from an index (`index.toString(16).padStart(64, '0')`): `fixtures.ts:93`, `bundle-routes.test.ts:233` and `:297`, `repositories.test.ts:353`, `:382` and `:429`
  - Login and account-delete requests: `account-routes.test.ts:25-30` and `:48-57`, `limits-and-logs.test.ts:28-33`, `:108-112` and `:125-130`
- **Problem:** The review 4 DUP-06 fix moved `b64`, `bytes`, users and registration into `test/support/fixtures.ts`. These four helpers were not on that list, and each is still written several times.
- **Why it matters:** A change to the error body, the scope-key format or the login body means editing every copy.
- **Fix:** Add `sha256Hex`, `errorCode(res)`, `scopeKeyOf(index)`, `loginRequest(app, …)` and `deleteAccountRequest(app, token, authKey)` to `test/support/fixtures.ts`, and use them in every file listed.
- **Effort:** S
- **Confidence:** high

#### DUP-09 · Low · `sodium-crypto.ts` still keeps its own copies of the shared byte sizes (review 1 DUP-01 named this line)

- [ ] **Where:** `packages/core/src/sodium-crypto.ts:6-7` (`KEY_BYTES = 32`, `SALT_BYTES = 16`); the shared ones: `packages/contracts/src/api/common.ts:4-7` (`KDF_SALT_BYTES`, `AUTH_KEY_BYTES`, `WRAPPED_DATA_KEY_BYTES`), `packages/core/src/envelopes.ts:6` (`DATA_KEY_BYTES`).
- **Problem:** `docs/reviews/review-2026-10-03.md:238` lists "`KDF_SALT_BYTES = 16`: … `core/src/sodium-crypto.ts:7` (already exported by contracts)" under DUP-01, ticked as fixed. The CLI copy was removed (`auth-commands.ts` now imports it); the core copy is still there. `KEY_BYTES` likewise stands for both `AUTH_KEY_BYTES` (derived keys) and `DATA_KEY_BYTES` (AEAD key), and `WRAPPED_DATA_KEY_BYTES = 72` depends on `NONCE_BYTES + 32 + TAG_BYTES` here without code tying them (only `crypto.test.ts:173` checks it).
- **Why it matters:** small: if the salt length in the contract changed, the CLI would generate the new size and core would refuse it with a `RangeError` at login. The finding is mainly that a ticked fix is incomplete.
- **Fix:** `import { AUTH_KEY_BYTES, KDF_SALT_BYTES } from '@agentnomad/contracts'` in `sodium-crypto.ts`, use `KDF_SALT_BYTES` for the salt check and `AUTH_KEY_BYTES` for the derived keys (keep the AEAD key check on `DATA_KEY_BYTES` from `envelopes.ts`).
- **Effort:** S
- **Confidence:** high

### Readability

#### READ-01 · Low · The CLI still writes the 5 MB limit as a literal next to `MAX_BUNDLE_BYTES` (READ-07 fixed the server only)

- [ ] **Where:** `packages/cli/src/api/http-api-client.ts:337-338`; `packages/cli/src/push/push-command.ts:441` (constant) with `:480` and `:485` (literal "5 MB")
- **Problem:** Review 4's READ-07 built the server's message from the constant; the CLI's guard and push's two messages still hard-code "5 MB" right next to the constant they describe.
- **Why it matters:** If the limit changes, these messages lie, the same risk READ-07 fixed on the server.
- **Fix:** Use `formatSize(MAX_BUNDLE_BYTES)` (gives "5.0 MB") or one shared `MAX_BUNDLE_LABEL` built from the constant in `contracts`.
- **Effort:** S
- **Confidence:** high

#### READ-02 · Low · The username placeholder depends on the question's wording

- [ ] **Where:** `packages/cli/src/auth/auth-commands.ts:78-86`
- **Problem:** `usernameFrom` adds the placeholder only when `question === 'Choose a username'`, so behaviour is keyed on a display string.
- **Why it matters:** Rewording the register question silently drops the hint, and a reader has to spot the string match to know why only register shows it.
- **Fix:** Pass the placeholder (or a `forNewAccount` flag) as a parameter from `register`.
- **Effort:** S
- **Confidence:** high

#### READ-03 · Low · `index.ts` re-exports every module except `system/json.ts`

- [ ] **Where:** `packages/cli/src/index.ts:1-74` (no `./system/json.ts`; every other `src` file but `bin.ts` is listed); `packages/cli/test/json.test.ts:4` imports the deep path instead
- **Problem:** The index is documented as "Re-exports the package for tests" (`docs/ARCHITECTURE.md:634`), and tests import from it, but the module T69 added was not added there.
- **Why it matters:** Small inconsistency: the next reader cannot tell whether `system/json.ts` is meant to be internal.
- **Fix:** Add `export * from './system/json.ts';` and import it from the index in `json.test.ts`, or note why it is left out.
- **Effort:** S
- **Confidence:** high

#### READ-04 · Low · Some tests still sit away from the code they cover (rest of review 4 READ-03/READ-05)

- [ ] **Where:**
  - `packages/cli/test/agent-registry.test.ts:77-138`: `describe('Claude Code adapter')` (id, detect/collect/restore, `CLAUDE_CONFIG_DIR`), while `packages/cli/test/claude-code-adapter.test.ts:19` says "The Claude Code adapter's own steps" live there
  - `packages/cli/test/bin.test.ts:207-212`: `unwrapAnswer` from `src/ui/clack-prompter.ts` inside the executable test, which is otherwise all child-process runs
  - `packages/cli/test/claude-code-command-review.test.ts:350-361`: `printable` from `src/ui/printable.ts`; `printableLine` (T71) has no unit test of its own, only the pull-level case at `pull-command.test.ts:229`
- **Problem:** T74 moved the plan-step tests into `claude-code-adapter.test.ts` but left the other adapter tests in the registry file; the two `ui/` helpers are tested in unrelated files.
- **Why it matters:** someone changing `claude-code-adapter.ts`, `clack-prompter.ts` or `printable.ts` will not find these tests by file name, and a change to `printableLine` (the SEC-03 fix) is only caught through a full pull.
- **Fix:** move `agent-registry.test.ts:77-138` into `claude-code-adapter.test.ts`; move the clack case and the two `printable` cases into a `ui.test.ts` (or `printable.test.ts`), and add direct `printableLine` cases there (`'a\nb\tc'` → `'a\\u{000a}b\\u{0009}c'`).
- **Effort:** S
- **Confidence:** high
- **Also found by a second reviewer:** `packages/cli/test/claude-code-restorer.test.ts:960-983`; function in `packages/core/src/path-resolver.ts:33`, re-exported by `packages/cli/src/agents/claude-code/restore-rules.ts:37`

#### READ-05 · Low · `manifest` names three different things in the plugins test, and one schema rule is tested twice

- [ ] **Where:** `packages/cli/test/claude-code-plugins.test.ts:207-209` (helper function `manifest(add)`), `:230` (module constant `manifest: PluginManifest`), `:416` (local `const manifest` from `readPluginManifest`); refusal cases at `:167-178` (helper `bad`) and `:206-228` (helper `manifest`)
- **Problem:** inside `describe('marketplace sources ...')` the name `manifest` is a function returning a boolean; elsewhere it is the shared fixture or a read result. The two helpers `bad` and `manifest` run the same `PluginManifestSchema.safeParse({ marketplaces: [{ name: 'm', add }], ... })`, and `'--scope'`/`'--help'` and the shell-character cases are spread over both.
- **Why it matters:** a reader of `run()` (`:278`) has to check which `manifest` is in scope; a new marketplace rule tends to get a third helper.
- **Fix:** one helper `addAccepted(add: string)` and one accept list / one refuse list; rename the fixture `savedManifest` and the local at `:416` `saved`.
- **Effort:** S
- **Confidence:** high

#### READ-06 · Low · Small leftovers that make two tests harder to read

- [ ] **Where:** `packages/cli/test/claude-code-adapter.test.ts:41-44` (`answer(choice)` returns `{ resolve }`, used only as `answer('merge').resolve`), `:85` (`lines` returned, never read), `:121-127` (an async IIFE inside `expect`); `packages/cli/test/agent-boundary.test.ts:235-246` (`pushed()` returns `seen`, no caller uses it)
- **Problem:** indirections and unused returns with no purpose.
- **Why it matters:** low; each one makes the reader look for a use that is not there.
- **Fix:** `const answer = (choice: ConflictChoice) => () => Promise.resolve(choice)`; drop `lines` and the unused `seen`; write the first case of `:119-132` as two plain lines (`const t = planStep([true], []); await t.plan(); expect(t.asked).toEqual([])`).
- **Effort:** S
- **Confidence:** high

#### READ-07 · Low · A comment about slow real programs now sits above the pure icacls parser tests

- [ ] **Where:** `packages/cli/test/system.test.ts:184`
- **Problem:** "Real programs start slowly while the whole suite runs in parallel." explained the `{ timeout: 30_000 }` on the real-programs block. T74 (882f075) inserted the new `icacls output, parsed` block between the comment and that block, so the comment now describes tests that start no program.
- **Why it matters:** A reader takes the parser tests for slow real-program tests, and the reason for the 30 s timeout at `:218` loses its comment.
- **Fix:** Move the comment to just above `describe('the real programs (run on this OS)', …)` at line 218.
- **Effort:** S
- **Confidence:** high

#### READ-08 · Low · The global setup's key is written three ways in the pull tests

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:448-449`, `:463` (`scopeKeyFor(crypto, dataKey, { kind: 'global' })`); `:487`, `:500`, `:517`, `:526` (`'global'`); `:647`, `:652`, `:661`, `:669` (`'claude-code/global'`)
- **Problem:** `scopeKeyFor` returns the constant `GLOBAL_SCOPE_KEY` for the global scope (`packages/core/src/project-names.ts:49-51`), so all three spellings mean the same thing, but nothing in the file says so. The `stored` map key format (`agent/scopeKey`) is a detail of `fakeBundleServer` (`fakes.ts:139`).
- **Why it matters:** A reader of `:463` assumes the global key is derived from the data key and that `:487` sets a different entry. Tests that reach into `server.stored` by a literal break if the fake's key format changes.
- **Fix:** One constant at the top (`const GLOBAL = scopeKeyFor(crypto, dataKey, { kind: 'global' })` or the exported `GLOBAL_SCOPE_KEY`), and a `revisionOn(server, scopeKey)` helper in `fakes.ts` instead of `server.stored.get('claude-code/global')`.
- **Effort:** S
- **Confidence:** high

#### READ-09 · Low · The restorer test helper returns a one-field wrapper, and one test builds the restorer by hand anyway

- [ ] **Where:** `packages/cli/test/claude-code-restorer.test.ts:77-90` (returns `{ restorer }`; every caller writes `restorer().restorer.restore(…)` or destructures `{ restorer: r }`), `:591-608` (calls `createClaudeCodeRestorer` with the same options the helper sets, although `Setup.isClaudeRunning` at `:74` exists for this case)
- **Problem:** The wrapper object carries nothing else, so about 40 call sites read `restorer().restorer`. The test at `:591` repeats the seven options of the helper to pass its own `isClaudeRunning`.
- **Why it matters:** Small, but it is the most-read helper in the largest test file; when a restorer option is added, two places must change.
- **Fix:** Return the restorer itself from `restorer(setup)`, and write `:593-608` as `restorer({ isClaudeRunning: async () => { … } })`.
- **Effort:** S
- **Confidence:** high

#### READ-10 · Low · Stale comments and a vague name in the server source

- [ ] **Where:**
  - `packages/server/src/rate-limit/rate-limiter.ts:43-47`: the comment on `failedLoginsPerAccount` says "Failed logins or account deletes per account", but account deletes have had their own rule (`failedDeletesPerAccount`, lines 48-52) since T47.
  - `packages/server/src/server.ts:24-25`: "Share of rate-limit hits that also prune expired counters". The same prune also deletes every user's expired sessions (`api.ts:42-43`).
  - `packages/server/src/auth/auth-service.ts:81` and `:147-148`: `const FAILED = RATE_LIMITS.failedLoginsPerAccount` is used once, and "FAILED" no longer says which of the two failure rules it is.
  - `packages/server/src/db/bundle-repository.ts:12`: the `@agentnomad/contracts` import sits between two relative imports. Every other file puts package imports first.
- **Problem:** Small leftovers from the T47 and DB-02 changes.
- **Why it matters:** A reader of `rate-limiter.ts` would think a delete guess uses up the login limit (the opposite of the T47 fix). A reader of `server.ts` would not know that sessions are pruned there.
- **Fix:** Reword the two comments ("Failed logins per account …"; "… prune expired counters and sessions"). Use `RATE_LIMITS.failedLoginsPerAccount` inline and drop `FAILED`. Move the import up with the other package imports.
- **Effort:** S
- **Confidence:** high

#### READ-11 · Low · A test names a column for the opposite of what it checks

- [ ] **Where:** `packages/server/test/auth-routes.test.ts:270-273`
- **Problem:** `select last_used_at > now() - interval '1 minute' as idle` is true when the session was just used, then `expect(rows[0]?.idle).toBe(true)`. The test is right, but `idle` means the opposite.
- **Why it matters:** The next reader thinks the test asserts the session is idle.
- **Fix:** Rename the alias to `recently_used` (and the type field).
- **Effort:** S
- **Confidence:** high

#### READ-12 · Low · Docs and config comments that did not follow the latest changes

- [ ] **Where:** (each line also says what is wrong)
  - `docs/ARCHITECTURE.md:592-806` (Part 2, "what every file does"): three source files have no row: `packages/cli/src/env/loader-variables.ts`, `packages/cli/src/ui/printable.ts` (named by T71's SEC-03 text at `:409-411` but not in the `ui/` table `:652-657`), `packages/e2e/src/push-env-value.ts` (only in the `knip.json` row `:818`, not in the e2e table `:800-805`). Checked by matching every `packages/*/src/**/*.ts` basename against the document.
  - `docs/ADDING-AN-AGENT.md:325`: the checklist says "`push/`, `pull/` and `cli/` must not import your folder"; since T73 `env/` is in the rule too (`eslint.config.js:63`, ARCHITECTURE:331), and `commands/` should be (ARCH-04).
  - `docs/ARCHITECTURE.md:565-566` ("The release starts only for a commit whose CI run on `main` passed") and `.github/workflows/release.yml:20-21` ("must have passed CI on main first"): the gate at `release.yml:33` counts any successful `ci.yml` run for the SHA, whatever branch triggered it (worker-t72 noted the same). The "on main" part is enforced separately (`:70`, tag commit must be an ancestor of `origin/main`). Harmless (same SHA = same code), but the text describes a stricter check than the code does.
  - `pnpm-workspace.yaml:3-4`: "esbuild (used by drizzle-kit) ships its binary as an optional dependency" — esbuild is also a direct dev dependency of the CLI and builds the npm package (`packages/cli/package.json:35`, `scripts/build-release.ts:16`). The `allowBuilds: esbuild: false` decision still holds for that use; the comment just names only one user.
- **Why it matters:** ARCHITECTURE Part 2 promises every file; ADDING-AN-AGENT is what a contributor follows for the boundary; the release text is what the owner relies on when tagging.
- **Fix:** add the three rows; say "`push/`, `pull/`, `cli/`, `env/` and `commands/`"; reword to "a successful CI run for the tagged commit (on any branch); the commit must also be on `main`"; add "and the CLI's release build" to the esbuild comment.
- **Effort:** S
- **Confidence:** high

#### READ-13 · Low · The threat model was not updated for review 4's security fixes (T69, T71)

- [ ] **Where:** `docs/security/threat-model.md:3` ("updated through T66"), threat 13 at `:48`, the findings tables `:63-118`.
- **Problem:** review 4 fixed three security findings in the pull review: SEC-01 (one malformed hook or MCP server hid every other one; now each is read separately and an unreadable one is shown), SEC-02 (fence closing rule for ` ```! ` blocks) and SEC-03 (review lines printed with real line breaks; now `printableLine`). ARCHITECTURE §7 (`:398-401`, `:409-411`) describes all three. The threat model does not: threat 13's row still describes the review without "unreadable entries are shown, never skipped" or the line-break escaping, and unlike every earlier review (findings 9-40, each with its fix) these three are not recorded. A `grep` for `unreadable`, `printableLine`, `T69` or `T71` in the file finds nothing.
- **Why it matters:** the threat model is the document SECURITY.md sends readers to for "every defence, how it is tested"; it now understates what the pull review guarantees and drops the history of three security fixes.
- **Fix:** add rows 41-43 (review of 2026-10-03, review 4) with the T69/T71 fixes; extend threat 13's "How it is handled" with "a hook or MCP server that cannot be read is shown as unreadable, never left out; review lines show line breaks escaped"; change the header to "updated through T74".
- **Effort:** S
- **Confidence:** high

#### READ-14 · Low · An unfilled template placeholder in the committed review 4 report

- [ ] **Where:** `docs/reviews/review-2026-10-03-4/report.md:5` — "**Coverage:** 243 of {{FILES}} files read in full, 33,614 lines."
- **Problem:** the assembly template's `{{FILES}}` was never replaced. `files.md:3` in the same folder says 243 files.
- **Why it matters:** cosmetic, but it is the committed record of the review, and it makes the coverage line unreadable. The assemble script for review 5 should fill (or assert) every placeholder.
- **Fix:** "243 of 243 files read in full"; in the assemble script, fail when `{{` remains in the output.
- **Effort:** S
- **Confidence:** high

#### READ-15 · Low · README's "what the server stores" list is still the short one (review 4 READ-11 fixed only SECURITY.md and the threat model)

- [ ] **Where:** `README.md:185-187`; compare `SECURITY.md:57-59` and `docs/security/threat-model.md:122-125`.
- **Problem:** README says "The server stores only ciphertext, a keyed hash of each project name, your username and the device name of each login." READ-11 (review 4) added "the agentnomad version of each request, and your IP address (kept only as a keyed pseudonym for rate limits)" to SECURITY.md and the threat model; README, the page most users read, was not changed. (The CLI version is logged rather than stored, but the IP pseudonym is stored in `rate_limits`.)
- **Why it matters:** the privacy promise differs between the README and SECURITY.md; "only" makes the README one strictly wrong.
- **Fix:** "The server stores ciphertext, a keyed hash of each project name, your username, the device name of each login, and a keyed pseudonym of your IP address for rate limits (see SECURITY.md)."
- **Effort:** S
- **Confidence:** high

### Best practices

#### BP-01 · Low · The CLI package's own `test` script runs Vitest without the root config

- [ ] **Where:** `packages/cli/package.json:20` (`"test": "vitest run"`); the root config that sets the `agentnomad-source` condition is `vitest.config.ts:9`
- **Problem:** Run from `packages/cli` (`pnpm --filter @agentnomad/cli test`), Vitest does not load the root `vitest.config.ts`, so `@agentnomad/core` and `contracts` resolve to their built `dist/`. Without a build that fails to resolve (worker-t73 recorded "core entry fails to resolve there"); after an old build it tests stale code, which is what the root config's comment says it prevents.
- **Why it matters:** A contributor running the package script gets a confusing failure or a wrong pass. CONTRIBUTING.md only documents the root `pnpm test`, so this script is a trap rather than a tool.
- **Fix:** Point it at the root project (`vitest run --root ../.. --project @agentnomad/cli`) or drop the script (the same pattern is in contracts, core and server; see cross-file notes).
- **Effort:** S
- **Confidence:** medium (based on Vitest's config lookup and worker-t73's note; not re-run here to keep the checkout untouched).

### System design

#### ARCH-01 · Low · The reserved bundle folder `.agentnomad` is defined twice: by the generic layer and by the Claude Code adapter

- [ ] **Where:** `packages/cli/src/env/env-section.ts:11` (`'.agentnomad/env.json'` literal) and `packages/cli/src/agents/claude-code/global-paths.ts:48` (`RESERVED_DIR`). `restore-rules.ts:91` and `:124` import the env path to recognise it.
- **Problem:** Reserved entries are part of the bundle format for every agent (docs/ARCHITECTURE.md §4, "Reserved entries"), but the folder name is an adapter constant. A second adapter would define it a third time.
- **Fix:** Move `RESERVED_DIR` to the bundle format (`contracts`) or to `agents/shared`, and build `ENV_BUNDLE_PATH` and the Claude paths from it.
- **Effort:** S
- **Confidence:** high

#### ARCH-02 · Low · Optional-part flags are hard-coded to Claude Code's `account-skills`

- [ ] **Where:** `packages/cli/src/cli/program.ts:36-41` (`partsOf` maps only `accountSkills` to the literal `'account-skills'`), `:150-156`, `:188-194`; `packages/cli/src/cli/run.ts:194-195` (hints); the id itself is `ACCOUNT_SKILLS_PART` in `packages/cli/src/agents/claude-code/account-skills.ts:20`
- **Problem:** `docs/ARCHITECTURE.md:322` says an adapter's `optionalParts` are answered by `--<id>` / `--no-<id>`, and push and pull read them generically through `options.parts`. But the parser only knows one part, written as a literal copy of the Claude Code constant (the `cli/` lint rule forbids importing it), and `docs/ADDING-AN-AGENT.md:231-232` does not tell a new adapter to add its flags there.
- **Why it matters:** A second agent with an optional part gets no flag, so from a script its part can never be included (`--yes` answers no); the "a new agent is a new folder plus one line in `app.ts`" promise breaks, and renaming the Claude Code part id silently disconnects `--account-skills`.
- **Fix:** Either build the part flags from data the composition root passes to `createProgram` (part ids and help texts from the registered adapters), or state in ADDING-AN-AGENT.md that a new part needs its flags in `program.ts` and `run.ts`, and add a test that every registered part id has a flag.
- **Effort:** M (generic flags) / S (document and test)
- **Confidence:** high

#### ARCH-03 · Low · The generic env code still names Claude Code (ARCH-01 fix incomplete)

- [ ] **Where:** `packages/cli/src/env/env-restore.ts:140` ("Open a new terminal (and restart Claude Code) so they take effect."), `packages/cli/src/env/env-references.ts:103` (`REFERENCE` comment: "as Claude Code expands them")
- **Problem:** Review 4's ARCH-01 moved the Claude Code file lists into the adapter, but the agent-neutral restore message tells every user to restart Claude Code, whichever agent the values were saved for, and the reference syntax is documented as Claude Code's. god noted both as leftovers after T73; they are still there at `b49a335`.
- **Why it matters:** With a second agent, pull tells its users to restart the wrong program; the comment hides that the `${VAR}` syntax is an assumption every adapter must share.
- **Fix:** Name the agent from the planned restore (`planned.adapter.displayName`, passed to `writeEnvValues`), or say "restart your agent"; reword the comment as "the `${VAR}` / `${VAR:-default}` form the adapters' files use", or move the pattern into `EnvReferenceFiles` if agents may differ.
- **Effort:** S
- **Confidence:** high

#### ARCH-04 · Low · The agent-boundary lint rule does not cover `commands/` (`list`, `status`, `delete`)

- [ ] **Where:** `eslint.config.js:63` (`files: ['packages/cli/src/{push,pull,cli,env}/**/*.ts']`); the uncovered module `packages/cli/src/commands/setup-commands.ts`; the docs that describe the rule: `docs/ARCHITECTURE.md:328-333`, `docs/ADDING-AN-AGENT.md:325` and `:335`.
- **Problem:** ARCHITECTURE §6 says "Push, pull, `list`, `status`, `delete` and `agents` only use the registry and these interfaces", and the guide's "What you do not touch" table lists `list`, `status`, `delete` for the same reason. But `list`, `status` and `delete` live in `commands/setup-commands.ts`, and the `no-restricted-imports` block only names `push`, `pull`, `cli` and `env`. Today the file imports only `../agents/adapter.ts` (checked), so nothing is broken; nothing stops the next change from importing `../agents/claude-code/…` there. ARCH-01 of review 4 (T73) added `env/` to this list; `commands/` was missed.
- **Why it matters:** the boundary is what keeps "a new agent is a new folder plus one line" true; three of the six generic commands are outside it.
- **Fix:** `files: ['packages/cli/src/{push,pull,cli,env,commands}/**/*.ts']`; in ARCHITECTURE:331 and ADDING-AN-AGENT:325 name `commands/` (and `env/`, see READ-12).
- **Effort:** S
- **Confidence:** high

### QA and testing

#### QA-01 · Low · Two pull-review rules have no test

- [ ] **Where:** rules at `packages/cli/src/agents/claude-code/command-review.ts:161-167` (`enableAllProjectMcpServers: true`) and `:180` (an `mcpServers` block that is not an object → `MCP servers (unreadable)`); the tests that should hold them: `packages/cli/test/claude-code-command-review.test.ts:222-292` and `:363-423`.
- **Problem:** `grep -rn enableAllProjectMcpServers packages/cli/test` and `grep -rn "MCP servers (unreadable)" packages/cli/test` both find nothing. Every other loosening setting (`permissions.defaultMode`, `permissions.allow`, `additionalDirectories`, `sandbox`) and the per-server unreadable case (`:397-406`) are tested; these two are not. The second one is part of T69's SEC-01 fix.
- **Why it matters:** `enableAllProjectMcpServers` makes every project MCP server start without asking. If the check were removed or the key renamed, pull would write it without showing it and no test would fail. The same goes for a whole `mcpServers` block that hides a server behind a non-object value.
- **Fix:** in the T55 block add `expect(labels([json('settings.json', { enableAllProjectMcpServers: true })])).toEqual(['new setting enableAllProjectMcpServers'])` and a `false` case that lists nothing; in the SEC-01 block add `reviewRunnable([json('.mcp.json', { mcpServers: ['npx x'] })], [])` → `['MCP servers (unreadable): ["npx x"]']`.
- **Effort:** S
- **Confidence:** high

#### QA-02 · Low · The "never replaces a profile it cannot read" test cannot fail

- [ ] **Where:** `packages/cli/test/env.test.ts:223-231`; code under test `packages/cli/src/env/shell-profile.ts:134-157`, `packages/cli/src/system/files.ts:57-62`
- **Problem:** The test makes the profile path a folder and expects `write` to reject with a bare `rejects.toThrow()`. If the guard at `shell-profile.ts:143-145` were removed (any read error treated as "missing"), `write` would go on to `writeFileAtomically`, whose `rename(temp, target)` onto a folder also fails (EISDIR on Linux and macOS, EPERM on Windows). The test passes either way.
- **Why it matters:** T46's rule (an unreadable profile is never replaced) has no test that would catch its removal. A profile the user cannot read for another reason (permissions) would be overwritten.
- **Fix:** On POSIX, use a real file with mode `000` (`chmod(profile, 0)`), expect the rejection, then restore the mode and check the content is unchanged. Or assert the read error itself: `rejects.toMatchObject({ code: 'EISDIR' })` plus "no backup file was written".
- **Effort:** S
- **Confidence:** high

#### QA-03 · Low · The shared scripted prompter casts each answer to whatever type was asked

- [ ] **Where:** `packages/cli/test/fakes.ts:91-95` (`next(message) as T`, `as T[]`, `as string`, `as boolean`)
- **Problem:** BP-01 removed the casts from the test files, but the shared fake now casts every scripted answer to the question's type without checking. A script whose answers are out of order (for example `'global'` reaching a `confirm`) returns a string where a boolean is expected; `'global'` is truthy, so the command goes on as if the user said yes.
- **Why it matters:** Push and pull tests depend on the order of questions (`push-command.test.ts:168`, `pull-command.test.ts:476`, and many more). When a question is added or moved, a test can keep passing on the wrong path instead of failing near the cause, which is what BP-01 was meant to prevent.
- **Fix:** Check the type per method and throw a clear error: `confirm` needs a boolean, `select`/`text`/`password` a string, `multiselect` an array of strings, e.g. `if (typeof answer !== 'boolean') throw new Error(\`"${message}" expected yes/no, got ${JSON.stringify(answer)}\`)`. That removes the casts too.
- **Effort:** S
- **Confidence:** high

#### QA-04 · Low · The real `readRegistry` test still asserts only its return type (QA-07 partly done)

- [ ] **Where:** `packages/cli/test/system.test.ts:338-347`
- **Problem:** QA-07's fix added `parseRegSettings` and its unit tests (`managed-settings.test.ts:117-143`), but the Windows test of the real wrapper is unchanged: `expect(value === null || typeof value === 'string').toBe(true)` holds for any value the declared type allows.
- **Why it matters:** The test can only fail by throwing. It reads as coverage of `readRegistry` on Windows while checking nothing about it, which is the exact problem QA-07 described.
- **Fix:** On the CI runner no ClaudeCode policy key exists, so assert `toBeNull()` for both hives (with a comment saying so), or drop the test and rely on the parser tests plus the existing POSIX `null` test.
- **Effort:** S
- **Confidence:** high

#### QA-05 · Low · `contracts.test.ts` runs no CLI code and repeats the contracts package's own tests

- [ ] **Where:** `packages/cli/test/contracts.test.ts:4-22`; same assertions in `packages/contracts/test/api.test.ts:60` (`API_ROUTES.bundle('claude-code', 'global')`) and `:207` (`PutBundleRequestHeadersSchema.parse`)
- **Problem:** The describe is named "CLI uses the shared contracts", but the headers are built by hand inside the test and the route check is identical to the contracts package test. The CLI's real header building is tested in `packages/cli/test/api-client.test.ts:248-255`, which does not parse what it sent with the schema.
- **Why it matters:** If the API client sent a header the server schema rejects, this file would still pass. It looks like a contract test between CLI and server, but it is not one.
- **Fix:** Delete `contracts.test.ts` and, in `api-client.test.ts`, parse the headers the client actually sent with `PutBundleRequestHeadersSchema.parse(headers)`.
- **Effort:** S
- **Confidence:** high

#### QA-06 · Low · The "identical push" half of the retry rule has no test

- [ ] **Where:** `packages/server/src/db/bundle-repository.ts:136-143` (`isRetry` is `current.revision === expectedRevision || current.revision === expectedRevision + 1`); tests: `packages/server/test/repositories.test.ts:300-310`, `packages/server/test/bundle-routes.test.ts:165-172`
- **Problem:** Both tests send the same bytes again with the old expected revision, which is the `+ 1` case. No test sends the same bytes with the current revision, which is the "identical push" the comment names. If the first half of the condition were deleted, an identical push would make a new revision with the same bytes, and every test would still pass. A repo-wide search for "unchanged" and "identical" in the server and e2e tests finds only the `+ 1` test.
- **Why it matters:** The upload idempotency rule is half tested. A change there would add useless revisions and cause revision conflicts on other PCs without any test failing.
- **Fix:** In `repositories.test.ts`, save revision 1, then `putMeta` the same hash with `expectedRevision: 1` and expect `{ outcome: 'unchanged', meta: { revision: 1 } }`, with the current blob unchanged.
- **Effort:** S
- **Confidence:** high

#### QA-07 · Low · The e2e leak check does not look for anything the stale PC uploads

- [ ] **Where:** `packages/e2e/src/steps.ts:437-441` (the stale PC writes `Stale notes.` / `Stale project.` and pushes project `stale-only`); the secret list `:78-101`; the check at `:466`.
- **Problem:** step 3's `expectNothingReadable(server, secretsHere)` searches every request of the step, including the stale PC's successful upload of project `stale-only` (`:446` asserts it was saved). None of that upload's contents is in the list: not `Stale notes`, not `Stale project`, not the project name `stale-only`. The list is fixed to the first PC's setup plus the homes, keys and tokens.
- **Why it matters:** CONTRIBUTING ("Tests") says a change to push or the bundle belongs in the e2e steps "including the check that nothing readable leaves the PC". The stale PC is the only push in step 3 that is not a pull-then-push of known content, and it is also the only upload of a project whose name was never searched for. A regression that leaks project names or contents only on a PC with no local revision (the path that uses `expectedRevision 0` and a new project name) would pass.
- **Fix:** add `'Stale notes'`, `'Stale project'` and `'stale-only'` to the list (or pass step-specific extras into `expectNothingReadable`).
- **Effort:** S
- **Confidence:** high

## Standards to adopt

- **One reading of a command line, used by push, pull and the review:** what runs is a list of words (`command` plus `args` for exec form, shell words otherwise), and a script path is matched inside a word, next to shell punctuation too. `hook-scripts.ts`, `restorer.ts` and `command-review.ts` use the one helper (BUG-01, SEC-01).
- **The review fails toward showing:** inside any open code fence, a command opener is still reported (SEC-02).
- **Every signed-in route that moves bytes has a per-account limit** (SEC-03).
- **Local state records only what really happened:** a revision is saved as partial whenever anything was left undone (BUG-05).
- **A function that promises "false, never a throw" guards its own decoding** (BUG-06); when a shared helper gets stricter, every caller that feeds it stored data is re-checked.
- **Text from a bundle is printed through `printableLine`,** or refused at the schema: paths too, not only review lines (SEC-04).
- **Test helpers live in one place:** `packages/cli/test/fakes.ts` (also `put`, `exists`, the `CollectedFile` builder, `fakeAdapter`) and `packages/server/test/support/` (DUP-03, DUP-05, DUP-08), with no cast in the shared prompter (QA-03).
- **A test sits with the code it covers and can fail** (READ-04, QA-02, QA-04).
- **Limits and sizes come from the constant:** `MAX_BUNDLE_BYTES` in CLI messages (READ-01), the shared byte sizes in `sodium-crypto.ts` (DUP-09), the storage rule in one layer (DUP-06).
- **Agent-specific names stay in the adapter:** optional-part flags (ARCH-02), env wording (ARCH-03), the reserved bundle folder (ARCH-01); the lint boundary covers every generic folder (ARCH-04).
- **Docs change with the code:** the threat model, ARCHITECTURE Part 2 and the README list are updated in the task that changes the behaviour (READ-12, READ-13, READ-15).

## What will break first at scale

1. **Server transfer and database round trips.** Reads are unlimited (SEC-03). Every signed-in request costs a session lookup, every auth request and save a rate-limit write, and a save about eight statements. The orphan sweep filters `bundle_blobs.created_at`, which has no index. Files: `packages/server/src/http/routes/bundles.ts`, `packages/server/src/db/session-repository.ts`, `packages/server/src/rate-limit/postgres-rate-limiter.ts`, `packages/server/src/storage/postgres-blob-store.ts`.
2. **Memory and the 5 MB cap.** The CLI holds every collected file, the bundle JSON, the gzip and the ciphertext per setup; `gunzipLimited` peaks near twice the decompressed size; the server buffers an upload whole. Users with large skill folders hit the 5 MB cap first, and a setup cannot be split. Files: `packages/cli/src/push/push-command.ts`, `packages/cli/src/pull/pull-command.ts`, `packages/core/src/`, `packages/server/src/http/routes/bundles.ts`.
3. **The second agent and a growing team.** The command tokenizer, the `account-skills` flag in `cli/program.ts` and `cli/run.ts` (ARCH-02), the env wording (ARCH-03) and the reserved folder name (ARCH-01) are the generic edits a new adapter needs. For the team: the two longest test files (restorer 1,064 lines, pull 839), CI time (six machines plus six chain jobs), `ARCHITECTURE.md` as the one file every change must update, and local state and the secrets file being rewritten whole with no lock (two commands at once on one PC, documented as accepted).

## Suggested order of work

1. **The pull review's command reading: BUG-01, SEC-01, SEC-02, QA-01, BUG-02, BUG-03, UX-01, UX-02, DUP-01, DUP-02, DEAD-01, ARCH-01.** Same folder (`packages/cli/src/agents`); BUG-01 and SEC-01 are fixed in the one helper.
2. **CLI behaviour: BUG-04, BUG-05, SEC-04, SEC-05, UX-03, UX-04, DEAD-02, READ-01, READ-02, READ-03, BP-01, ARCH-02, ARCH-03.** `packages/cli/src` outside `agents`.
3. **Server: SEC-03, BUG-06, DUP-06, DUP-07, DUP-08, DEAD-03, QA-06, READ-10, READ-11.** No migration needed; `429 rate_limited` already exists, so an installed 1.0.3 CLI understands the new limit.
4. **Contracts, core, e2e, lint and docs: ARCH-04, QA-07, DUP-09, DEAD-04, UX-05, READ-12, READ-13, READ-14, READ-15.**
5. **CLI tests, after 1 and 2 are merged: SEC-06, DUP-03, DUP-04, DUP-05, READ-04 to READ-09, QA-02, QA-03, QA-04, QA-05.**

## Not reviewed

- Skipped by rule, 16 files: `pnpm-lock.yaml`, the 7 drizzle snapshots in `packages/server/drizzle/meta/`, and 8 images (`.a1x6/images`, `docs/images`).
- Git-ignored files (`packages/server/.env`, `node_modules`, build output, `coverage/`) and the untracked `CLAUDE.local.md`.
- Not run: `pnpm test:e2e` locally (CI runs it on every push; the run for `b49a335` passed) and anything against the production database or the hosted API.
- Open questions the reviewers could not settle from the code: whether Claude Code runs a command block that sits inside another fence (SEC-02, impact), how common compound hook commands are (SEC-01), and whether recording the revision on a "not asked" pull was intended (BUG-05). These findings say so in their Confidence line.
- Noted, no finding raised: `auth-commands.ts:344` tells a wrong password from an ended session by comparing the 401 message text with the server's; a reworded server message would log users out. A distinct error code would be sturdier, but a new code is a compatibility decision. The e2e runs inherit `PATH`, so on a developer's PC they find the real `claude --version` (documented).
