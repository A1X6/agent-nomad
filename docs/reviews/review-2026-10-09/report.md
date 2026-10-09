# Code Review — Agent Nomad — 2026-10-09 (review 15)

**Scope:** everything the two tasks merged into `dev` today changed: T95 (plugin facts from Claude Code 2.1.295, the `plugins.generatedInPlugin` data entry, the 2.1.295 synced-skills fixture) and T96 (plugins and mods in the skills folder: skipped generated files, the folder-level pull review with `claude plugin validate`). The diff `30eb20f..a8de540`, 35 files, read in full.
**Stack:** pnpm monorepo, TypeScript strict, Node 22.13 or newer. Packages: `contracts` (Zod schemas), `core` (encryption, bundle format, merge), `cli` (the `agentnomad` command), `server`, `e2e`. Tests with Vitest.
**Coverage:** 35 of 35 files read in full, 11,138 lines. See `files.md` for one row per file.
**Checks run:** type check pass · lint pass · format check pass · tests pass (1,424 passed, 12 skipped, 82 files) · `pnpm knip` pass · `pnpm audit --prod` pass (no known vulnerabilities) · e2e pass (15 tests, one machine) · CI on `a8de540` pass (3 OSes × Node 22.13 and 24, both cross-OS e2e chains).

**How it was done:** four reviewers each read one part of the scope line by line (the adapter source; the commands, e2e step and docs; the plugin and fixture tests; the command and collector tests) and confirmed their findings at exact lines. The orchestrator re-ran the code behind every behavioural finding against the built package (the SEC-01 drops, the case folding on restore, the validate report shapes), checked every documentation claim against the code, merged the findings two reviewers reported twice, and did the cross-file passes. Claude Code's plugin manifest reference was read for every format the new code handles.

## Summary

The two tasks are sound and the boundaries hold: no Critical, no High, 2 Medium and 38 Low findings, none of which lets a pulled plugin run without being shown. The one logic slip (BUG-01) is in the "one bad part hides no other" rule the module sets itself: a manifest that names the default hooks file when that file is missing produces no review line, because the default read already marked the path as seen. Three Low security points are hardening, not holes: the temporary copy used for `claude plugin validate` is written under a folder the bundle names (SEC-01); a validate report with `success: false` but an error list in an unexpected shape reads as "no errors" (SEC-02); and the generated-folder refusal on restore keeps case while every sibling refusal ignores it, so on Windows and macOS a bundle can write `Types/` where `types/` is refused (SEC-03, type declarations only).

The two Medium findings are about what guards the behaviour, not the behaviour itself: the adapter's `describeCollected` wiring (push's "Plugins in the skills folder" line) is covered by no unit test, only the e2e run (QA-01), and the adapter guide still describes `reviewRunnable` as synchronous, so an adapter written from it would not compile (READ-01).

The rest is what two review rounds in one day leave behind: the probe mod rebuilt in five test files, a copied fake, untested branches of the new modules, docs tables that did not follow the code (`.claude-plugin/types/` is missing from the "never synced" cells, the inspector row does not know `describeCollected`), and a few test names and comments. Eight findings are pre-existing and only noticed because the files were read whole.

Nothing found blocks what is on `dev`.

## Scores

| Area                         | Score /10 | One-line reason                                                                                                                          |
| ---------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness                  | 9         | One Low logic slip (BUG-01); every manifest shape in the reference is handled and tested.                                                |
| Security                     | 9         | Nothing runs unseen; three Low hardening points on the validate copy, the report shape and case folding on restore.                      |
| Performance                  | 9         | One per-file scan in pull's decline path (PERF-01); the rest uses lookup tables.                                                         |
| User experience              | 9         | Three Low wording gaps: the folder skip message, a lost timeout reason, the `--allow-commands` help.                                     |
| Readability                  | 8         | Code is clear; the docs lag the code in six places, one of them misleading (READ-01).                                                    |
| Maintainability              | 8         | Six duplications, mostly test setup repeated across files; two pre-existing copies the new code added to.                                |
| Architecture and scalability | 9         | Adapter boundary and pure-module split hold; no import cycles; one lint block lets three "pure" modules import `node:*` (BP-01).         |
| Test coverage                | 8         | Every documented shape has a test and the e2e carries a mod across PCs; several branches of the new modules and one wiring are unpinned. |

| Category             | Critical | High  | Medium | Low    |
| -------------------- | -------- | ----- | ------ | ------ |
| Bugs                 | 0        | 0     | 0      | 1      |
| Security             | 0        | 0     | 0      | 3      |
| Database and queries | 0        | 0     | 0      | 0      |
| Performance          | 0        | 0     | 0      | 1      |
| User experience      | 0        | 0     | 0      | 3      |
| Dead code            | 0        | 0     | 0      | 0      |
| Duplication          | 0        | 0     | 0      | 6      |
| Readability          | 0        | 0     | 1      | 15     |
| Refactoring          | 0        | 0     | 0      | 3      |
| Best practices       | 0        | 0     | 0      | 1      |
| System design        | 0        | 0     | 0      | 0      |
| SOLID and OOP        | 0        | 0     | 0      | 0      |
| QA and testing       | 0        | 0     | 1      | 5      |
| **Total**            | **0**    | **0** | **2**  | **38** |

## Fix first

