# Code Review — Agent Nomad — 2026-10-09 (review 17)

**Scope:** the same change set as reviews 15 and 16 after the 37 review-16 fixes: everything T95, T96, the review-15 fixes and the review-16 fixes changed. The diff `30eb20f..ee2f8d5` on branch `review-reports`, 51 files (the 44 of review 16 plus the 7 the fixes reached: `bundle-paths.ts`, `env-files.ts`, `file-gathering.ts`, `adapter.test.ts`, `claude-code-after-restore.test.ts`, `claude-code-managed-settings.test.ts`, `env.test.ts`), read in full.
**Stack:** pnpm monorepo, TypeScript strict, Node 22.13 or newer. Packages: `contracts` (Zod schemas), `core` (encryption, bundle format, merge), `cli` (the `agentnomad` command), `server`, `e2e`. Tests with Vitest.
**Coverage:** 51 of 51 files read in full, 15,013 lines. See `files.md` for one row per file.
**Checks run:** type check pass · lint pass · format check pass · tests pass (1,458 passed, 12 skipped, 83 files) · `pnpm knip` pass · e2e pass (15 tests, one machine) · import cycles: **one** (`madge --circular`, see ARCH-01) · `pnpm audit --prod` not re-run this round (passed earlier today at `018324d`; no dependency changed since) · CI on `ee2f8d5` not checked at the time of writing.

**How it was done:** four reviewers each read one part of the scope line by line (the adapter source; the commands, e2e step and docs; the plugin, fixture, after-restore and managed-settings tests; the command, collector, account-skills and env tests), checked every review-16 fix in their files, and confirmed each finding at exact lines, running the behavioural ones. The orchestrator re-confirmed every one of the 51 findings the reviewers returned: the behavioural claims were re-run against the built package (`packages/cli/dist`), the rest re-read at the quoted lines or re-grepped, and each was checked against `30eb20f` for whether it is new or pre-existing. Five pairs reported by two reviewers were merged, the orchestrator's own cross-file pass (import graph, transitive `node:*` reach of the pure modules) added two, and one test-shape finding was re-filed as QA. Nothing a reviewer reported was dropped as unconfirmed.

## Summary

The 37 review-16 fixes are in place and 34 of them are correct and complete. Three left something behind, and those are the findings to read first: the env-scan fix reads a plugin's `.mcp.json` and manifest but still drops a manifest `mcpServers` **array** and any file the manifest names (BUG-01), and it created the one import cycle in the CLI package, `env-files → skills-dir-plugins → command-review → env-files` (ARCH-01); and the pure-module fix moved the home-folder rules out of the file walker but `restore-rules.ts` still reaches `node:fs` through its import of `account-skills.ts`, while the new comment says it does not (ARCH-02). The remaining 12 new points are small: a stale comment the UX-03 fix stacked on top of the old one, four comment lines over the width the same commit fixed elsewhere, a test moved as-is instead of into a table, a doc pairing that names the wrong test, and one message label the new env test pins at its less useful wording.

This round found no Critical, no High, 5 Medium and 41 Low. The other three Medium findings are test gaps in files the fixes brought into scope for the first time: the one test of the managed-settings wiring in after-restore cannot fail (QA-01), and the agent and scope choosers of pull and push, with their seven error messages each, run in no test (QA-02, QA-03). Thirty-one of the 46 findings are pre-existing and were only seen because those files were now read whole.

Nothing found blocks merging the review branch into `dev`; the cycle is harmless today (a hoisted function is the only thing crossing it) and BUG-01 is a missing offer to save a value, not a wrong write.

## Scores

| Area                         | Score /10 | One-line reason                                                                                                                                    |
| ---------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness                  | 9         | One Medium gap left by a fix (the env scan and manifest arrays); one Low design point on a changed plugin's per-file conflicts.                    |
| Security                     | 9         | No security finding; the pure-module guarantee is still direct-import only (ARCH-02).                                                              |
| Performance                  | 9         | Two Low pre-existing points: three stats per walked file, a Zod schema built per hook group.                                                       |
| User experience              | 9         | Two Low wording points: a plugin `.mcp.json` labelled by path, pull's `--agent` message with no next step.                                         |
| Readability                  | 8         | Thirteen Low points, four of them left by the fix commit (long lines, a stacked comment, a wrong doc pairing).                                     |
| Maintainability              | 8         | Four duplications and one refactoring item, mostly test set-up repeated across files.                                                              |
| Architecture and scalability | 8         | Boundary holds and the data file is read through its views, but one import cycle and one pure module reaching `node:fs` transitively.              |
| Test coverage                | 7         | Every review-16 fix is pinned; three Medium gaps in files first read this round (a test that cannot fail, the choosers of pull and push untested). |

| Category             | Critical | High  | Medium | Low    |
| -------------------- | -------- | ----- | ------ | ------ |
| Bugs                 | 0        | 0     | 1      | 1      |
| Security             | 0        | 0     | 0      | 0      |
| Database and queries | 0        | 0     | 0      | 0      |
| Performance          | 0        | 0     | 0      | 2      |
| User experience      | 0        | 0     | 0      | 2      |
| Dead code            | 0        | 0     | 0      | 3      |
| Duplication          | 0        | 0     | 0      | 4      |
| Readability          | 0        | 0     | 0      | 13     |
| Refactoring          | 0        | 0     | 0      | 1      |
| Best practices       | 0        | 0     | 0      | 2      |
| System design        | 0        | 0     | 1      | 1      |
| SOLID and OOP        | 0        | 0     | 0      | 0      |
| QA and testing       | 0        | 0     | 3      | 12     |
| **Total**            | **0**    | **0** | **5**  | **41** |

## Fix first

