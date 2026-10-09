# Code Review — Agent Nomad — 2026-10-09 (review 16)

**Scope:** the same change set as review 15 after its 40 fixes: everything T95 (plugin facts from Claude Code 2.1.295), T96 (plugins and mods in the skills folder) and the review-15 fix commit changed. The diff `30eb20f..018324d` on branch `review-15-report`, 44 files (the 35 of review 15 plus the 9 the fixes reached), read in full.
**Stack:** pnpm monorepo, TypeScript strict, Node 22.13 or newer. Packages: `contracts` (Zod schemas), `core` (encryption, bundle format, merge), `cli` (the `agentnomad` command), `server`, `e2e`. Tests with Vitest.
**Coverage:** 44 of 44 files read in full, 13,331 lines. See `files.md` for one row per file.
**Checks run:** type check pass · lint pass · format check pass · tests pass (1,438 passed, 12 skipped, 82 files) · `pnpm knip` pass · `pnpm audit --prod` pass (no known vulnerabilities) · import cycles none (`madge --circular` over the CLI package) · e2e pass (15 tests, run after the fixes earlier today).

**How it was done:** four reviewers each read one part of the scope line by line (the adapter source; the commands, e2e step and docs; the plugin and fixture tests; the command and collector tests), checked every review-15 fix in their files, and confirmed each finding at exact lines, running the behavioural ones. The orchestrator then re-confirmed every one of the 37 findings the reviewers returned: the eleven behavioural claims were re-run against the built package (`packages/cli/dist`) with probe scripts, the rest were re-read at the quoted lines, and the pre-existing ones were checked against `30eb20f`. Nothing a reviewer reported was dropped as unconfirmed; two were re-filed under another category (a test that cannot fail is a QA finding, not a bug in the code) and one was lowered from Medium to Low to match how review 15 rated the same shape.

## Summary

The 40 review-15 fixes are in place and correct: every one was found at its lines, the behavioural ones (BUG-01, SEC-01, SEC-02, SEC-03, UX-02 of review 15) were re-run, and the tests that pin them fail for the right reason when the fix is undone. This round found no Critical, no High, 2 Medium and 35 Low findings. The two Medium ones are the ones to read: a claude.ai skill saved by push that carries `.claude-plugin/plugin.json` is added by pull as a local skill without its hooks or MCP servers ever being reviewed, because the account-skills path marks Markdown only and the plugin review never sees the renamed folder (SEC-01); and the project-scope pull test written for review 15's QA-05 checks a folder the restorer never writes, so its "the mod was not written" half cannot fail (QA-01).

Two further Low findings are about the new module's own rule that nothing unreadable is dropped: a plugin hooks file without the `hooks` wrapper gives no entry at all (SEC-02), and a plugin's MCP files are never scanned for `${VAR}` references, so push offers to save nothing for them (BUG-01). The rest is small: two messages that say less than the code knows (UX-01, UX-02), one that blames the organization for any failure containing "blocked" (UX-03), a half-finished review-15 fix (DUP-03), a few test shapes the first round did not reach, and twelve pre-existing points in files the fixes touched for the first time (a stat done twice per restored file, docs that place `windowsNameProblem` in the wrong module, a barrel missing one export).

Nothing found blocks merging the review branch into `dev`. SEC-01 is the one finding worth a decision before the next task on account skills (T104).

## Scores

| Area                         | Score /10 | One-line reason                                                                                                                                  |
| ---------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Correctness                  | 9         | Two Low bugs, both at the edge T96 widened: the env scan and the manifest-problem text; every manifest shape still reads right.                  |
| Security                     | 8         | One Medium: a plugin inside a saved claude.ai skill bypasses the T96 review; one Low gap in the "nothing unreadable is dropped" rule.            |
| Performance                  | 9         | Two Low pre-existing points: a second `stat` per restored file and a per-file array copy in the account-skills grouping.                         |
| User experience              | 9         | Three Low wording points: "not JSON" for non-JSON-object files, a missing MCP file echoed as its path, "blocked" read as policy.                 |
| Readability                  | 8         | Code reads well; ten Low points, six of them docs that lag the code or describe a rule with unlisted exceptions.                                 |
| Maintainability              | 8         | Five duplications, one of them a review-15 fix done in one of its two places; three long tests.                                                  |
| Architecture and scalability | 9         | Boundary and pure-module split hold, no cycles; the pure modules reach `node:fs` through one import in `global-paths.ts`.                        |
| Test coverage                | 8         | Every review-15 branch is pinned; one new test cannot fail, one pins nothing for the rule it names, three branches and one message are untested. |

| Category             | Critical | High  | Medium | Low    |
| -------------------- | -------- | ----- | ------ | ------ |
| Bugs                 | 0        | 0     | 0      | 2      |
| Security             | 0        | 0     | 1      | 1      |
| Database and queries | 0        | 0     | 0      | 0      |
| Performance          | 0        | 0     | 0      | 2      |
| User experience      | 0        | 0     | 0      | 3      |
| Dead code            | 0        | 0     | 0      | 1      |
| Duplication          | 0        | 0     | 0      | 5      |
| Readability          | 0        | 0     | 0      | 10     |
| Refactoring          | 0        | 0     | 0      | 3      |
| Best practices       | 0        | 0     | 0      | 3      |
| System design        | 0        | 0     | 0      | 2      |
| SOLID and OOP        | 0        | 0     | 0      | 0      |
| QA and testing       | 0        | 0     | 1      | 3      |
| **Total**            | **0**    | **0** | **2**  | **35** |