1. **BUG-01** · Low · a manifest naming the default hooks file when that file is missing is dropped from the review silently (the module's own SEC-01 rule).
2. **SEC-01** · Low · the temporary copy for `claude plugin validate` sits under a folder the bundle names; use a fixed name.
3. **SEC-03** · Low · the generated-folder refusal on restore keeps case; every sibling refusal ignores it (T43).
4. **SEC-02** · Low · a validate report with `success: false` and an unreadable error list is shown as a working plugin.
5. **QA-01** · Medium · push's "Plugins in the skills folder" line is wired in the adapter with no unit test; only the e2e run would notice it going.
6. **READ-01** · Medium · the adapter guide still describes `reviewRunnable` as synchronous and does not say a reviewed entry may be a folder.
7. **PERF-01** · Low · pull's decline path scans the blocked list once per bundle file.
8. **UX-01** · Low · the skip message says a plugin folder "holds those commands or is run by them".

## Findings

### Bugs

### BUG-01 · Low · A manifest that names the default hooks file, when that file is missing, is dropped silently

- [ ] **Where:** `packages/cli/src/agents/claude-code/skills-dir-plugins.ts:105-112` (`hooksFile`), `:126` (the default read), `:139` (the manifest loop)
- **Problem:** `hooksFile(DEFAULT_HOOKS_PATH, false)` adds `hooks/hooks.json` to `read` even when `jsonFileOf` finds no file. When the manifest then declares `hooks: "./hooks/hooks.json"`, the second call returns at `if (read.has(relative)) return;` before the `named` branch, so no `{ label, value: 'no such file' }` entry is pushed. Confirmed against the built package: `{ name, hooks: './hooks/hooks.json' }` with no such file gives `hooks: []`, `unreadable: []`. The test at `claude-code-skills-dir-plugins.test.ts:157` covers "named twice, file present"; the missing-file case is tested only for a non-default name (`./gone.json`).
- **Why it matters:** The module's own rule (SEC-01) is that a declared part that cannot be read is shown, never dropped. Here a broken declaration Claude Code will refuse to load produces nothing in the review.
- **Fix:** Mark a path as read only once a file was found, or check `named` before the early return:
  ```ts
  const hooksFile = (relative: string, named: boolean) => {
    const json = jsonFileOf(relative);
    if (json === undefined) {
      if (named && !read.has(relative)) unreadable.push({ label: relative, value: 'no such file' });
      read.add(relative);
      return;
    }
    if (read.has(relative)) return;
    read.add(relative);
    …
  ```
  Add the case to the SEC-01 test.
- **Effort:** S · **Confidence:** high · New

### Security

### SEC-01 · Low · The temporary copy is written under a folder the bundle names, in the folder `claude` runs from

- [ ] **Where:** `packages/cli/src/agents/claude-code/plugin-validate.ts:45`, `:56`
- **Problem:** `folder = join(root, plugin.name)` and `claude` is run with `cwd: root`. `plugin.name` is the bundle's `skills/<name>/` segment, which `BundlePathSchema` only keeps from being `.`, `..` or empty. A tampered bundle can call its plugin `.claude`, so the unaccepted files land at `<cwd>/.claude/…`, where Claude Code looks for a project's settings when started with that cwd. Whether `claude plugin validate` reads project settings for a non-interactive subcommand was not verified; this is a hardening gap, not a demonstrated path.
- **Why it matters:** The temporary folder exists so an unaccepted plugin is checked with no side effects; the bundle should have no say in what Claude Code sees there.
- **Fix:** Use a fixed inner name (`join(root, 'plugin')`): validate takes the plugin's name from its manifest, not the folder. Add a test with a plugin named `.claude`. Update the "temporary copy" wording in the threat model row to "under a fixed name".
- **Effort:** S · **Confidence:** medium · New

### SEC-02 · Low · A validate report with `success: false` and an unreadable error list is shown as a working plugin

- [ ] **Where:** `packages/cli/src/agents/claude-code/skills-dir-plugins.ts:234-244` (`ReportSchema`), `:253-256`, `:324-328`
- **Problem:** `errors: z.array(Problem).catch([])` turns an `errors` array holding one item without a string `message` into `[]`, and the report's `success` field is never read. Confirmed: `{ success: false, manifest: { errors: [{ code: 'x' }] }, contents: [] }` reads as `errors: []`, so the "(broken: Claude Code will not load it)" entry does not appear although Claude Code reported a failure. The mod is still listed and still needs a yes; only its broken status is lost.
- **Why it matters:** A future Claude Code that changes the error item shape would downgrade every broken mod to "fine" without any test noticing.
- **Fix:** Read `success: z.boolean().optional()`; after collecting `errors`, when `report.success === false && errors.length === 0`, push `'validate reported a failure it did not explain'`. Prefer `z.array(z.unknown())` and show an item that is not a `Problem` through `stable(item)` instead of `.catch([])`. Add the case to the report tests.
- **Effort:** S · **Confidence:** medium · New

### SEC-03 · Low · The generated-folder refusal on restore keeps case, unlike every sibling refusal

- [ ] **Where:** `packages/cli/src/agents/claude-code/restore-rules.ts:102`, `:136` (`isPluginGenerated(path)`); `packages/cli/src/agents/claude-code/global-paths.ts:91-99`; tests `packages/cli/test/claude-code-restore-rules.test.ts:50-59`, `packages/cli/test/claude-code-paths-data.test.ts:25`
- **Problem:** The restore-rules table documents the T43 rule ("Windows and macOS ignore case: another spelling of a refused folder is refused too") and uses `underAnyCase` for every refusal; the new refusal uses the case-keeping `isPluginGenerated`. Confirmed: `globalDestination('skills/x/.claude-plugin/Types/a.d.ts')` and `projectDestination('.claude/skills/x/.claude-plugin/TYPES/a.d.ts')` are `target`, while `Plugins/cache/x` is refused. Case-keeping is right for the collector (on Linux `Types/` is the user's own folder, pinned by the data test), but on restore the T43 reasoning applies: on Windows and macOS `Types/` is the folder Claude Code generates.
- **Why it matters:** Low impact (the folder holds type declarations; nothing runs), but it contradicts the rule the test file itself states, and no test records the decision either way.
- **Fix:** Give `isPluginGenerated` an `ignoreCase` option used only by `restore-rules.ts` (as `underFolder` has), and add `['Skills/my-mod/.claude-plugin/Types/x.d.ts', 'Claude Code generates it inside a plugin folder']` to the global table plus a project case.
- **Effort:** S · **Confidence:** high · New

### Performance

### PERF-01 · Low · Pull's decline path scans the blocked list once per bundle file

- [ ] **Where:** `packages/cli/src/pull/pull-command.ts:353-356`
- **Problem:** Before T96 `blocked` was a `Set` and the filter was `!blocked.has(file.path)`. Now every bundle file runs `blocked.some((covered) => reviewCovers(covered, file.path))`. `blocked` is the distinct `file` of every reviewed entry, which scales with files too (each skill with a `` !`cmd` `` placeholder is its own entry), so the work is files × blocked.
- **Why it matters:** PERF-01 (review 1) is the repo's rule: lookup tables for things that scale with files; a bundle may hold thousands. Unnoticeable for normal setups, seconds in a large skills folder with many flagged files.
- **Fix:** Split `blocked` once: `const exact = new Set(blocked.filter((f) => !f.endsWith('/')))`, `const folders = blocked.filter((f) => f.endsWith('/'))`; then `exact.has(file.path) || folders.some((f) => reviewCovers(f, file.path))`. Folders stay a short list, one per plugin.
- **Effort:** S · **Confidence:** high · New

### User experience

### UX-01 · Low · The skip message describes a plugin folder as if it "holds those commands"

- [ ] **Where:** `packages/cli/src/pull/pull-command.ts:357-359`
- **Problem:** With a folder in `blocked` the warning reads `Skipped skills/probe-mod/: they hold those commands or are run by them. The rest is restored.` A mod's entries are modules that run inside Claude Code and the whole folder is dropped; the review lines just above called them "plugin … module … (runs code inside Claude Code)".
- **Why it matters:** This is the one place the user learns a whole folder was left out; its wording was written for files.
- **Fix:** Word it for both shapes, e.g. `Skipped <list>: the files that hold those commands or are run by them, and each plugin folder as a whole. The rest is restored.` Pin the exact line in the "a no leaves the whole folder out" test (see READ-14).
- **Effort:** S · **Confidence:** medium · New

### UX-02 · Low · A timed-out or error-answering validate is reported as "gave no report (exit code 1)"

- [ ] **Where:** `packages/cli/src/agents/claude-code/plugin-validate.ts:56-60`; `packages/cli/src/agents/claude-code/plugin-sync.ts:22-27` (`ProgramCli.run` drops `runProgram`'s `error`)
- **Problem:** `runProgram` turns a timeout into `exitCode: 1` with the reason only in `error`, which `ProgramCli.run` does not return; after the 60 s timeout the user reads `claude plugin validate gave no report (exit code 1)`. An error answer on stdout (`{"success":false,"error":"Plugin directory not found"}`) is not surfaced either: the reason falls back to stderr's first line or the exit code.
- **Why it matters:** The reason is all the user has to decide whether to accept a mod that could not be checked; "exit code 1" says nothing about a hang or what `claude` objected to. The same fallback is in plugin-sync's own failure messages (pre-existing).
- **Fix:** Have `ProgramCli.run` return `error?.message` (or a `timedOut` flag) and name it; read `{ error: z.string() }` from stdout before giving up.
- **Effort:** S · **Confidence:** medium · New

### UX-03 · Low · The `--allow-commands` help does not name plugins and mods in the skills folder

- [ ] **Where:** `packages/cli/src/cli/program.ts:207-208` (outside the diff; the flag's meaning grew in T96)
- **Problem:** The help says "accept new or changed hooks, MCP servers and scripts, and install plugins and programs"; since T96 it also accepts a mod whose code runs inside Claude Code. README line 149 says "anything else that runs", which is broader than the help line.
- **Fix:** "…hooks, MCP servers, scripts and plugins or mods in the skills folder, and install plugins and programs".
- **Effort:** S · **Confidence:** high · New

### Duplication

### DUP-01 · Low · The probe mod is rebuilt in five test files

- [ ] **Where:** `packages/cli/test/claude-code-skills-dir-plugins.test.ts:12-13` (`MOD`, `mod()`); `packages/cli/test/claude-code-plugin-validate.test.ts:19-20` (identical); `packages/cli/test/pull-command.test.ts:795-806` (`MOD_FILES`, the same three paths by hand, and the same `pluginFiles` call plus a hand-joined generated `types/` path); `packages/cli/test/claude-code-global-collector.test.ts:125-135`; `packages/cli/test/claude-code-project-collector.test.ts:79-100` (12 lines of `join(project, '.claude', 'skills', …)` because the path is spelled segment by segment)
- **Problem:** `pluginFiles('skills/my-mod/', { modules: ['./register.ts'] })` and the generated `.claude-plugin/types/claude-code/index.d.ts` appear in all five; the expected three bundle paths are written out three times. `PROBE_MOD_VALIDATION` and `REAL_VALIDATE_REPORT` already describe this exact mod in the plugin fixtures, but its files are not a fixture. CONTRIBUTING asks for one set of fakes.
- **Why it matters:** If the probe mod's shape changes, five files change, and `MOD_FILES` can drift from `pluginFiles` while its test still passes (it checks a subset).
- **Fix:** In `claude-code-plugin-fixtures.ts` add `PROBE_MOD_FOLDER = 'skills/my-mod/'`, `probeMod(folder = PROBE_MOD_FOLDER)` returning `pluginFiles(folder, { modules: ['./register.ts'] })`, and `writeGeneratedTypes(base, folder)`; the collectors then `expect(found).toEqual(paths(probeMod()))` and pull-command derives `modFiles` from it. Name them in CONTRIBUTING.
- **Effort:** S · **Confidence:** high · New

### DUP-02 · Low · `isNeverSynced` exists twice and was extended twice in lockstep

- [ ] **Where:** `packages/cli/src/agents/claude-code/global-collector.ts:54-55`; `packages/cli/src/agents/claude-code/project-collector.ts:36-38`
- **Problem:** Both are `LIST.some((entry) => underFolder(bundlePath, entry)) || isPluginGenerated(bundlePath)` with a different list; T96 had to add the clause in both places.
- **Fix:** One factory next to `isPluginGenerated` in `global-paths.ts`: `export const neverSyncedIn = (entries: readonly string[]) => (bundlePath: string) => entries.some((entry) => underFolder(bundlePath, entry)) || isPluginGenerated(bundlePath)`, used by both collectors.
- **Effort:** S · **Confidence:** high · Pre-existing duplication; the new clause is new

### DUP-03 · Low · The "JSON object" Zod schema is declared in four modules

- [ ] **Where:** `packages/cli/src/agents/claude-code/skills-dir-plugins.ts:36`; `packages/cli/src/agents/claude-code/command-review.ts:57`, `:59`; `packages/cli/src/agents/claude-code/settings-commands.ts` (`JsonObject`); `packages/cli/src/agents/claude-code/global-collector.ts:136`
- **Problem:** `z.record(z.string(), z.unknown())` under three names.
- **Fix:** Export `JsonObjectSchema` from `packages/cli/src/system/json.ts` (already the home of `parseJsonWith`) and import it.
- **Effort:** S · **Confidence:** high · Pre-existing; `skills-dir-plugins.ts` adds the fourth copy

### DUP-04 · Low · The `ExecutableLookupSystem` fake is copied between two test files

- [ ] **Where:** `packages/cli/test/claude-code-plugin-validate.test.ts:26-32`; `packages/cli/test/claude-code-after-restore.test.ts:49-57`
- **Problem:** The same `platform: 'linux'`, `homedir: '/home/a'`, `env: { PATH: '/usr/bin' }`, `isExecutable` over a list, down to the same SOLID-06 comment.
- **Why it matters:** Each new consumer of `findClaudeExecutable` (T97 to T102) will copy it again.
- **Fix:** Export `linuxExecutables(executables: string[]): ExecutableLookupSystem` from `fakes.ts` (type-only import) or `claude-code-plugin-fixtures.ts`; name it in CONTRIBUTING.
- **Effort:** S · **Confidence:** high · New (the after-restore copy is pre-existing)

### DUP-05 · Low · `syncedSetup` and `syncedSetup2_1_295` repeat the same files and entry shapes

- [ ] **Where:** `packages/cli/test/claude-code-project-fixtures.ts:123-154` vs `:176-191`; `:158`, `:160` vs `:195`, `:196`
- **Problem:** The two fixtures differ only in the manifest fields; the `SKILL.md` writes for `my-skill` and `pdf` and the common entry fields (`description: 'd'`, `updatedAt: 't'`) are duplicated.
- **Why it matters:** T104 will edit both together when it teaches the reader `source` and `backingPluginId`.
- **Fix:** Two small private helpers in the fixtures file: `syncedEntry(name, extra)` and `syncedSkillOnDisk(name, body)`.
- **Effort:** S · **Confidence:** high · New

### DUP-06 · Low · The review-line lookup is repeated eight times in the pull tests

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:217`, `:232`, `:300`, `:337`, `:833`, `:856`, `:880` (and one more)
- **Problem:** `t.lines.find((line) => line.includes('run programs on this PC')) ?? ''` copied per test; line 300 spells it `'which run programs on this PC'` and without `?? ''`.
- **Fix:** A `reviewShown = (lines: string[]) => lines.find(…) ?? ''` next to `pullOn`.
- **Effort:** S · **Confidence:** high · Pre-existing; T96 added three copies

### Readability

### READ-01 · Medium · The adapter guide describes `reviewRunnable` as it was before T96

- [ ] **Where:** `docs/ADDING-AN-AGENT.md:194-196`, `:327-328`
- **Problem:** `Restorer.reviewRunnable` now returns a `Promise` (`adapter.ts:173-176`) and a `RunnableEntry.file` may be a folder ending in `/` that pull matches with `reviewCovers` (`adapter.ts:109-130`); the guide says neither, and the Step 10 checklist still names only `claude-code/command-review.ts` as the example although `skills-dir-plugins.ts` is now the second half of Claude Code's review.
- **Why it matters:** A new adapter written from the guide would type `reviewRunnable` synchronously (a compile error) and would not know it can review a folder as one unit.
- **Fix:** In Step 5 say it is async ("may run the agent's own check, e.g. `claude plugin validate`") and that `file` may be a folder with a trailing slash "which pull drops whole when declined (`reviewCovers`)"; add `skills-dir-plugins.ts` to the Step 10 bullet.
- **Effort:** S · **Confidence:** high · New

### READ-02 · Low · `reviewedVersion` stays at 2.1.292 while the file records facts "checked on Claude Code 2.1.295"

- [ ] **Where:** `packages/cli/src/agents/claude-code/claude-code-paths.data.ts:17` vs `:64-65`, `:104-115`
- **Problem:** The header says `reviewedVersion` is "the newest Claude Code these lists were checked against", yet T95 added a 2.1.295 entry and the `plugins` block says "checked on Claude Code 2.1.295". The drift check reports changelog entries after `reviewedVersion`, so the next issue lists 2.1.293 to 2.1.295 again, including what T95 handled.
- **Fix:** Bump to `2.1.295` after reading the three changelog entries, or add one line to the comment saying a partial check (T95) does not move it.
- **Effort:** S · **Confidence:** medium · New

### READ-03 · Low · "not JSON" is pushed for a manifest that is absent, which cannot happen

- [ ] **Where:** `packages/cli/src/agents/claude-code/skills-dir-plugins.ts:128-130`
- **Problem:** `pluginFolders` calls `readPlugin` only when the manifest file exists, so `manifest === undefined` is unreachable, yet the branch reports it as "not JSON".
- **Fix:** `if (manifest === null) unreadable.push(…)` and let `undefined` fall through.
- **Effort:** S · **Confidence:** high · New

### READ-04 · Low · The `nodeModules` lint comment still says "Settings parsing"

- [ ] **Where:** `eslint.config.js:23-27`, `:105`
- **Problem:** The block now also guards `skills-dir-plugins.ts`, which is plugin reading; the message a developer sees on a violation names the wrong module.
- **Fix:** "The pure text modules (settings parsing, plugin reading) have no file or process access."
- **Effort:** S · **Confidence:** high · New

### READ-05 · Low · The threat model header says it is updated through T88 while row 19 is T96

- [ ] **Where:** `docs/security/threat-model.md:3`
- **Fix:** "updated through T96".
- **Effort:** S · **Confidence:** high · New

### READ-06 · Low · ARCHITECTURE's adapter table and push steps do not know `describeCollected`

- [ ] **Where:** `docs/ARCHITECTURE.md:323` (the `inspector` row), `:247` (push step 4)
- **Problem:** The row lists "managed settings, files this version does not know yet, a setup saved with a newer version"; push step 4 lists "organization-managed settings and files the adapter does not know yet". `describeCollected` (`adapter.ts:205-210`, called at `push-command.ts:304-307`) is in neither, though the section 7 prose and ADDING-AN-AGENT describe it.
- **Fix:** Add "what the adapter says about a collected setup, e.g. plugins in its skills folder" to the row and to the push step.
- **Effort:** S · **Confidence:** high · New

### READ-07 · Low · The generated `.claude-plugin/types/` folder is missing from the "never synced" cells and the `global-paths.ts` row

- [ ] **Where:** `docs/ARCHITECTURE.md:355` ("Never saved" column), `:798` (`global-paths.ts, project-paths.ts` row); `README.md:175` ("Never synced" cell of the Plugins row)
- **Problem:** T96 made `.claude-plugin/types/` never synced and refused on restore; the threat model row and the section 7 prose say so, but the "What is saved" table, the README table ("Plugin files and caches" only) and the file row for `global-paths.ts` (which gained `PLUGIN_GENERATED_PATHS` and `isPluginGenerated`) do not.
- **Fix:** Append "`.claude-plugin/types/` inside a plugin (Claude Code generates it)" to both never-synced cells, and "what Claude Code generates inside a plugin folder (`isPluginGenerated`)" to the `global-paths.ts` row.
- **Effort:** S · **Confidence:** high · New

### READ-08 · Low · Step 1 of the agent guide says plugin files are never copied

- [ ] **Where:** `docs/ADDING-AN-AGENT.md:53-54`
- **Problem:** "Extensions or plugins: reinstall them with the agent's own commands; never copy their files." Since T96 a plugin that lives in the setup's own skills folder is copied as part of that folder and reviewed on pull.
- **Fix:** "…never copy their installed files. A plugin the user keeps inside a synced folder is part of the setup: sync it, and review it on pull as one unit."
- **Effort:** S · **Confidence:** high · New (made stale by T96)

### READ-09 · Low · CONTRIBUTING's plugin-fixture entry misses one export and breaks the list's layout

- [ ] **Where:** `CONTRIBUTING.md:139-143`
- **Problem:** `claude-code-plugin-fixtures.ts` exports `PluginFilesOptions`, which the list does not name although it names the other exported type, `FakeManagedPc`. Line 142 is 120 characters where every other bullet wraps near 95, and the sentence has two "and"s.
- **Fix:** Re-wrap and write: "plugin files (`installedPluginsFile`, `putJson`, `realisticPlugins`), a plugin in the skills folder as bundle files (`pluginFiles` with `PluginFilesOptions`, `writePluginFiles`), what `claude plugin validate` says about one (`REAL_VALIDATE_REPORT`, `PROBE_MOD_VALIDATION`, `scriptedValidator`), and managed settings (…)".
- **Effort:** S · **Confidence:** high · New

### READ-10 · Low · The threat model does not record that validate's `calls:` list is static and can be incomplete

- [ ] **Where:** `docs/security/threat-model.md:55` (row 19), `:154-178` (Accepted risks)
- **Problem:** `claude plugin validate` names only the `$` methods it finds in the source (T95); a module that reaches `$` indirectly (`$['pro' + 'cess']`, passing `$` to an imported file, `eval`) is not covered, and agentnomad trusts the report. Every module is still labelled "(runs code inside Claude Code)" and needs a yes, so the control holds, but the limit is not written where the other accepted risks are.
- **Fix:** Add an accepted risk: "`claude plugin validate` lists the `$` methods a mod's source names; code that reaches them indirectly is not listed. Every module is still marked as running code inside Claude Code and needs a yes."
- **Effort:** S · **Confidence:** medium · New

### READ-11 · Low · A test title points at T104, which nothing in the repo can resolve; a neighbouring comment is stale

- [ ] **Where:** `packages/cli/test/claude-code-account-skills.test.ts:47`, `:65`; `packages/cli/src/agents/claude-code/account-skills.ts:26-27`
- **Problem:** CONTRIBUTING's rule for references is that a task number is findable with `git log --grep '^T104:'`; that returns nothing and no doc names T104. The older test at `:65` and the source comment say an entry without `creatorType` is "a newly synced skill", which T95 showed is every entry on 2.1.295.
- **Fix:** Reword the title to what is true now ("finds none on Claude Code 2.1.295, which writes no creatorType (T95): to be fixed") and update the two comments to say the field is absent on 2.1.295 and later.
- **Effort:** S · **Confidence:** high · New (title) / pre-existing comment made stale

### READ-12 · Low · `mod().slice(1)` depends on the fixture's file order

- [ ] **Where:** `packages/cli/test/claude-code-skills-dir-plugins.test.ts:113`
- **Problem:** Dropping the manifest by position ties the test to `pluginFiles` putting the manifest first, which its doc does not promise.
- **Fix:** `mod().filter((file) => !file.path.endsWith('plugin.json'))`.
- **Effort:** S · **Confidence:** high · New

### READ-13 · Low · Import layout differs from sibling test files

- [ ] **Where:** `packages/cli/test/claude-code-restore-rules.test.ts:5-12`
- **Problem:** The fixtures import comes after the `../src/index.ts` import; every other Claude Code test file in scope imports the test helpers first. No lint rule orders imports, so the formatter does not fix it.
- **Fix:** Move the fixtures import above the src import.
- **Effort:** S · **Confidence:** high · Pre-existing

### READ-14 · Low · The "no" pull test asserts less than its siblings

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:860-869`
- **Problem:** `expect(no.asked).toHaveLength(1)` where every sibling pins the question text (`toEqual(['Allow them?'])`). The `no` branch asserts nothing about the warn line or that `CLAUDE.md` was still restored, so the folder-case text `Skipped skills/my-mod/: …` is asserted in full nowhere, and "the rest is restored" is only checked under `--yes`.
- **Fix:** `expect(no.asked).toEqual(['Allow them?'])`; add the exact warn line and `expect(await readText(join(b.base, 'CLAUDE.md'))).toBe('Notes.')`.
- **Effort:** S · **Confidence:** high · New

### READ-15 · Low · The canned push note looks like real output but is not

- [ ] **Where:** `packages/cli/test/push-command.test.ts:472-474`
- **Problem:** The `note` copies the first sentence of `pluginNotes`' real output and drops the second, so a reader may take the test as pinning the wording when it is a passthrough through a fake adapter (the real wording is pinned in `claude-code-skills-dir-plugins.test.ts:176`).
- **Fix:** Use an obviously stubbed note, or make it real per QA-01.
- **Effort:** S · **Confidence:** medium · New

### READ-16 · Low · ARCHITECTURE says `system.test.ts` runs the real `claude plugin`

- [ ] **Where:** `docs/ARCHITECTURE.md:636-637`
- **Problem:** `grep "claude plugin" packages/cli/test/system.test.ts` finds nothing; the real `claude plugin` commands are covered by scripted CLIs in `claude-code-plugin-sync.test.ts` and now `claude-code-plugin-validate.test.ts`, and were run by hand against the installed Claude Code (T95, T96), never in CI.
- **Fix:** Drop `claude plugin` from that sentence, or say where the real runs happen.
- **Effort:** S · **Confidence:** high · Pre-existing

### Refactoring

### REF-01 · Low · One test asserts three behaviours

- [ ] **Where:** `packages/cli/test/claude-code-skills-dir-plugins.test.ts:121-155`
- **Problem:** "one bad manifest field hides no other, and a bad part is shown as unreadable (SEC-01)" checks a bad `hooks` field with a valid `mcpServers`, named hooks files that are missing or not JSON, and a stray item in `modules`; a failure in the third is reported under a title about manifest fields.
- **Fix:** Split into three `it`s; the first is the natural home for the `mcpServers: 42` case (QA-03).
- **Effort:** S · **Confidence:** high · New

### REF-02 · Low · One restorer test does two unrelated jobs

- [ ] **Where:** `packages/cli/test/claude-code-restorer.test.ts:803-813`
- **Problem:** "reviews runnable entries and knows the variables that redirect Claude Code" asserts the review and `isRedirectVariable` in one `it`.
- **Fix:** Split in two; the review one is where QA-02's case belongs.
- **Effort:** S · **Confidence:** high · Pre-existing

### REF-03 · Low · A 40-line pull test runs two scenarios

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:310-350`
- **Problem:** The T55 test first checks the review under `--yes`, then runs a second pull with `--allow-commands` and asserts the overwrite: a separate behaviour.
- **Fix:** Move lines 343-349 into their own `it`, sharing the `loose` setup through a small helper.
- **Effort:** S · **Confidence:** medium · Pre-existing

### Best practices

### BP-01 · Low · Three of the "pure" modules are not kept from importing `node:*`

- [ ] **Where:** `eslint.config.js:99-103`
- **Problem:** For `restore-rules.ts`, `command-review.ts` and `auto-memory.ts` the lint forbids only the file walker and dynamic import; `node:fs` or `node:child_process` would pass. The convention and the T96 docs describe these as pure, and `settings-commands.ts` and `skills-dir-plugins.ts` do get the `node:*` rule.
- **Fix:** Add `nodeModules` to that block, or merge the two blocks into one list of pure modules.
- **Effort:** S · **Confidence:** high · Pre-existing

### QA and testing

### QA-01 · Medium · The adapter's `describeCollected` wiring is covered only by the e2e run

- [ ] **Where:** `packages/cli/src/agents/claude-code/claude-code-adapter.ts:123`; `packages/cli/test/push-command.test.ts:472-478`
- **Problem:** The push test feeds a canned note through a fake adapter, so it proves push prints `info: <label>: <note>` but not that the Claude Code adapter's inspector returns `pluginNotes(files)`. Deleting line 123 fails no unit test; only `packages/e2e/src/steps.ts:320` would notice. `pluginNotes` itself is unit-tested, but nothing joins the two.
- **Why it matters:** The info line is the push half of T96's user-facing behaviour; a refactor of the inspector could drop it with every unit test green.
- **Fix:** In `pull-command.test.ts`'s `pushedMod`, pass a `recordingReporter()` to `pushFrom` and assert the real line (that test already pushes with the real adapter and a mod on disk); or one `it` in `claude-code-adapter.test.ts` calling `adapter.inspector.describeCollected({ kind: 'global' }, pluginFiles(…))`.
- **Effort:** S · **Confidence:** high · New

### QA-02 · Low · The restorer's combined `reviewRunnable` has no test in its own file, and no test mixes a settings hook with a plugin

- [ ] **Where:** `packages/cli/src/agents/claude-code/restorer.ts:228-233`; `packages/cli/test/claude-code-restorer.test.ts:43-54`, `:803-813`; `packages/cli/test/pull-command.test.ts:799-811`
- **Problem:** The only change to the restorer test was `await`. The concatenation of the T44 review and `reviewPlugins(…, options.validatePlugin)` is exercised solely through pull-command tests, against the module convention, and nothing anywhere reviews a set holding both a settings hook and a plugin, so the entry order and the warn line with a file and a folder in one list are unpinned. A regression passing `undefined` instead of `options.validatePlugin` (every mod becomes "not checked") is caught only indirectly.
- **Fix:** Add `validatePlugin?: PluginValidator` to the restorer test's `Setup` and one test with `settings.json` plus `pluginFiles(…)` expecting labels `['status line', 'plugin skills/my-mod/ module ./register.ts (runs code inside Claude Code)']` and one validator call; give `pushedMod` a `stopHook` and assert the combined warn line on a `no`.
- **Effort:** S · **Confidence:** high · New

### QA-03 · Low · Branches of `skills-dir-plugins.ts` with no test

- [ ] **Where:** `packages/cli/src/agents/claude-code/skills-dir-plugins.ts:82` (`isBundle` upper-case `.MCPB`, `HTTP://`), `:105-112` (the default hooks file named and missing, BUG-01), `:144-147` (`mcpServers` bad field: confirmed to give `unreadable: [{ label: '.claude-plugin/plugin.json mcpServers', value: 42 }]`, asserted nowhere), `:155` (a servers file named twice is read once), `:159` (a named servers file that is not JSON is listed as its name, not as unreadable: an asymmetry with hooks files worth a comment), `:176` (`modules` de-duplicated across two hooks files), `:256` (`problem.path` null), `:259` (a non-hooks content entry's look-alike note is skipped), `:335` (`|| 'nothing'` fallbacks: the test feeds literal "nothing"), `success: false` (SEC-02)
- **Why it matters:** The `mcpServers` field is the security-motivated branch; the de-duplication decides whether a mod is checked once or shown twice.
- **Fix:** One case each in the module's test file; the fixtures already support them.
- **Effort:** S · **Confidence:** high · New

### QA-04 · Low · Branches of `plugin-validate.ts` with no test

- [ ] **Where:** `packages/cli/src/agents/claude-code/plugin-validate.ts:59` (`|| \`exit code ${…}\``: the "no report" test gives a non-empty stderr), `:45`(a plugin named`.claude`, SEC-01), a timeout (UX-02); `:34-36`(the default`createProgramCli`wiring is reachable only with a real`claude`, accepted)
- **Fix:** One case in the "no report" test with empty stderr and exit code 2; one with `name: '.claude'`.
- **Effort:** S · **Confidence:** high · New

### QA-05 · Low · Pull-level cases not covered: a sibling folder with the same prefix, a project-scope plugin, declining a changed plugin, `reviewCovers` directly

- [ ] **Where:** `packages/cli/src/pull/pull-command.ts:355`; `packages/cli/src/agents/adapter.ts:129`; `packages/cli/test/pull-command.test.ts:794-886`
- **Problem:** `reviewCovers` is tested nowhere directly, and the T96 pull tests only check that `skills/my-mod/` is dropped and `CLAUDE.md` kept. Nothing checks that `skills/my-mod-2/SKILL.md` (a plain skill whose path starts with the declined folder's text) is still restored, which is exactly what `underFolder`'s `${entry}/` suffix exists for; a regression to `startsWith` would drop a neighbouring skill (SEC-01). All four pull tests are global scope and "new": no project mod in `.claude/skills/` through pull (which also exercises `projectDestination` for that folder), and no decline of a _changed_ plugin leaving this PC's copy intact.
- **Fix:** Add `skills/my-mod-2/SKILL.md` to `pushedMod` and assert it exists after a `no`; one `it` pushing `pluginFiles('.claude/skills/my-mod/', …)` from a project and pulling with `--project`; one `it` that pulls with `--allow-commands`, edits `register.ts` on PC B, pulls again answering `false`, and asserts the edit survived and the review shows `~ plugin skills/my-mod/`; a two-line direct test of `reviewCovers`.
- **Effort:** M · **Confidence:** high · New

### QA-06 · Low · "what Claude Code generated never came along" passes for a second reason

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:847-858` (assertion at `:851`)
- **Problem:** `exists(join(b.base, 'skills', 'my-mod', '.claude-plugin', 'types'))` is false both when the collector left the folder out of the bundle (what the name claims) and when it was in the bundle but the restorer refused it. If the collector regressed, this test would still pass; the first pull's warn lines (which would then hold `Refused "skills/my-mod/.claude-plugin/types/…"`) are not checked.
- **Why it matters:** The collector tests do catch that regression, so this is not an uncovered branch, but the test asserts less than its name promises.
- **Fix:** After the first pull add `expect(t.lines.filter((line) => line.startsWith('warn:'))).toEqual([])`, or decode `storedOn(server, GLOBAL_SCOPE_KEY)` and assert the bundle's paths.
- **Effort:** S · **Confidence:** high · New

## Standards to adopt

- **One probe mod.** `probeMod()` and `writeGeneratedTypes()` in `claude-code-plugin-fixtures.ts` are the only way a test gets the T95 mod; `MOD_FILES` and hand-joined `types/` paths go (DUP-01).
- **One lookup fake.** `linuxExecutables(executables)` is the only `ExecutableLookupSystem` fake; `after-restore` and `plugin-validate` tests use it, and T97 to T102 reuse it (DUP-04).
- **One JSON object schema.** `JsonObjectSchema` in `system/json.ts`; the four local copies import it (DUP-03).
- **One pure-module list in the lint config,** with the same three rules (other agent, file walker, `node:*`) for every pure module, so the docs' "pure" and the lint's "pure" mean the same (BP-01).
- **Docs tables move with the code in the same change:** the ARCHITECTURE adapter table and "What is saved" table, the README "What is synced" table, the ADDING-AN-AGENT interface steps and the CONTRIBUTING helper list (READ-01, READ-06 to READ-09). T96 updated the prose and the file rows but not the tables.
- **Case folding on restore is the T43 rule:** every refusal in `restore-rules.ts` ignores case; a new one does too (SEC-03).

## What will break first at scale

1. **`claude plugin validate` once per new or changed mod, one after another, up to 60 s each** (`skills-dir-plugins.ts:324-346`, `plugin-validate.ts:30`). A setup with ten new mods on a slow PC waits minutes in pull's plan step before the review appears. Running them with a small concurrency, or one validate over all plugin folders, is the fix when it bites.
2. **Pull's decline filter, files × blocked** (PERF-01, `pull-command.ts:353-356`): a large skills folder with many flagged files makes declining slow.
3. **The hand-built probe mod in five test files** (DUP-01): every change to the mod's shape (T97 to T102 will add files) is a five-file edit until the fixture exists.

## Where each finding belongs among the open tasks

Eight tasks of the plugin and mod work are still open (T97 to T104), and several of them own the ground a finding sits on. Fixing those findings now would be done twice or would conflict with the task; the rest has no owner and needs one.

| Finding                                                                                                                                                               | Belongs to                                                             | Why                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| READ-05, READ-06, READ-07, READ-08, READ-10, READ-16, UX-03                                                                                                           | **T103** (docs, threat model and cross-OS e2e for plugin and mod sync) | T103 is the planned docs pass for the whole plugin work; each of these is a table, header or help line that moves again when T97 to T102 land. Doing them in T103 writes them once.                                                               |
| READ-01                                                                                                                                                               | **T103**, but worth doing now                                          | The adapter guide misleads today (a synchronous `reviewRunnable` does not compile). A one-paragraph fix now, and T103 rereads it.                                                                                                                 |
| READ-11, DUP-05                                                                                                                                                       | **T104** (claude.ai skills backup on 2.1.295)                          | Both are the account-skills test and fixtures T104 rewrites; the T104 reference becomes resolvable the moment T104 has a commit.                                                                                                                  |
| SEC-01, UX-02, DUP-04                                                                                                                                                 | **Before T97** (local-folder marketplaces)                             | T97 and T98 reuse the validator and the `claude` runner for every restored marketplace and plugin folder: the fixed inner folder name, the surfaced timeout reason and the shared lookup fake should be in place before more code builds on them. |
| READ-02                                                                                                                                                               | **The next drift task** (T94's successor)                              | `reviewedVersion` moves when the changelog entries 2.1.293 to 2.1.295 are read, which is a drift review, not a plugin task. T102 reads the changelog for the 2.1.287 mod minimum and could do it.                                                 |
| "What will break first" item 1 (sequential validates) and "Not reviewed" item 2 (no real `claude plugin validate` in CI)                                              | **T103**                                                               | Its cross-OS e2e for plugin and mod sync is the place to decide whether a CI runner gets a real `claude`, and a setup with several mods would show the sequential cost.                                                                           |
| BUG-01, SEC-02, SEC-03, PERF-01, UX-01, QA-01 to QA-06, DUP-01, DUP-02, DUP-03, DUP-06, READ-03, READ-04, READ-12, READ-13, READ-14, READ-15, REF-01 to REF-03, BP-01 | **No owner: a new task**                                               | These are fixes to T95 and T96 as merged, and the repo's practice is one task per review's fixes (T43 to T93). They should land before T97 builds on `skills-dir-plugins.ts` and the review, so that T97 starts from the fixed reader.            |

The order of work below follows this: the unowned fixes first (batches 1 to 7), the T103 and T104 items left to their tasks, with READ-01 pulled forward.

## Suggested order of work

1. **BUG-01, SEC-02, READ-03, QA-03** — the plugin reader: fix the silent drop and the report shape, remove the unreachable branch, and add the branch tests in one change to `skills-dir-plugins.ts` and its test.
2. **SEC-01, UX-02, QA-04** — the validator: a fixed inner folder name, the lost reason, and the two tests.
3. **SEC-03** — case-insensitive refusal on restore, with the table cases.
4. **PERF-01, UX-01, QA-05, QA-06, READ-14, DUP-06, REF-03** — pull's decline path and its tests.
5. **QA-01, QA-02, READ-15, REF-02** — the wiring tests: the adapter's note and the restorer's combined review in their own files.
6. **DUP-01, DUP-04, READ-12, REF-01** — the test fixtures: one probe mod, one lookup fake (DUP-05 waits for T104, which rewrites those fixtures).
7. **DUP-02, DUP-03, BP-01, READ-04** — source and lint consolidation.
8. **READ-01 now; READ-05 to READ-08, READ-10, READ-16, UX-03 in T103; READ-11 in T104; READ-02 in the next drift task** — docs, comments and help text, each where the table above puts it.

## Not reviewed

- Files outside the diff were opened for context, not reviewed (the adapter's other modules, `cli/program.ts`, the test helpers in `fakes.ts`). UX-03 is in `program.ts` because the flag's meaning changed; it is not in the ledger.
- The real `claude plugin validate` process path (`plugin-validate.ts` with a real `claude`) runs in no automated check: the e2e PCs have no `claude`, so the e2e exercises the "not checked" branch, and the unit tests use a scripted CLI with the real 2.1.295 report as a fixture. It was run by hand against the installed Claude Code 2.1.295 during T96 on a working mod and a broken one.
- No binaries or assets are in scope.