1. **ARCH-01** · Medium · the env-scan fix created the CLI's one import cycle (`env-files → skills-dir-plugins → command-review → env-files`).
2. **BUG-01** · Medium · the env scan still drops `${VAR}` in a manifest `mcpServers` array and in a file the manifest names.
3. **ARCH-02** · Low · `restore-rules.ts` still reaches `node:fs` through `account-skills.ts`; the new comment says no pure module does.
4. **QA-01** · Medium · the after-restore "blocked by the injected managed settings" test passes with no injection.
5. **QA-02, QA-03** · Medium · pull's and push's agent and scope choosers, and seven error messages each, run in no test.
6. **UX-01** · Low · a wrapper-less plugin `.mcp.json` is labelled by path, not `MCP server <name>`, and the new test pins that.
7. **READ-01, READ-02** · Low · four comment lines over 100 columns and a stacked doc comment, both left by the fix commit.
8. **READ-03** · Low · ARCHITECTURE's new "covered through their callers" bullet pairs `cli/project-folder.ts` with a test that cannot reach it.
9. **BUG-02** · Low · a yes to a changed plugin can still be split by per-file conflict questions (medium confidence).
10. **BP-02, QA-04, QA-14, QA-15** · Low · the moved `reviewCovers` test is not a table; `isPluginMcpSource`, the array case and the new help text are unpinned.

## Findings

### Bugs

### BUG-01 · Medium · The env scan still drops `${VAR}` in a manifest `mcpServers` array and in a file the manifest names

- [ ] **Where:** `packages/cli/src/env/env-references.ts:68-81` (`JsonObjectSchema.safeParse(json['mcpServers'])`, then `rest` built without the key whatever its shape); `packages/cli/src/agents/claude-code/skills-dir-plugins.ts:44-53` (`isPluginMcpSource` knows the default file and the manifest only)
- **Problem:** The review-16 BUG-01 fix made the scan read a plugin's `.mcp.json` and manifest, but the scan takes `mcpServers` only when it is an object and removes the key from `rest` even when it is not, so a manifest declaring `mcpServers: ['./servers.json', { inline: {…} }]` (a shape the manifest reference allows and `ServersFieldSchema` accepts) loses its inline servers' references; `./servers.json` itself is not a path the rule knows. Confirmed against the built package: a manifest with that array, a `servers.json` with `${T_NAMED_FILE}`, a plugin `.mcp.json` with `${T_BARE}` and a root `.mcp.json` with `${T_ROOT}` scan to `T_BARE` and `T_ROOT` only.
- **Why it matters:** The review-16 finding was that push offers to save nothing for a plugin's servers while pull's review shows them; for the array shape and named files that is still true.
- **Fix:** Keep the key in `rest` when it is not an object (`const rest = servers.success ? withoutServers : json`), or walk an array's object items as servers. For named files, either let `isMcpFile` accept any `*.json` under a plugin folder, or say in ADDING-AN-AGENT `:245-250` and ARCHITECTURE `:326`, `:808` that only the default file and the manifest are read. Add the array case to `env.test.ts` (QA-14).
- **Effort:** S
- **Confidence:** high

### BUG-02 · Low · A yes to a changed plugin can still be split by per-file conflict questions

- [ ] **Where:** `packages/cli/src/pull/pull-command.ts:389` (`for (const conflict of adapter.restorer.conflicts(files, current))`), `packages/cli/src/agents/claude-code/restorer.ts:243-266` (`conflicts` has no rule for a plugin folder)
- **Problem:** The review asks about a plugin as one unit ("a plugin is accepted or left out as a whole", pinned at `pull-command.test.ts:912`). After a yes to a changed mod, each differing file of the folder is still asked about on its own as a conflict (`register.ts already exists here and is different`); a `skip` on one of them leaves the new manifest and hooks file next to the old module, so what `claude plugin validate` checked is not what runs. Reasoned from the code; no test runs the yes-to-a-changed-mod path (QA-10).
- **Why it matters:** The promise the review line makes is about the folder; the conflict step does not know the folder.
- **Fix:** Decide the rule and pin it: either the conflict step treats the files of a reviewed plugin folder as one question (overwrite or skip the folder), or the review line says a changed plugin's differing files are asked about one by one.
- **Effort:** M
- **Confidence:** medium (not run; check with a pull answering `[true, 'skip']` on a changed mod)

### Performance

### PERF-01 · Low · The walker stats every file three times

- [ ] **Where:** `packages/cli/src/agents/shared/file-gathering.ts:144` (`walk`), `:110` (`readIfFile`), `:99` (`fileEntry`), plus `realpath` at `:76`
- **Problem:** `walk` stats to tell a folder from a file, `readIfFile` stats again for `isFile()`, `fileEntry` stats a third time for size and mode. Pre-existing; the shape review 16 PERF-01 fixed in the restorer.
- **Fix:** Pass the `Stats` the walk already has into an internal `readEntry(nativePath, bundlePath, info)` that `readIfFile` also uses after its one stat.
- **Effort:** S
- **Confidence:** high

### PERF-02 · Low · A Zod schema is built per hook group inside the loop

- [ ] **Where:** `packages/cli/src/agents/claude-code/settings-commands.ts:43` (`z.looseObject({ hooks: z.array(z.unknown()).optional() }).safeParse(group)`)
- **Problem:** Its siblings `HookSchema` and `HookCommandSchema` (`:11-17`) are module constants. Pre-existing.
- **Fix:** Hoist to `const HookGroupSchema = …`.
- **Effort:** S
- **Confidence:** high

### User experience

### UX-01 · Low · A wrapper-less plugin `.mcp.json` labels its variables by file, not by server