## Fix first

1. **SEC-01** · Medium · a saved claude.ai skill that is a plugin is added as a local skill with its hooks and MCP servers never reviewed.
2. **QA-01** · Medium · the project-scope pull test checks `<project>/skills/my-mod/`, which is never written, so its "not written" half cannot fail.
3. **SEC-02** · Low · a plugin hooks file without the `hooks` wrapper gives no review entry and no "unreadable" entry.
4. **BUG-01** · Low · `${VAR}` references in a plugin's `.mcp.json` or manifest `mcpServers` are never scanned, so push saves nothing for them.
5. **QA-02** · Low · the `skills/synced/` exclusion test passes without the exclusion.
6. **DUP-03** · Low · review 15's DUP-04 was fixed in one of its two places; `claude-code-after-restore.test.ts` still has the copy.
7. **UX-01, UX-02** · Low · the plugin review says "not JSON" for a JSON array and echoes a missing MCP file's path instead of "no such file".
8. **UX-03** · Low · any plugin failure containing "blocked" is reported as the organization's policy, with no managed settings present.
9. **BUG-02** · Low · with two claude.ai account folders that both fail, only the last manifest problem is reported.
10. **READ-01, READ-02** · Low · two docs place `windowsNameProblem` in `restore-rules.ts` and say a project syncs "the same folders as global" (no `themes/`).

## Findings

### Security

### SEC-01 · Medium · A saved claude.ai skill that is a plugin is added as a local skill without its hooks or MCP servers being reviewed

- [ ] **Where:** `packages/cli/src/agents/claude-code/account-skills.ts:145-149` (`runsCommands` reads Markdown only), `:151-153` (the rename to `skills/<name>/…`); `packages/cli/src/agents/claude-code/after-restore.ts:224-227` (the flag path blocks only `runsCommands`); `packages/cli/src/agents/claude-code/skills-dir-plugins.ts:25-34` (`PLUGIN_FOLDER` matches `skills/` and `.claude/skills/` only)
- **Problem:** Push saves the user's own claude.ai skills under `.agentnomad/account-skills/<name>/` with every file in the synced folder (`collectAccountSkills` walks with no exclusion; the gatherer skips only the named clutter list, so `.claude-plugin/` comes along). Pull's `reviewRunnable` runs on those bundle paths, where `pluginFolderOf` matches nothing, so no plugin entry is made. Then `planAccountSkills` marks the skill with `runsCommands` from its `.md` files alone and renames the files to `skills/<name>/…`, where Claude Code 2.1.295 loads a folder with `.claude-plugin/plugin.json` as the plugin `<name>@skills-dir`, hooks and MCP servers included. With `pull --global --account-skills` and no `--allow-commands`, `after-restore.ts:224-227` blocks only skills marked `runsCommands`, so this one is written. Confirmed against the built package: a skill with `.claude-plugin/plugin.json`, `hooks/hooks.json` (a `PreToolUse` command) and `.mcp.json` gives `toAdd: [{ name: 'helper', runsCommands: false }]`, `reviewPlugins` on the bundle paths finds 0 entries, and `reviewPlugins` on the paths pull writes finds `plugin skills/helper/ hook PreToolUse` and `plugin skills/helper/ MCP server x`.
- **Why it matters:** The T96 review exists so that hooks and MCP servers in `skills/` need a yes; this path carries the same content past it. The content comes from the user's own claude.ai account, so the attacker is whoever can put a skill there (a shared team skill, a compromised account), the same trust as any synced skill, but the review would have shown it. Threat-model row 18 ("a local skill runs `!` placeholders … so those are marked") no longer describes everything a saved skill can run.
- **Fix:** In `planAccountSkills`, also mark (or refuse) a skill whose renamed files make a plugin: `pluginFolders(renamed).length > 0`. Refusing is simpler and matches what claude.ai skills are for (a skill, not a plugin): `skipped.push({ name, reason: 'it is a plugin; add it from the other PC's skills folder instead' })`. Then `runsCommands` stays about Markdown and the T96 review stays the one place plugins are shown. Add the case to `claude-code-account-skills.test.ts` and one sentence to threat-model rows 18 and 19.
- **Effort:** S
- **Confidence:** high on the behaviour (re-run against `dist`); medium on how often a claude.ai skill carries `.claude-plugin/` (Claude Code writes whatever the account holds)

### SEC-02 · Low · A plugin hooks file without the `hooks` wrapper gives no review entry and no "unreadable" entry

- [ ] **Where:** `packages/cli/src/agents/claude-code/skills-dir-plugins.ts:125` (`hooks.push({ label: relative, hooks: json['hooks'] })`), with `settings-commands.ts:33` (`hookItems(undefined)` is `[]`); comment at `:107-108`
- **Problem:** A hooks file holding the event map at the top level (`{ "PreToolUse": [...] }`) is read, `json['hooks']` is `undefined`, so the source yields no entries; nothing goes to `unreadable` either. A plugin with such a file and no `modules` is never validated (`:334` runs validate only for modules), so the folder is written with nothing shown. Confirmed against the built package: `hooks: [{ label: 'hooks/hooks.json' }]`, `unreadable: []`, `reviewPlugins` gives 0 entries. Claude Code 2.1.295 does refuse the file (`claude plugin validate` reports "declared at the top level, outside the hooks object"), which is what the comment says.
- **Why it matters:** The module's own rule (review 15 SEC-01, "one bad part hides no other") is that a declared part that cannot be read as declared is shown. Today the file is harmless because Claude Code refuses it; a version that accepts the shape would run those hooks unreviewed, and the entry costs one line.
- **Fix:** After reading the file, when `json['hooks'] === undefined && json['modules'] === undefined`, push `unreadable.push({ label: relative, value: json })` instead of a source. Add a test with a wrapper-less file; none exists (`grep -n wrapper claude-code-skills-dir-plugins.test.ts` finds only the manifest and `.mcp.json` cases).
- **Effort:** S
- **Confidence:** high