- [ ] **Where:** `packages/cli/src/env/env-references.ts:68-81` vs `packages/cli/src/agents/claude-code/skills-dir-plugins.ts:103-105` (`serversIn`); pinned at `packages/cli/test/env.test.ts:109`
- **Problem:** The plugin review reads a file without the `mcpServers` wrapper as the server map; the env scan reads it through `rest`, so `agentnomad env` shows `skills/gh/.mcp.json` for one file and `MCP server p (.claude/skills/p/.mcp.json)` for another that differs only by the wrapper. The review-16 BUG-01 test pins the less useful label. Confirmed by probe: `T_BARE → ['skills/gh/.mcp.json']`, `T_ROOT → ['MCP server root (.mcp.json)']`.
- **Fix:** When `isMcpFile(path)` is true and the file has no `mcpServers` key, treat the whole object as the server map (share `serversIn`); the test then expects `MCP server gh (skills/gh/.mcp.json)`.
- **Effort:** S
- **Confidence:** high

### UX-02 · Low · Pull's `--agent` message names no next step, unlike push's

- [ ] **Where:** `packages/cli/src/pull/pull-command.ts:136` (`No saved setup for agent "${id}".`); `packages/cli/src/push/push-command.ts:136` (`Unknown agent "${id}". Run \`agentnomad agents\` to see the supported ones.`)
- **Problem:** Pull cannot tell an unknown id from a known agent with nothing saved, and gives no command to run. Pre-existing.
- **Fix:** `No saved setup for agent "${id}". Run \`agentnomad list\` to see what is saved, or \`agentnomad agents\` for the supported ids.`
- **Effort:** S
- **Confidence:** high

### Dead code

### DEAD-01 · Low · A name check that can never decide

- [ ] **Where:** `packages/cli/src/agents/claude-code/account-skills.ts:35-40` (`!name.toLowerCase().startsWith('anthropic-skills:')`)
- **Problem:** `SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/` admits no `:`, so any name reaching that term has already failed the regex (`SKILL_NAME.test('anthropic-skills:x')` is `false`). Pre-existing.
- **Fix:** Drop the term, or explain the prefix in `RESERVED_NAMES`' comment.
- **Effort:** S
- **Confidence:** high

### DEAD-02 · Low · `pushFrom`'s `prompter` option and `keysOf`'s parameter are never passed

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:89` (`prompter?: Prompter`, used at `:96`), `:152` (`const keysOf = (secrets = loggedIn()) => …`, one call as `keysOf()` at `:518`)
- **Problem:** Every `prompter:` in the file goes to `pullOn`; `keysOf` takes no argument anywhere. Pre-existing.
- **Fix:** Drop the option; make `keysOf` a constant (see DUP-04).
- **Effort:** S
- **Confidence:** high

### DEAD-03 · Low · `adapter()`'s `installed` parameter in the env-command tests is never used

- [ ] **Where:** `packages/cli/test/env.test.ts:625-640` (`installed = true`), the one call at `:647`
- **Problem:** The `installed: false` branch of `createEnvCommand` is untested while the helper reads as if it covers it. Pre-existing.
- **Fix:** Add `it('leaves out an agent that is not installed here')` passing `false`, or drop the parameter.
- **Effort:** S
- **Confidence:** high

### Duplication

### DUP-01 · Low · The two lifted restorer helpers select and decode the settings files the same way

- [ ] **Where:** `packages/cli/src/agents/claude-code/restorer.ts:159-161` (`allowedScriptsOf`), `:180-181` (`otherOsWarnings`)
- **Problem:** `incoming.filter((entry) => settingsFilesOf(target).includes(entry.path))` then `new TextDecoder().decode(entry.content)` in both, created by the review-16 REF-01 lift.
- **Fix:** One `settingsTextsOf(target, incoming)` used by both.
- **Effort:** S
- **Confidence:** high

### DUP-02 · Low · The project-folder refusal block is written twice

- [ ] **Where:** `packages/cli/src/pull/pull-command.ts:162-172`; `packages/cli/src/push/push-command.ts:161-171` (identical but for the comment's wording); also `createPathResolver({ os: sourceOsOf(deps.platform), homeDir: deps.homedir })` at `pull:327` and `push:322`
- **Problem:** Eleven lines per command; `env/env-command.ts`, the third importer of `projectFolderRefusal`, would copy them next. Pre-existing.
- **Fix:** `projectFolderRefusalFor(deps, agent, options)` in `cli/project-folder.ts`, throwing `ProjectFolderError` when `--project` is set.
- **Effort:** S
- **Confidence:** high

### DUP-03 · Low · `blockedByPolicy` re-spells the fixtures' `fileManagedSettings`

- [ ] **Where:** `packages/cli/test/claude-code-after-restore.test.ts:22-27`; `packages/cli/test/claude-code-plugin-fixtures.ts:102-107`
- **Problem:** Same source and `restrictsPlugins`; the keys differ only by `allowedMcpServers`. `claude-code-managed-settings.test.ts:174` already imports the fixture for the same purpose. Pre-existing.
- **Fix:** Import `fileManagedSettings` and delete the local (QA-01 uses its `where`).
- **Effort:** S
- **Confidence:** high

### DUP-04 · Low · The logged-in secret store and the keys object are built in five test files

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:63`, `:152`; `packages/cli/test/push-command.test.ts:55`, `:557`, `:581`; `packages/cli/test/agent-boundary.test.ts:199`; `packages/cli/test/setup-commands.test.ts:91`; `packages/cli/test/auth-commands.test.ts:803`
- **Problem:** `memorySecretStore({ loggedIn: dataKey })` as a one-liner in five files, two under different signatures; `{ secrets, crypto, dataKey }` as a helper once and inline twice. `fakes.ts` already owns `memorySecretStore`, `crypto` and `dataKey`. Pre-existing.
- **Fix:** `loggedInStore(key = dataKey)` and `sessionKeys(secrets = loggedInStore())` in `fakes.ts`; list both in CONTRIBUTING.
- **Effort:** S
- **Confidence:** high

### Readability

### READ-01 · Low · Comment and doc lines over the 100-column width, added by the fix commit

- [ ] **Where:** `packages/cli/src/agents/adapter.ts:139` (106 columns), `packages/cli/src/agents/claude-code/global-paths.ts:9` (115), `packages/cli/src/agents/claude-code/managed-settings.ts:176` (110), `packages/cli/src/agents/claude-code/restorer.ts:209` (120); `docs/ADDING-AN-AGENT.md:246` (104, a bullet among bullets wrapped near 95)
- **Problem:** The shape review 16 READ-10 fixed, added back by the same commit (`.prettierrc` `printWidth: 100`; Prettier does not rewrap comments or prose).
- **Fix:** Rewrap the five lines.
- **Effort:** S
- **Confidence:** high

### READ-02 · Low · A stale doc comment left stacked above `POLICY_WORDS`

- [ ] **Where:** `packages/cli/src/agents/claude-code/managed-settings.ts:172-173`
- **Problem:** `/** Words Claude Code uses when a plugin install is refused by policy. */` (the old one) directly followed by `/** Words that name the organization's policy itself. */` (the new one); only the second is the doc.
- **Fix:** Delete line 172.
- **Effort:** S
- **Confidence:** high

### READ-03 · Low · ARCHITECTURE pairs `cli/project-folder.ts` with a test that cannot reach it

- [ ] **Where:** `docs/ARCHITECTURE.md:657` (`cli/flags.ts` and `cli/project-folder.ts` (`program.test.ts`))
- **Problem:** `program.ts` imports `flags.ts` but not `project-folder.ts`, whose importers are the pull, push and env commands; `program.test.ts` has no `ProjectFolder` mention. The bullet is the review-16 READ-03 fix, whose point is telling a reader where a module is covered.
- **Fix:** "`cli/flags.ts` (`program.test.ts`), `cli/project-folder.ts` (the push, pull and env command tests)".
- **Effort:** S
- **Confidence:** high

### READ-04 · Low · The "covered through their callers" bullet still leaves one module out