### Bugs

### BUG-01 · Low · `${VAR}` references in a plugin's MCP files are never scanned, so push saves nothing for them

- [ ] **Where:** `packages/cli/src/env/env-references.ts:56-57` (`if (!mcp.has(file.path) && !settings.has(file.path)) continue;`), with `packages/cli/src/agents/claude-code/env-files.ts:6` (`MCP_FILES` is `.mcp.json` and the `~/.claude.json` bundle path)
- **Problem:** The env scan reads two fixed MCP paths. T96 syncs plugins in `skills/<name>/` whose `.mcp.json` (with or without the wrapper) and inline manifest `mcpServers` carry `${TOKEN}` for their servers; those files are skipped. Confirmed against the built package: `skills/gh/.mcp.json` with `${GITHUB_TOKEN}` and a manifest with `${T2}` plus a root `.mcp.json` with `${A}` scans to `[{ name: 'A' }]` only.
- **Why it matters:** Push does not offer to save the plugin's values and `agentnomad env` does not list them, so the server fails on the other PC with no hint, while pull's review does show the same server: two views of one file disagree.
- **Fix:** Let `EnvReferenceFiles` take a predicate for MCP files (`isMcpFile(path)`) so the Claude Code adapter can name `skills/*/.mcp.json`, `.claude/skills/*/.mcp.json` and plugin manifests; or hand `pluginFolders(files)` server sources to the scan. Update the `envReferences` rows in ARCHITECTURE (`:326`, `:802`). A pre-existing scope that T96 widened.
- **Effort:** M
- **Confidence:** high

### BUG-02 · Low · Only the last claude.ai account's manifest problem is kept

- [ ] **Where:** `packages/cli/src/agents/claude-code/account-skills.ts:58`, `:65-67`
- **Problem:** `problem` is one string reassigned per account folder; with two accounts whose manifests both fail, the first message is lost. The test at `claude-code-account-skills.test.ts:80` covers one account.
- **Why it matters:** "One bad part hides no other" (SEC-01 rule). Pre-existing (T42).
- **Fix:** Collect into `string[]` and join, or make `problem` a list.
- **Effort:** S
- **Confidence:** high

### Performance

### PERF-01 · Low · Each existing file is stat'ed twice on restore