- [ ] **Where:** `docs/ARCHITECTURE.md:654-659`; `CONTRIBUTING.md:168-170`
- **Problem:** `agents/claude-code/reviewed-settings.ts` has no test file named after it, falls under none of the four groups, and is covered through `claude-code-command-review.test.ts` and `claude-code-drift.test.ts`.
- **Fix:** Add it to the bullet.
- **Effort:** S
- **Confidence:** medium (the module is covered; the doc's rule says it must be listed)

### READ-05 · Low · The reserved-entries table says home files come back "only if the setup's own hooks run them"

- [ ] **Where:** `docs/ARCHITECTURE.md:187`; `packages/cli/src/agents/claude-code/restore-rules.ts:73` (`TOOL_CONFIG_PATHS.has(relative) || allowedScripts.has(…)`)
- **Problem:** A known tool's settings file is restored whether or not a hook runs it, as the same document says at `:374-375`. Pre-existing.
- **Fix:** "Written back to the home folder: a script only if the setup's own hooks or status line run it, a tool's settings file when it is one of the known ones."
- **Effort:** S
- **Confidence:** high

### READ-06 · Low · CONTRIBUTING says the e2e run has "three simulated PCs"; there are four

- [ ] **Where:** `CONTRIBUTING.md:33`; `packages/e2e/src/steps.ts` (`newPc` four times, the fourth a stale PC)
- **Problem:** ARCHITECTURE `:563` counts the stale PC; CONTRIBUTING does not. Pre-existing.
- **Fix:** "(three steps on four simulated PCs)".
- **Effort:** S
- **Confidence:** high

### READ-07 · Low · `yesOption` is an arrow constant among `function` siblings

- [ ] **Where:** `packages/cli/src/cli/program.ts:86`
- **Problem:** The four other option builders are function declarations with a JSDoc line; this one is the only arrow and the only one without a comment. Pre-existing.
- **Fix:** A documented `function yesOption()`.
- **Effort:** S
- **Confidence:** high

### READ-08 · Low · Aliases, shadowed constants and a magic count in the skills-dir tests

- [ ] **Where:** `packages/cli/test/claude-code-skills-dir-plugins.test.ts:14-15` (`const MOD = PROBE_MOD_FOLDER; const mod = probeMod;`), `:258-259` (`stop` and `docs` redefined inside an `it`, identical to the describe-level ones), `:45` (`toHaveLength(5)`)
- **Problem:** Two names for each fixture; the inner constants shadow the outer ones; `5` is manifest, hooks file, two modules and `.mcp.json`, which nothing says.
- **Fix:** Use the fixture names directly; delete the inner constants; assert the five paths.
- **Effort:** S
- **Confidence:** high

### READ-09 · Low · `const system = fakeExecutables` hides the shared fake under a local name in two files

- [ ] **Where:** `packages/cli/test/claude-code-plugin-validate.test.ts:19`; `packages/cli/test/claude-code-after-restore.test.ts:55-56`
- **Problem:** Every call site reads `system([...])`, so a grep for `fakeExecutables(` misses them, which is how review 16 DUP-03 happened.
- **Fix:** Call `fakeExecutables([...])` at the sites.
- **Effort:** S
- **Confidence:** medium (style)

### READ-10 · Low · The fake managed PC's base folder is a hidden constant retyped three times

- [ ] **Where:** `packages/cli/test/claude-code-plugin-fixtures.ts:93` (`baseDir: … '/home/a/.claude'`); `packages/cli/test/claude-code-managed-settings.test.ts:134`, `:144`, `:167` (`'/home/a/.claude/remote-settings.json'`)
- **Problem:** The remote-cache tests depend on a folder the fixture hard-codes and does not export. Pre-existing.
- **Fix:** Export a `remoteSettingsFile(platform)` helper from the fixtures.
- **Effort:** S
- **Confidence:** high

### READ-11 · Low · `isPluginGenerated` tests sit under "paths data file", but the function lives in `global-paths.ts`

- [ ] **Where:** `packages/cli/test/claude-code-paths-data.test.ts:14`, `:22-44`; `packages/cli/src/agents/claude-code/global-paths.ts:96-108`; `docs/ARCHITECTURE.md:654-658` (lists `global-paths.ts` as covered through callers)
- **Problem:** The `describe` and the file name say the data file; the doc says the module has no direct test while this file tests it directly. Pre-existing.
- **Fix:** A `describe('global-paths: …')` in this file and a sentence in ARCHITECTURE, or a `claude-code-global-paths.test.ts`.
- **Effort:** S
- **Confidence:** medium

### READ-12 · Low · A title promises a link case the test does not set up

- [ ] **Where:** `packages/cli/test/claude-code-global-collector.test.ts:116-122` ("never takes skills/synced/, even through a link or a hook")
- **Problem:** The body writes two plain files and a hook; there is no `linkFolder` call. Pre-existing (T91).
- **Fix:** Drop "through a link", or add the link under `describe.runIf(posix)` and pin what the collector does with it.
- **Effort:** S
- **Confidence:** high

### READ-13 · Low · Imports out of the sibling order in five source files and two test files

- [ ] **Where:** `packages/cli/src/agents/claude-code/claude-code-adapter.ts:5`, `:24`; `command-review.ts:5`, `:15-20`; `plugin-validate.ts:10`; `global-collector.ts:10-11`; `restorer.ts:24-41`; `packages/cli/test/env.test.ts:16-45`; `packages/cli/test/pull-command.test.ts:38-59`
- **Problem:** The prevailing shape (externals, blank line, internals sorted by path) is not followed in these; review 16 READ-10 treated one such import as a finding. No lint rule orders imports. Pre-existing.
- **Fix:** Reorder, or add an import-order rule so it is never a review item again.
- **Effort:** S
- **Confidence:** medium (convention, not a rule)

### Refactoring

### REF-01 · Low · `it`s that run a second scenario after the first

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:941-968` (the project-mod test the review-16 QA-01 fix rewrote: a `--yes` pull, then an `--allow-commands` pull, the exact shape REF-03 split for its global twins), `:421-429`, `:466-486`, `:534-560`, `:665-686`; `packages/cli/test/push-command.test.ts:301-314`; `packages/cli/test/claude-code-account-skills.test.ts:204-212`, `:214-227`; `packages/cli/test/env.test.ts:512-561` (one test for the three cases that `:563-593` splits into three), `:160-167`; `packages/cli/test/claude-code-skills-dir-plugins.test.ts:88-96`, `:153-178`, `:180-203` (two finding IDs in one `it`), `:273-278`, `:299-306`; `packages/cli/test/claude-code-restorer.test.ts:674-697`, `:812-826`; `packages/cli/test/claude-code-adapter.test.ts:97-106`, `:123-150`
- **Problem:** CONTRIBUTING asks for one behaviour per test; a failure in the second half reports under the first half's title. Reviews 15 and 16 each split some; these remain, and the project-mod test gained a second pull instead of a split.
- **Fix:** Split the project-mod test (`pushedProjectMod()` like `pushedMod()`) and the T56 env test now; the rest when touched (`it.each` fits the skills-dir pairs).
- **Effort:** S per test
- **Confidence:** high

### Best practices

### BP-01 · Low · Per-call array spreads in the destination rules

- [ ] **Where:** `packages/cli/src/agents/claude-code/restore-rules.ts:105` (`[...GLOBAL_FOLDERS, ...GLOBAL_MEMORY_FOLDERS].some(…)`), `:137` (`[...PROJECT_CLAUDE_FOLDERS, ...PROJECT_MEMORY_FOLDERS]`)
- **Problem:** Both destination functions rebuild the list on every call (one per bundle entry), against the lookup-table convention review 16 DUP-01 applied two lines up. Pre-existing.
- **Fix:** Two module constants.
- **Effort:** S
- **Confidence:** high

### BP-02 · Low · The `reviewCovers` rule test is five `expect`s, not a table

- [ ] **Where:** `packages/cli/test/adapter.test.ts:10-17`
- **Problem:** CONTRIBUTING asks for table tests for rules; the review-16 BP-03 move copied the `it` unchanged.
- **Fix:** `it.each([[file, path, expected], …])`.
- **Effort:** S
- **Confidence:** medium

### System design

### ARCH-01 · Medium · The env-scan fix introduced an import cycle

- [ ] **Where:** `packages/cli/src/agents/claude-code/env-files.ts:4` (`import { isPluginMcpSource } from './skills-dir-plugins.ts'`) → `skills-dir-plugins.ts:11` (`from './command-review.ts'`) → `command-review.ts:7` (`import { MCP_FILES, SETTINGS_FILES } from './env-files.ts'`)
- **Problem:** Before the fix `env-files.ts` imported only the two path views; review 16's header states "import cycles none", which is no longer true (`madge --circular` reports exactly this one). It is harmless today only because `isPluginMcpSource` is a hoisted function declaration; the first `const` export added to the loop would throw at module evaluation.
- **Why it matters:** The pure modules are the ones the lint block protects most carefully; a cycle among them breaks silently at load time, and the review's own invariant is gone.
- **Fix:** Move the plugin path rules (`PLUGIN_FOLDER`, `pluginFolderOf`, `MANIFEST_PATH`, `DEFAULT_MCP_PATH`, `isPluginMcpSource`) into `global-paths.ts` next to `isPluginGenerated` (path rules, no file access); `skills-dir-plugins.ts` and `env-files.ts` import them from there. Add a cycle check to `pnpm check` (a short script over `packages/cli/src`).
- **Effort:** S
- **Confidence:** high

### ARCH-02 · Low · `restore-rules.ts` still reaches `node:fs` through `account-skills.ts`, and the new pure home is not lint-covered

- [ ] **Where:** `packages/cli/src/agents/claude-code/restore-rules.ts:28` (`import { ACCOUNT_SKILLS_PREFIX } from './account-skills.ts'`), `account-skills.ts:1` (`node:fs/promises`); `packages/cli/src/agents/shared/bundle-paths.ts:2-4` ("so no pure module reaches `node:fs` through them"); `eslint.config.js:105-114`
- **Problem:** Review 16 ARCH-01 closed the path through `global-paths.ts`, but a reachability pass over the import graph shows `restore-rules.ts → account-skills.ts → node:fs/promises` (the other three pure modules reach no `node:*`). The import is pre-existing; the comment that declares the problem closed is new. `bundle-paths.ts`, now described as the pure modules' helper, sits outside the pure lint block.
- **Fix:** Move `ACCOUNT_SKILLS_PREFIX` (and `ACCOUNT_SKILLS_PART`) to `global-paths.ts` next to the other reserved bundle paths and import them from there in `account-skills.ts`, `restore-rules.ts`, `global-collector.ts` and `claude-code-adapter.ts`; add `bundle-paths.ts` to the pure lint block; make the comment say what is true.
- **Effort:** S
- **Confidence:** high

### QA and testing

### QA-01 · Medium · The "injected managed settings" plugin-failure test passes with no injection

- [ ] **Where:** `packages/cli/test/claude-code-after-restore.test.ts:182-199`; `packages/cli/src/agents/claude-code/managed-settings.ts:174-185`
- **Problem:** The fake `claude` answers `…: blocked by policy`; `policy` is in `POLICY_WORDS`, which rewrites the reason whatever `found` is, and the test asserts only the generic sentence (`toContain("blocked by your organization's Claude Code policy")`). With `managed: undefined`, or with `deps.managedSettings()` removed from `after-restore.ts:94`, the test stays green. It is the only test of the `explainFailure: (reason) => explainPluginFailure(reason, managed)` wiring. Pre-existing; after review 16's UX-03 the parenthesised source is the one observable of the injection, and it is what the test does not look at.
- **Fix:** Assert the source too (`… policy (/etc/claude-code/managed-settings.json)`), or use a stderr with only a generic word (`… is blocked`) so the sentence appears only when `managed` is set; use `fileManagedSettings` (DUP-03).
- **Effort:** S
- **Confidence:** high

### QA-02 · Medium · Pull's agent and scope choosers and their error messages run in no test

- [ ] **Where:** `packages/cli/src/pull/pull-command.ts:136` (`No saved setup for agent "${id}".`), `:144-152` ("Which agents?"), `:194-198` ("what to restore?"), `:203` (`There is no saved … global setup.`), `:219-231` ("Which project?" with the `saved from this folder` hint), `:321-322` (`versionNotice` warning), `:437` (`None of the saved setups are for an agent agentnomad supports here.`)
- **Problem:** Each string has zero hits in the test files (the `Which agents?`/`Which project?` hits in `no-terminal-prompter.test.ts` and `program.test.ts` are the no-terminal error path); `multiselect` appears nowhere in `pull-command.test.ts`; every pull test saves one project and registers one agent. Pre-existing.
- **Why it matters:** The two-project chooser is the path every user with two saved projects takes; the messages are what a user reads after a typo in `--agent` or a `--global` with only projects saved (UX-02 is one such drift).
- **Fix:** Push two projects from two folders and pull without `--project` in the second, answering by `scopeKey`; an `it.each` over the three messages; one test with two fake adapters answering the multiselect; one with `versionNotice` returning a string.
- **Effort:** M
- **Confidence:** high

### QA-03 · Medium · Push's agent chooser, name validation, part messages and skip notices run in no test

- [ ] **Where:** `packages/cli/src/push/push-command.ts:136` (`Unknown agent "${id}"…`), `:139` (`… is not installed on this PC.`), `:147-155` ("Which agents?"), `:195-201` (the project-name `validate` and the `basename(deps.cwd)` fallback), `:263` (`part.unreadable(found.problem)`), `:269` (`part.noneFound`), `:298` (`${describe(item)}: left out` from `onSkipped`), `:309` (`Nothing to save for the …`), `:385` (`No supported agent is installed on this PC…`)
- **Problem:** Zero hits for each in the test files; `collectingAdapter`'s `collect` never calls `onSkipped`; every project-name answer is valid and non-empty; `agent-boundary.test.ts:109-110` defines `unreadable` and `noneFound` for its part but asserts neither. Pre-existing.
- **Why it matters:** "Nothing to save" and "left out" are the two messages a user sees most on a fresh PC or with a large file in a skill; the name validation is the one place push turns typing into a scope key.
- **Fix:** An `it.each` for the three agent errors; `collectingAdapter({ global: [] })` pinning `Nothing to save`; a collector calling `onSkipped` pinning `left out`; answers `['project', 'bad name!', 'ok-name', false]` pinning one rejection and the saved name, and `''` → `basename`; a part whose `available()` returns a problem.
- **Effort:** M
- **Confidence:** high

### QA-04 · Low · `isPluginMcpSource` has no test in its module's file and its negatives are unpinned

- [ ] **Where:** `packages/cli/src/agents/claude-code/skills-dir-plugins.ts:48-53`; `packages/cli/test/claude-code-skills-dir-plugins.test.ts` (no occurrence)
- **Problem:** Reached only through `env.test.ts:92-116` with three positives and one unrelated negative. Unpinned: `skills/synced/.mcp.json` → false, `skills/gh/servers.json` → false, `skills/gh/hooks/hooks.json` → false.
- **Fix:** An `it.each` over those paths in the module's test file (or in `claude-code-paths-data.test.ts` if the rule moves with ARCH-01).
- **Effort:** S
- **Confidence:** high

### QA-05 · Low · The validator's default `cli` and the 60 s timeout are never exercised

- [ ] **Where:** `packages/cli/src/agents/claude-code/plugin-validate.ts:30`, `:50-52`; every `createPluginValidator` call in `packages/cli/test/claude-code-plugin-validate.test.ts` passes `cli`
- **Problem:** The `'it did not finish within 60 seconds'` table row is a scripted string, not the timeout's result; the branch that builds the real `ProgramCli` runs in no test. `createProgramCli` already takes `start?: StartProgram`. Pre-existing.
- **Fix:** Let `PluginValidatorDeps` take an optional `start` passed through, and one test recording the `timeoutMs` (60 000) and the args.
- **Effort:** S
- **Confidence:** high (untested); medium (worth a case)

### QA-06 · Low · Some destination branches of `restore-rules.ts` are pinned nowhere

- [ ] **Where:** `packages/cli/src/agents/claude-code/restore-rules.ts:211` (project `not a safe path`), `:177` (`claude-json`), `:190-193` (`GLOBAL_MEMORY_FOLDERS`); `packages/cli/test/claude-code-restore-rules.test.ts:115-127` (no `../` row in the project table)
- **Problem:** `projectDestination('../x')` is never asserted; the `claude-json` kind is reached only through the restorer's tests; a global `agent-memory/<name>/MEMORY.md` is never restored in any test. Pre-existing.
- **Fix:** A `../outside.md` row in the project table; one acceptance table (`settings.json`, `agent-memory/a/MEMORY.md`, `.agentnomad/claude.json`).
- **Effort:** S
- **Confidence:** high

### QA-07 · Low · `otherOsWarnings` is never run for a project target

- [ ] **Where:** `packages/cli/src/agents/claude-code/restorer.ts:173-186`; `packages/cli/test/claude-code-restorer.test.ts:674-712` (both other-OS tests use `restoreGlobal`; `restoreProject` at `:86-92` takes no context)
- **Problem:** A foreign hook in `.claude/settings.json` with `sourceOs` set is never shown to produce the warning; the project half of the lifted function is untested. Pre-existing.
- **Fix:** Give `restoreProject` an optional context and one test with a `powershell` hook in `.claude/settings.local.json` and `sourceOs: 'win32'`.
- **Effort:** S
- **Confidence:** high

### QA-08 · Low · Two program-install branches of `after-restore.ts` have no test

- [ ] **Where:** `packages/cli/src/agents/claude-code/after-restore.ts:127-133` (`… npm was not found. Install it with: npm install -g …`), `:150-155` (`Could not install ${spec}: …`); `packages/cli/test/claude-code-after-restore.test.ts` (every `recordingCli` answers exit code 0)
- **Problem:** Neither message appears in any test. Pre-existing.
- **Fix:** One test with no `npm` on PATH and a programs file; one with a cli answering `exitCode: 1, stderr: 'EACCES'`.
- **Effort:** S
- **Confidence:** high

### QA-09 · Low · `explainPluginFailure` and `managedSettingsNotice` branches left unpinned

- [ ] **Where:** `packages/cli/src/agents/claude-code/managed-settings.ts:174-185`, `:155-168`, `:63-67`; `packages/cli/test/claude-code-managed-settings.test.ts:150-163`, `:176-186`, `:25-31`
- **Problem:** Unpinned: a policy word with `found === null` (rewritten with no source); `not allowed` (in `BLOCKED_WORDS`, in no test); `found` with empty `sources` and a blocked word (the shape after-restore passes on an unmanaged PC; only `null` is tested); the notice with one limit; `managedSettingsDir('win32', {})`'s default. Pre-existing.
- **Fix:** Extend the UX-03 test into an `it.each` over `[reason, found, expected]`; one notice row per limit set.
- **Effort:** S
- **Confidence:** high

### QA-10 · Low · "a yes to the review writes the mod" asserts less than its siblings, and no test accepts a changed mod

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:915-922`; the changed-mod case only as a "no" at `:924-939`
- **Problem:** The yes test checks `asked` and the files, but not `validator.asked`, not the absence of `warn:` lines, not the neighbour and `CLAUDE.md` (all pinned by siblings). No test says yes to a changed mod, which is where BUG-02 lives.
- **Fix:** Add the three assertions; add a yes-to-a-changed-mod test with answers `[true, 'overwrite']` and pin the outcome.
- **Effort:** S
- **Confidence:** high

### QA-11 · Low · Two global-collector branches have no case

- [ ] **Where:** `packages/cli/src/agents/claude-code/global-collector.ts:96-99` (`findProgram` returning `null` → `{ command, npm: null }`), `:130-131` (`~/.claude.json` that is JSON but not an object → `ClaudeJsonError`); `packages/cli/test/claude-code-global-collector.test.ts`
- **Problem:** No test's `findProgram` returns `null`; the one `ClaudeJsonError` case is half-written JSON, so the array branch is untested. Pre-existing.
- **Fix:** `collectWith(() => Promise.resolve(null))` with a hook naming a program; `'[]'` in `~/.claude.json`.
- **Effort:** S
- **Confidence:** high

### QA-12 · Low · Project hooks in `.claude/settings.local.json` are never collected in a test

- [ ] **Where:** `packages/cli/src/agents/claude-code/project-collector.ts:110-120`; `packages/cli/test/claude-code-project-collector.test.ts:109-138` (hooks only in `.claude/settings.json`; `settings.local.json` appears only as an empty file at `:38`, `:72`)
- **Problem:** The global twin pins the two-settings-files case (T86); the project one does not. Pre-existing.
- **Fix:** A hook in `.claude/settings.local.json` running `scripts/local.py`, and the script in the expected list.
- **Effort:** S
- **Confidence:** high

### QA-13 · Low · `scanEnvReferences` with no `envReferences` is untested

- [ ] **Where:** `packages/cli/src/env/env-references.ts:55` (`if (references === undefined) return …`); every call in `packages/cli/test/env.test.ts` and `push-command.test.ts` passes `CLAUDE_ENV_REFERENCES`
- **Problem:** `AgentAdapter.envReferences` is optional, so an agent without it goes through this branch on every push. Pre-existing.
- **Fix:** `expect(scanEnvReferences([mcpJson], undefined)).toEqual({ variables: [], setBySettings: new Set() })`.
- **Effort:** S
- **Confidence:** high

### QA-14 · Low · No test for a manifest `mcpServers` array or a manifest-named MCP file in the env scan

- [ ] **Where:** `packages/cli/test/env.test.ts:92-116`
- **Problem:** The review-16 BUG-01 test covers the default `.mcp.json` in both scopes and an inline manifest map, which is why BUG-01 passed.
- **Fix:** Add the array case (and the named-file case once BUG-01 decides it).
- **Effort:** S
- **Confidence:** high

### QA-15 · Low · The exit-code paragraph and the `--allow-commands` example in the help are pinned by no test

- [ ] **Where:** `packages/cli/src/cli/program.ts:37-38`, `:42-46`; `packages/cli/test/program.test.ts:104-106` (asserts only `over ${formatSize(MAX_BUNDLE_BYTES)}`)
- **Problem:** The review-16 READ-04 fix changed both texts; `never asked about` and `or mods` have zero hits in `program.test.ts`, so the README and help pairing is kept by hand only.
- **Fix:** Extend the `--help` test with `toContain('or a file pull')` and a match for "plugins … or mods" that tolerates the wrap.
- **Effort:** S
- **Confidence:** high

## Standards to adopt

- **Path rules live in the paths views, text rules in the pure modules.** Which bundle paths are a plugin folder, its manifest and its default MCP file is a path rule: `global-paths.ts`, next to `isPluginGenerated`; `skills-dir-plugins.ts` and `env-files.ts` read it from there (ARCH-01). Reserved bundle paths (`ACCOUNT_SKILLS_PREFIX`) live there too (ARCH-02).
- **No import cycles, checked by `pnpm check`.** One short script over `packages/cli/src` (ARCH-01).
- **One reading of an MCP file.** `serversIn` (wrapper or whole file) is the rule for the plugin review and the env scan alike (UX-01, BUG-01).
- **Shared test fixtures for the PC and the keys.** `loggedInStore`, `sessionKeys`, `fileManagedSettings`, a `remoteSettingsFile` helper; call `fakeExecutables` by its name (DUP-03, DUP-04, READ-09, READ-10).
- **One behaviour per `it`, tables for rules.** The project-mod test and the T56 env test now; `reviewCovers` and `explainPluginFailure` as tables (REF-01, BP-02, QA-09).
- **Every user-facing message has a test that prints it.** The chooser and error paths of pull and push (QA-02, QA-03) and the help text (QA-15).

## What will break first at scale

1. **Many plugins in one setup:** `reviewPlugins` (`skills-dir-plugins.ts`) validates plugins one after another, each with a 60 s timeout; a setup with ten mods and a hung `claude` waits ten minutes before pull asks anything. Unchanged since review 16.
2. **Large setups on push:** the walker stats every file three times and realpaths each folder (`file-gathering.ts:76`, `:99`, `:110`, `:144`, PERF-01); the first per-file cost to remove when setups grow past thousands of files.
3. **A second agent with its own `${VAR}` files:** the env scan takes fixed paths plus one predicate; the manifest-array and named-file gaps (BUG-01) show the predicate is already short of what one adapter declares. A `serversOf(files)` hook on the adapter, giving the scan the server sources the review already computes, scales to the next agent.

## New or pre-existing

Checked against `30eb20f` and the fix commit `ee2f8d5`:

- **Left or opened by the review-16 fixes (15):** BUG-01 (half done), UX-01, DUP-01, READ-01, READ-02, READ-03, READ-04, READ-09 (the after-restore alias), BP-02, ARCH-01, ARCH-02 (the comment's claim; the import is old), QA-04, QA-10 (the changed-mod half), QA-14, QA-15, and the project-mod shape in REF-01.
- **Pre-existing, in files first read whole this round or branches no earlier round reached (31):** BUG-02, PERF-01, PERF-02, UX-02, DEAD-01, DEAD-02, DEAD-03, DUP-02, DUP-03, DUP-04, READ-05, READ-06, READ-07, READ-08, READ-10, READ-11, READ-12, READ-13, BP-01, QA-01, QA-02, QA-03, QA-05, QA-06, QA-07, QA-08, QA-09, QA-11, QA-12, QA-13, and the rest of REF-01.

## Suggested order of work

1. **ARCH-01, ARCH-02, BUG-01, UX-01, QA-04, QA-14** · the plugin path rules move to `global-paths.ts`, the env scan reads arrays and wrapper-less files like the review does, a cycle check joins `pnpm check`.
2. **QA-01, DUP-03, QA-08, QA-09, READ-02, READ-09, READ-10** · the after-restore and managed-settings tests: the test that cannot fail, the shared fixture, the untested branches.
3. **QA-02, QA-03, QA-15, UX-02, DUP-02, DEAD-02** · pull and push: the choosers and messages get tests, the project-folder block one home, pull's message a next step.
4. **BUG-02, QA-10, REF-01 (project-mod)** · decide and pin what a yes to a changed plugin does.
5. **READ-01, READ-03, READ-04, READ-05, READ-06, READ-07, READ-13** · docs and layout.
6. **PERF-01, PERF-02, BP-01, DUP-01, DEAD-01** · the small source points.
7. **QA-05, QA-06, QA-07, QA-11, QA-12, QA-13, DEAD-03, DUP-04, READ-08, READ-11, READ-12, BP-02, the rest of REF-01** · the remaining test shapes and gaps.

## Not reviewed

- Files outside the diff `30eb20f..ee2f8d5`: among them `after-restore.ts`, `hook-scripts.ts`, `reviewed-settings.ts`, `cli/project-folder.ts`, `program.test.ts`, `setup-commands.test.ts`, `auth-commands.test.ts`; opened to confirm findings, not reviewed line by line.
- `docs/reviews/` itself.
- `pnpm audit --prod` was not re-run (no dependency changed since it passed at `018324d`); CI on `ee2f8d5` was not checked at the time of writing.