- [ ] **Where:** `packages/cli/src/agents/claude-code/restorer.ts:168` (`readExisting` stats and discards `mode`), `:360` (`(await stat(nativePath)).mode & 0o777`)
- **Problem:** `readExisting` already holds `info.mode`; the writer stats again. A setup "may hold thousands" of files (the module's own comment at `:244`). Pre-existing.
- **Fix:** Return `{ content, mode }` (or `'folder' | null`) from `readExisting`.
- **Effort:** S
- **Confidence:** high

### PERF-02 · Low · A per-file array copy when grouping account-skill files

- [ ] **Where:** `packages/cli/src/agents/claude-code/account-skills.ts:131` (`byName.set(name, [...(byName.get(name) ?? []), file])`)
- **Problem:** Quadratic in one skill's files; `pluginFolders` (`skills-dir-plugins.ts:199-201`) groups the same way with a push. Pre-existing.
- **Fix:** `const group = byName.get(name); if (group) group.push(file); else byName.set(name, [file]);`
- **Effort:** S
- **Confidence:** high

### User experience

### UX-01 · Low · "not JSON" is said for a file that is JSON but not an object

- [ ] **Where:** `packages/cli/src/agents/claude-code/skills-dir-plugins.ts:103-106` (`jsonFileOf` drops the parse problem), `:122`, `:139`, `:174`
- **Problem:** `parseJsonWith` already tells `not valid JSON` from a schema problem (`expected record, received array`); `jsonFileOf` goes through `valueOrNull` and the callers write the fixed text. Confirmed: a manifest naming `h.json` holding `[1, 2]` gives the review line `plugin skills/m/ h.json (unreadable) => "not JSON"`. The sibling `readValidateReport` keeps the real text (`errorText`).
- **Why it matters:** The user opens a valid JSON file to learn why it is "not JSON".
- **Fix:** Have `jsonFileOf` return the `JsonResult` and push `{ label, value: result.problem }`.
- **Effort:** S
- **Confidence:** high

### UX-02 · Low · A named MCP file that is missing is shown as its path in quotes, not as "no such file"

- [ ] **Where:** `packages/cli/src/agents/claude-code/skills-dir-plugins.ts:166-168` vs the hooks sibling at `:114-115`
- **Problem:** `servers.push({ label: relative, servers: json ? serversIn(json) : item })` hands the string `./servers.json` to `serverEntries`, which labels it `MCP servers (unreadable)` with the command `"./servers.json"`. The hooks sibling says `no such file` for a missing file and `not JSON` for a bad one. Confirmed: review lines `plugin skills/s/ gone.json (unreadable) => "no such file"` and `plugin skills/s/ MCP servers (unreadable) => "./servers.json"` for the same situation.
- **Why it matters:** Two wordings for one situation; the MCP one does not say the file is missing, and a not-JSON MCP file reads the same as a missing one.
- **Fix:** Mirror `hooksFile`: `undefined` → `unreadable.push({ label: relative, value: 'no such file' })`, `null` → the parse problem (UX-01); only a read object becomes a `servers` source. One helper for both would also close UX-01.
- **Effort:** S
- **Confidence:** high

### UX-03 · Low · Any plugin failure containing "blocked" is reported as the organization's policy

- [ ] **Where:** `packages/cli/src/agents/claude-code/managed-settings.ts:173-181` (`POLICY_WORDS` holds the bare words `blocked` and `not allowed`; `explainPluginFailure` does not require `found`)
- **Problem:** Confirmed: `explainPluginFailure('connect ECONNREFUSED: request blocked by firewall', null)` returns `blocked by your organization's Claude Code policy. Ask your admin to allow it. Details: …`. The tests (`managed-settings.test.ts:152`, `:199`) cover a policy word with `found` set and a non-matching text, not the `null` case. Pre-existing.
- **Why it matters:** A network failure sends the user to their admin.
- **Fix:** Require `found !== null && found.sources.length > 0` for the generic words; keep the specific ones (`strictKnownMarketplaces`, `blockedMarketplaces`, `managed settings`) unconditional. Test the `null` case.
- **Effort:** S
- **Confidence:** high

### Dead code

### DEAD-01 · Low · `pullWithValidator`'s `cwd` parameter is never passed

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:846` (`cwd?: string`), `:850` (`...(cwd !== undefined && { cwd })`)
- **Problem:** All ten call sites pass at most four arguments; the project test relies on `pullOn`'s default `cwd: machine.project`. Added by the review-15 fix.
- **Fix:** Drop the parameter and the spread.
- **Effort:** S
- **Confidence:** high

### Duplication

### DUP-01 · Low · The set of tool-settings home paths is derived in two modules

- [ ] **Where:** `packages/cli/src/agents/claude-code/restore-rules.ts:73-74` (`Object.values(TOOL_CONFIG_FILES).flat()` and `includes`, recomputed per call), `packages/cli/src/agents/claude-code/command-review.ts:343-347` (the same, prefixed, as a `Set`)
- **Problem:** The same derivation twice, one of them a per-call array scan. Pre-existing.
- **Fix:** Export `TOOL_CONFIG_PATHS: ReadonlySet<string>` from `global-paths.ts` next to `TOOL_CONFIG_FILES`; use it in both.
- **Effort:** S
- **Confidence:** high

### DUP-02 · Low · The sorted usage list is built twice

- [ ] **Where:** `packages/cli/src/env/env-references.ts:78-80`, `:97-99`
- **Problem:** `[...usage.entries()].map(([name, where]) => ({ name, usedBy: [...where].sort() })).sort(…)` appears in `scanEnvReferences` and `mergeEnvScans`. Pre-existing.
- **Fix:** One `variablesOf(usage)` helper.
- **Effort:** S
- **Confidence:** high

### DUP-03 · Low · Review 15's DUP-04 was done in one of its two places

- [ ] **Where:** `packages/cli/test/fakes.ts:253-258` (`fakeExecutables`, commented "review 15 DUP-04"); `packages/cli/test/claude-code-after-restore.test.ts:49-56` (`function system(executables)`, byte for byte the same object)
- **Problem:** Review 15 named both copies and is ticked; only `claude-code-plugin-validate.test.ts` imports the shared fake. `claude-code-after-restore.test.ts` is outside this review's scope, which is why the first round's check did not catch it.
- **Fix:** Import `fakeExecutables` there and delete `system`.
- **Effort:** S
- **Confidence:** high

### DUP-04 · Low · The generated `.claude-plugin/types` path is joined by hand in two pull assertions

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:882`, `:948`; the fixture that knows it: `packages/cli/test/claude-code-plugin-fixtures.ts:164`
- **Problem:** `join(b.base, 'skills', 'my-mod', '.claude-plugin', 'types')` and the project twin spell the segments while `writeGeneratedTypes` builds the same path from `folder`. Review 15 DUP-01 made the fixture the one place for the probe mod's paths.
- **Fix:** Export `generatedTypesDir(base, folder = PROBE_MOD_FOLDER)` from the plugin fixtures, use it in `writeGeneratedTypes` and both assertions; list it in CONTRIBUTING.
- **Effort:** S
- **Confidence:** high

### DUP-05 · Low · The push note's full sentence is pinned in three test files, five times through one helper

- [ ] **Where:** `packages/cli/test/claude-code-skills-dir-plugins.test.ts:221-223` (the module), `packages/cli/test/claude-code-adapter.test.ts:152-156` (the wiring), `packages/cli/test/pull-command.test.ts:811-812` and `:831` (inside `pushedMod()`, called by five tests)
- **Problem:** Review 15 QA-01 offered two fixes and both were done. A wording change now fails seven tests in three files, five of them with titles about pull.
- **Fix:** Keep the module test for the wording and the adapter test for the wiring; in `pushedMod` assert only the prefix (`info: Claude Code global setup: Plugins in the skills folder`) with a comment pointing at the adapter test.
- **Effort:** S
- **Confidence:** medium (nothing is wrong; it is about where the pin belongs)

### Readability

### READ-01 · Low · Two docs place `windowsNameProblem` in `restore-rules.ts`

- [ ] **Where:** `docs/ADDING-AN-AGENT.md:190`; `docs/ARCHITECTURE.md:809`
- **Problem:** The guide says "See `claude-code/restore-rules.ts`, including `windowsNameProblem` for Windows-unsafe names"; the file row says the module holds "Windows name rules". The function is `packages/core/src/path-resolver.ts:37`, used by `restorer.ts:10` and `:306`; `restore-rules.ts` has no Windows rule. Pre-existing (83e1b8e).
- **Fix:** Guide: "Windows-unsafe names are refused with `windowsNameProblem` from `@agentnomad/core`, as `claude-code/restorer.ts` does." Row `:809`: drop the parenthesis; add the sentence to the `restorer.ts` row.
- **Effort:** S
- **Confidence:** high

### READ-02 · Low · ARCHITECTURE says a project's `.claude/` syncs "the same folders as global"

- [ ] **Where:** `docs/ARCHITECTURE.md:359`; the lists at `packages/cli/src/agents/claude-code/claude-code-paths.data.ts:25` (global, with `themes`) and `:97` (project, without)
- **Problem:** The project list leaves `themes/` out. Pre-existing.
- **Fix:** "and the same folders as global except `themes/`".
- **Effort:** S
- **Confidence:** high

### READ-03 · Low · The "a module's tests are in the file named after it" rule has unlisted exceptions

- [ ] **Where:** `docs/ARCHITECTURE.md:628-653`; `CONTRIBUTING.md:167-168`
- **Problem:** Ten `packages/cli/src` modules have no test file named after them and fall under none of the three listed groups: `push/bundle-files.ts`, `agents/shared/file-gathering.ts`, `agents/shared/detector-system.ts`, `agents/shared/bundle-paths.ts`, `cli/flags.ts`, `cli/project-folder.ts`, `api/api-errors.ts`, `agents/claude-code/global-paths.ts`, `project-paths.ts`, `env-files.ts`. Their exports (`toBundleFiles`, `preferLocalEquivalents`, `findExecutable`, `underFolder`, `parseAgentList`, `projectFolderRefusal`, `GLOBAL_PATHS`, `PROJECT_PATHS`) are named in no `*.test.ts`; they are exercised through the command, collector and detector tests. Pre-existing.
- **Why it matters:** The rule is how the docs say tests are found; a reader looking for `bundle-paths`' tests by name finds none and cannot tell whether the module is untested.
- **Fix:** A fourth bullet, "Covered through their callers: …", naming these modules and the test that drives each; echo it in CONTRIBUTING.
- **Effort:** S
- **Confidence:** medium (the modules are covered; the mismatch is the doc's claim)

### READ-04 · Low · README and the program help list the exit-code-1 causes without pull's "not asked about" case

- [ ] **Where:** `README.md:164-167`; `packages/cli/src/cli/program.ts:42-45`; the example at `:37-38`
- **Problem:** Both list "a newer copy, an older copy, over 5 MB, a skip by `--yes`"; `pull-command.ts:573` also returns `not asked about …, so left as they are`, and ARCHITECTURE `:548-552` lists it. The help's `--allow-commands` example still says "hooks, MCP servers and installs" while the flag's own help (`:208`, review 15 UX-03) now names plugins and mods.
- **Fix:** Append "or a file pull found different but never asked about" to both; add "plugins or mods" to the example.
- **Effort:** S
- **Confidence:** high

### READ-05 · Low · The barrel exports every module but `agents/shared/bundle-paths.ts`

- [ ] **Where:** `packages/cli/src/index.ts` (no line for `./agents/shared/bundle-paths.ts`)
- **Problem:** `find src -name '*.ts'` against the export list leaves only `bin.ts`, `index.ts` and `bundle-paths.ts`; its siblings `detector-system.ts` and `file-gathering.ts` are exported, and `underFolder` is used by `adapter.ts:130`. Pre-existing.
- **Fix:** `export * from './agents/shared/bundle-paths.ts';`
- **Effort:** S
- **Confidence:** high

### READ-06 · Low · The plugin fixtures' header comment predates T96

- [ ] **Where:** `packages/cli/test/claude-code-plugin-fixtures.ts:13` (`/** Plugin files shared by the plugin and plugin sync tests (review 7 READ-01). */`)
- **Problem:** The file is now also the home of the skills-folder plugin fixtures (`probeMod` has nine importers).
- **Fix:** "Plugin fixtures: installed plugins and marketplaces, managed settings, and plugins in the skills folder (T96) with what `claude plugin validate` says about them."
- **Effort:** S
- **Confidence:** high

### READ-07 · Low · A local shadows a fixture export of another type

- [ ] **Where:** `packages/cli/test/claude-code-adapter.test.ts:36` (`const noManagedSettings = fakeManagedSystem(…)`, a `ManagedSettingsSystem`); `packages/cli/test/claude-code-plugin-fixtures.ts:68` (`noManagedSettings: ManagedSettings`)
- **Problem:** The test imports from that fixtures module two lines up, so a reader expects the shared constant.
- **Fix:** Rename the local (`unmanagedPc`).
- **Effort:** S
- **Confidence:** high

### READ-08 · Low · "declining a changed mod" asserts less than its siblings

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:910-919`
- **Problem:** It checks the review line and the local file text, but not `t.asked` (every sibling pins `['Allow them?']`), not the `  (changed)` suffix pull adds (`pull-command.ts:342`), and not that the validator was asked. The shape review 15 READ-14 fixed in the "no" test.
- **Fix:** Add the three assertions; `toContain('… (changed)')` also pins that a changed mod is still validated.
- **Effort:** S
- **Confidence:** high

### READ-09 · Low · The collector T96 tests depend on the fixture's file order matching the collector's sort

- [ ] **Where:** `packages/cli/test/claude-code-global-collector.test.ts:128-132`; `packages/cli/test/claude-code-project-collector.test.ts:78-83`
- **Problem:** `expect(paths(await collect())).toEqual(paths(probeMod()))` compares by position; the collector sorts, and `pluginFiles` happens to push its three files alphabetically. Its doc promises only that "the manifest is always there" (review 15 READ-12 made the same point about `slice(1)`).
- **Fix:** Sort both sides, or compare as sets.
- **Effort:** S
- **Confidence:** high

### READ-10 · Low · Comment lines past the 100-column width, and one import out of the sibling order

- [ ] **Where:** `packages/cli/src/pull/pull-command.ts:117` (126 columns), `:513` (119); `packages/cli/src/push/push-command.ts:336` (116), `:41` (`../pull/saved-setups.ts` after `../state/local-state.ts`, the one non-alphabetical relative import of the two files); `docs/ADDING-AN-AGENT.md:336` (a 136-column bullet among bullets wrapped near 95)
- **Problem:** `.prettierrc` sets `printWidth: 100` and Prettier does not rewrap comments, so these stick out of files where every other comment wraps. Pre-existing.
- **Fix:** Rewrap the four lines; move the import.
- **Effort:** S
- **Confidence:** high

### Refactoring

### REF-01 · Low · `restore()` is a 175-line closure doing six jobs

- [ ] **Where:** `packages/cli/src/agents/claude-code/restorer.ts:268-443`
- **Problem:** It builds the allowed-script sets, the destination rule, the lazy memory folder, the per-entry writer, the case-folding loop and the other-OS hook warnings in one function with nested closures. Pre-existing; readable as it is.
- **Fix:** Lift `allowedScriptsOf(target, incoming)`, `otherOsWarnings(…)` and `restoreEntry` to module level with a small context object; no behaviour change.
- **Effort:** M
- **Confidence:** medium

### REF-02 · Low · Several `it`s in the skills-dir tests pack two or three behaviours

- [ ] **Where:** `packages/cli/test/claude-code-skills-dir-plugins.test.ts:185-201` (stray module item, then de-duplication across two hooks files), `:254-275` (changed plugin, then a plain skill becoming one), `:359-378` (unavailable validator, then the `undefined` default), `:46-79`, `:81-117`, `:405-428` (three shapes or reports per `it`)
- **Problem:** Review 15 REF-01 split one test; the pattern remains. A red line reports under a title about another behaviour.
- **Fix:** Split the second halves into their own `it`s; the shape tests fit `it.each`.
- **Effort:** S
- **Confidence:** high

### REF-03 · Low · Two T96 pull tests run a second scenario after the first

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:876-889` (writes the mod, then pulls again to show nothing is reviewed), `:892-907` (a "no", then a "yes" on the same PC)
- **Problem:** The shape review 15 REF-03 fixed elsewhere in the file.
- **Fix:** Split each; the second can reuse the first's state through a small helper.
- **Effort:** S
- **Confidence:** high

### Best practices

### BP-01 · Low · The four `noReportReason` cases are split across two tests, one titled for the wrong branch

- [ ] **Where:** `packages/cli/test/claude-code-plugin-validate.test.ts:73-85` (titled "with what claude said", feeds the stderr branch), `:87-106` (three branches in one `it`); the rule at `plugin-validate.ts:38-46`
- **Problem:** One rule with four alternatives; CONTRIBUTING asks for table tests for rules, and the first title misdirects.
- **Fix:** One `it.each` over `[stdout, exitCode, stderr, failure, expected]`.
- **Effort:** S
- **Confidence:** high

### BP-02 · Low · The account-skills test builds its own `ExecutableLookupSystem` beside the shared fake

- [ ] **Where:** `packages/cli/test/claude-code-account-skills.test.ts:129-134`; `packages/cli/test/fakes.ts:249-258`
- **Problem:** Review 15 made `fakeExecutables` "the only `ExecutableLookupSystem` fake"; this file still builds one inline (with the test's `home` and `process.platform`). Pre-existing.
- **Fix:** `system: fakeExecutables([])` once it is checked that the after-restore account-skills path reads neither `homedir` nor `platform` from it (the restorer carries its own); else give `fakeExecutables` an overrides argument.
- **Effort:** S
- **Confidence:** medium

### BP-03 · Low · The `reviewCovers` unit test sits in a command-level file whose header does not know it

- [ ] **Where:** `packages/cli/test/agent-boundary.test.ts:8` (its import set apart from the other `../src` imports), `:37-41` (the header describes only the second-agent run), `:336-346` (the table test)
- **Problem:** `adapter.ts` has no test file of its own, so review 15 QA-05's direct test landed here. ARCHITECTURE `:646` lists the file under "a whole command through several modules".
- **Fix:** Either `adapter.test.ts` (and a line in ARCHITECTURE's reference), or one sentence in the header and the import merged into the src group.
- **Effort:** S
- **Confidence:** medium

### System design

### ARCH-01 · Low · `global-paths.ts` imports two pure helpers from the file walker, so every "pure" module loads `node:fs` transitively

- [ ] **Where:** `packages/cli/src/agents/claude-code/global-paths.ts:7` (`import { inHomeFolder, isSensitiveHomePath } from '../shared/file-gathering.ts'`); `file-gathering.ts:1` imports `node:fs/promises`
- **Problem:** The lint block (`eslint.config.js:105-114`) keeps the four pure modules from `node:*` and from `file-gathering.ts`, but all four import `global-paths.ts`, which imports the walker for two string functions. `bundle-paths.ts` describes itself as "pure text, so the pure modules may use them too" and is the natural home. Pre-existing.
- **Why it matters:** The purity guarantee is direct-import only; module-level code of the walker runs in the pure modules' tests.
- **Fix:** Move `inHomeFolder`, `SENSITIVE_HOME_DIRS` and `isSensitiveHomePath` to `agents/shared/bundle-paths.ts`; the walker imports them from there. Update the `shared/` row in ARCHITECTURE.
- **Effort:** S
- **Confidence:** high

### ARCH-02 · Low · `global-collector.ts` imports the data file directly

- [ ] **Where:** `packages/cli/src/agents/claude-code/global-collector.ts:13` (`import { settingsFilesIn } from './claude-code-paths.data.ts'`)
- **Problem:** ARCHITECTURE `:800` describes `global-paths.ts` and `project-paths.ts` as the "named views of the data file"; the collector is the one other importer (`index.ts` aside). Pre-existing.
- **Fix:** Re-export `settingsFilesIn` from `global-paths.ts` and import it there.
- **Effort:** S
- **Confidence:** medium (how strict the "views only" rule is meant to be)

### QA and testing

### QA-01 · Medium · The project-scope pull test's "not written" loop checks a folder the restorer never writes

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:809-810` (`modFiles` uses `probeMod()` with its default `skills/my-mod/`), `:937` (`for (const file of modFiles(b, b.project)) expect(await exists(file)).toBe(false)`), `:945-946` (the second half correctly uses `probeMod(folder)` under `.claude/skills/`)
- **Problem:** The loop looks at `<project>/skills/my-mod/…`; a project mod is written to `<project>/.claude/skills/my-mod/…`. So the `--yes` half of "reviewed and written the same way" asserts nothing about files. The reviewer ran two variants: with the first pull changed to `allowCommands: true` (the mod is written) the test still passes; with the loop pointed at `probeMod(folder)` under the project it fails as it should. Added by the review-15 fix for QA-05.
- **Why it matters:** This is the one pull-level test of a project-scope plugin. If `--yes` started writing a declined plugin for project targets, every unit test would stay green.
- **Fix:** One `const projectMod = probeMod(folder).map((file) => join(b.project, ...file.path.split('/')))` used at both `:937` and `:945`, and, as the global test does at `:884`, `expect(written.lines.filter((line) => line.startsWith('warn:'))).toEqual([])` after the second pull so the `types` check fails for the right reason. A `PROJECT_MOD_FOLDER` constant next to `PROBE_MOD_FOLDER` would stop `'.claude/skills/my-mod/'` being retyped here and in the project-collector test.
- **Effort:** S
- **Confidence:** high

### QA-02 · Low · The `skills/synced/` exclusion test passes without the exclusion

- [ ] **Where:** `packages/cli/test/claude-code-skills-dir-plugins.test.ts:23-24` (`collectedJson('skills/synced/acct/x/.claude-plugin/plugin.json', …)`); the rule at `skills-dir-plugins.ts:32` and the manifest check at `:205`
- **Problem:** A manifest two levels down never makes a folder a plugin (`pluginFolders` needs it at `folder + MANIFEST_PATH`), so the assertion holds with the `name === 'synced'` clause deleted. Confirmed against the built package: the same file under `skills/other/acct/x/` also gives `[]`; only `skills/synced/.claude-plugin/plugin.json` exercises the clause (and gives `[]`, as it should).
- **Fix:** Use `collectedJson('skills/synced/.claude-plugin/plugin.json', { name: 'synced' })`; keep the deep one as a second negative if wanted.
- **Effort:** S
- **Confidence:** high

### QA-03 · Low · Three branches of `skills-dir-plugins.ts` still have no case

- [ ] **Where:** `packages/cli/src/agents/claude-code/skills-dir-plugins.ts:360` (`calls: ${module.calls || 'nothing on $'}`), `:128-131` (`modules` that is not an array), `:82` (an `http(s)://` bundle URL with no `.mcpb`/`.dxt` suffix)
- **Problem:** The test file feeds `'nothing on $'` only as validate's own note text (`:394`, `:401`), never as the fallback for an empty `calls`; every `modules` value in the file is an array (`:35`, `:53`, `:188`, `:197`, `:198`); both URL fixtures (`HTTPS://example.com/s.dxt`, `https://example.com/server.mcpb`) also match the suffix test, so the URL-only alternative is never the reason.
- **Fix:** One report with `notes: ['./register.ts hooks: session.start']` reviewed to `calls: nothing on $`; one `hooks.json` with `modules: './register.ts'` expecting `modules: []` and the unreadable entry; `'http://example.com/server'` in the declared-servers list at `:94-102`.
- **Effort:** S
- **Confidence:** high

### QA-04 · Low · The folder-only skip warning is pinned nowhere

- [ ] **Where:** `packages/cli/src/pull/pull-command.ts:362-376` (two optional sentences); `packages/cli/test/pull-command.test.ts:872`, `:903` (both from `pushedMod()`, which also has a Stop hook, so both read "Skipped settings.json, hooks/check.sh: … Skipped skills/my-mod/: …")
- **Problem:** The branch with no blocked files and one folder (`Skipped .claude/skills/my-mod/: a plugin is accepted or left out as a whole. The rest is restored.`) is produced by the project-mod test (`:930-950`) and not asserted.
- **Fix:** Add the `warn:` line assertion to the project-mod test (QA-01 touches the same test).
- **Effort:** S
- **Confidence:** high

## Standards to adopt

- **Unreadable parts of a plugin carry the reason.** One helper in `skills-dir-plugins.ts` returns `no such file`, the parse problem from `parseJsonWith`, or the object; hooks files, MCP files and the manifest all use it (SEC-02, UX-01, UX-02).
- **Anything pull writes into `skills/` goes through the plugin review.** Account skills included (SEC-01); the review is the one place a plugin's hooks and servers are shown.
- **One `ExecutableLookupSystem` fake.** `fakeExecutables` in `fakes.ts`; bring `claude-code-after-restore.test.ts` and `claude-code-account-skills.test.ts` in line (DUP-03, BP-02).
- **Probe-mod paths come from the fixture.** `probeMod(folder)`, `writeGeneratedTypes`, and a `generatedTypesDir` for assertions; a `PROJECT_MOD_FOLDER` constant beside `PROBE_MOD_FOLDER` (DUP-04, QA-01).
- **One behaviour per `it`, tables for rules.** `it.each` for `noReportReason` and the manifest shapes; second scenarios get their own `it` (BP-01, REF-02, REF-03).
- **Pure text helpers live in `agents/shared/bundle-paths.ts`.** `inHomeFolder` and `isSensitiveHomePath` move there so the pure modules never reach `node:fs` (ARCH-01).

## What will break first at scale

1. **Many plugins in one setup:** `reviewPlugins` (`skills-dir-plugins.ts:388-397`) validates plugins one after another, each run with a 60 s timeout (`plugin-validate.ts:31`), so a setup with ten mods and a hung `claude` waits ten minutes before pull asks anything. Running the validations with a small concurrency limit, or one `claude plugin validate` per temporary folder holding all of them, keeps the wait at one timeout.
2. **Large setups on restore:** every existing file is stat'ed twice (`restorer.ts:168`, `:360`, PERF-01) and the account-skills grouping copies an array per file (`account-skills.ts:131`, PERF-02); both are linear today but are the first per-file costs to remove when setups grow past thousands of files.
3. **Env references across more file kinds:** `env-references.ts:56` scans a fixed set of two MCP paths; as adapters sync more files that hold `${VAR}` (plugin MCP files now, other agents' configs later), each needs its own entry or the scan takes a predicate (BUG-01).

## New or pre-existing

Checked against `30eb20f`, the commit before T95:

- **Opened or widened by T96 or the review-15 fixes (22):** SEC-01 (the account-skills code is T42, but plugins in `skills/` loading as plugins is what T96 models), SEC-02, BUG-01 (scope widened), UX-01, UX-02, DEAD-01, DUP-03, DUP-04, DUP-05, READ-04 (the help example), READ-06, READ-07, READ-08, READ-09, REF-02, REF-03, BP-01, BP-03, QA-01, QA-02, QA-03, QA-04.
- **Pre-existing, in files the fixes touched or the first round read whole (15):** BUG-02, PERF-01, PERF-02, UX-03, DUP-01, DUP-02, READ-01, READ-02, READ-03, READ-05, READ-10, REF-01, BP-02, ARCH-01, ARCH-02.

## Suggested order of work

1. **SEC-01, SEC-02, UX-01, UX-02** · the plugin review's edges: refuse a plugin inside a saved claude.ai skill, and one reason-carrying helper for unreadable plugin files (one module, one test file, plus the account-skills test and threat-model rows 18 and 19).
2. **QA-01, QA-04, DEAD-01, DUP-04, READ-08, REF-03** · `pull-command.test.ts`: the project-scope test that cannot fail, the folder-only warning, and the shapes around it (one file plus `generatedTypesDir` in the fixtures).
3. **QA-02, QA-03, REF-02, DUP-05, BP-01, READ-06, READ-07** · the plugin unit tests and fixtures: the synced-folder test, the three untested branches, the split tests, the push-note pin.
4. **BUG-01, DUP-02** · the env scan: a predicate for MCP files so plugin servers' `${VAR}` are offered on push; while there, the one `variablesOf` helper.
5. **DUP-03, BP-02, UX-03, BUG-02, PERF-02** · the pre-existing points in the account-skills, after-restore and managed-settings code.
6. **READ-01, READ-02, READ-03, READ-04, READ-05, READ-10** · docs and layout.
7. **ARCH-01, ARCH-02, DUP-01, PERF-01, REF-01, BP-03** · structure: the pure helpers' home, the data-file view, the tool-settings set, the second stat, the restore closure, where `reviewCovers`' test lives.

## Not reviewed

- Files outside the diff `30eb20f..018324d`: among them `claude-code-after-restore.test.ts` (named by DUP-03), `after-restore.ts` (named by SEC-01), `env-files.ts` (named by BUG-01) and `settings-commands.ts`' callers; they were opened to confirm findings, not reviewed line by line.
- `docs/reviews/` itself.
- The e2e suite was not re-run for this review; it passed on `018324d` earlier today (15 tests, one machine). CI on `018324d` had not been checked at the time of writing.
