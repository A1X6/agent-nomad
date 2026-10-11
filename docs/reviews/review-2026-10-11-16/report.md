# Code Review — Agent Nomad — 2026-10-11 (review 16)

**Scope:** the whole repository on `dev` at `7d93902`, after T116 to T121 (review 15 and its fixes: the home-path rules for saved folders, the plugin parts Claude Code starts by itself, claude.ai skills through the plugin review, the flagged mod calls, upper-cased environment names, the agent's choices in pull's summary, shared test helpers, and the docs that go with them). The earlier review records under `docs/reviews` are historical and out of scope.
**Stack:** pnpm monorepo, TypeScript (strict), Node ≥ 22.13; packages `contracts` (Zod schemas), `core` (encryption, bundle format, merge), `cli` (the `agentnomad` command, Commander and clack), `server` (Hono, Drizzle, Neon Postgres, PGlite in tests), `e2e`. Tests with Vitest.
**Coverage:** 324 of 324 files read in full, 49,952 lines. See `files.md` for one row per file.
**Checks run:** `pnpm check` (type check, lint, format, tests) pass: 2,081 passed and 18 skipped in 95 files · `pnpm knip` pass (nothing unused) · `pnpm audit --prod` pass (no known vulnerabilities); `pnpm audit` with dev dependencies: 1 High advisory in `source-map-js` under vitest (SEC-09) · `pnpm test:e2e` pass (21 of 21 on this PC at the T121 merge) · CI on `7d93902` pass (run 38151021757, 12 jobs).

**How it was done:** nine readers each read one part of the repo line by line and confirmed their findings at exact lines, several by running the real modules offline or by reading the installed Claude Code 2.1.296 program. Each reader also took the diff of the review 15 fixes (`0923360..7d93902`) for its files and checked that every fix closes its finding and introduced nothing new. The orchestrator re-opened the code behind every High and Medium finding, merged the findings two readers reported twice, and did the cross-file passes. The bar is the "Standards to adopt" of reviews 14 and 15.

## Summary

The repository is in good shape and the review 15 fix wave did its job: all 43 findings are closed in code, apart from three closed in part (SEC-01 on macOS, QA-02, READ-10) and the hook side of SEC-04, each reported again below with the old ID. Nothing is Critical. This round has 36 findings: 5 High, 3 Medium and the rest Low. Every High and Medium is in pull's safety gates, the one promise the README makes ("Nothing runs unseen", "`--yes` alone never writes a plugin with code"), and all are reachable only with a crafted bundle from a compromised or careless source PC.

Three of the High findings are one problem: the gates compare plugin file and folder names by exact case, while Windows and macOS do not. A bundle with `Hooks/hooks.json` or `.MCP.json` passes the plugin review (SEC-01), `skills/Evil` and `skills/evil` are grouped as two folders of which neither is reviewed as a plugin with hooks (SEC-02), and a saved marketplace at `.Claude` lands in `~/.claude` on a Mac (SEC-03, the part of review 15's SEC-01 that stayed open). The other two High findings are names the settings gates do not watch: a pulled `env.CLAUDE_CODE_PLUGIN_DIRS` can point Claude Code at a hooks folder the same bundle writes (SEC-04), and `GIT_CONFIG_PARAMETERS` is not in the code-loading list, so a saved value can make every git call run a command (SEC-05). The Medium findings are narrower: restored plugin data can carry `node_modules` code the docs call "not code" (SEC-06), a quoted `"hooks":` key in a skill's frontmatter passes the Markdown check (SEC-07), and the mod review flags risky `$` calls but not a `tool.check` hook that approves every tool call (SEC-08).

The fixes themselves introduced a handful of Low items that this review exists to catch: the summary line for claude.ai skills counts skills `--yes` left out (UX-01), the `--env-values` warning contradicts another setup of the same pull (UX-02), the upper-casing rule sits at two callers instead of in the module (DUP-02), the import-following loop was copied a fourth time (DUP-03), and seven documentation statements still describe the rules as they were before T117 (READ-03, READ-04, READ-05, READ-09). No compatibility break for CLIs 1.0.3 to 1.0.6 was found: no new server field or error code, and the bundle format is unchanged apart from the saved claude.ai plugin layout that T120 documented and that older CLIs refuse with one warning.

Nothing found blocks a merge of `dev` into `main` once the five High and three Medium findings are fixed; they are all in `packages/cli/src/agents/claude-code` and `packages/cli/src/env`, small to medium, and need no server or bundle-format change.

## Scores

| Area                         | Score /10 | One-line reason                                                                                                                                                                                                                   |
| ---------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness                  | 9         | One Low bug (BUG-01, a raw Zod error over 10,000 files); every review 15 bug fix holds.                                                                                                                                           |
| Security                     | 6         | Encryption, auth and the server hold; pull's plugin and settings gates have five High holes for a crafted bundle, four of them one class (case handling, SEC-01 to SEC-03) and two names the gates do not watch (SEC-04, SEC-05). |
| Performance                  | 9         | Nothing new; the orphan sweep's anti-join (DB-01) is the one query that grows with every user's files.                                                                                                                            |
| User experience              | 8         | Clear messages and summaries; two lines that contradict the pull they describe (UX-01, UX-02).                                                                                                                                    |
| Readability                  | 7         | Well named and commented code; seven doc statements lagged the review 15 fixes (READ-03, READ-04, READ-05, READ-09) and four small comment faults.                                                                                |
| Maintainability              | 8         | Strict lint, knip clean, shared helpers; case handling of names is done five ways, and five small duplications (DUP-01 to DUP-05).                                                                                                |
| Architecture and scalability | 8         | Package and adapter boundaries hold; the gates' name lists are hand-kept deny lists that each Claude Code release can outgrow (SEC-04, SEC-05, ARCH-01).                                                                          |
| Test coverage                | 8         | 2,081 tests and cross-OS e2e chains; a few tests prove less than their titles (QA-02, QA-03, QA-06), 12 gate names are tested nowhere (QA-04), and the e2e plugin-gate push skips the leak check (QA-07).                         |

| Category             | Critical | High  | Medium | Low    |
| -------------------- | -------- | ----- | ------ | ------ |
| Bugs                 | 0        | 0     | 0      | 1      |
| Security             | 0        | 5     | 3      | 1      |
| Database and queries | 0        | 0     | 0      | 1      |
| Performance          | 0        | 0     | 0      | 0      |
| User experience      | 0        | 0     | 0      | 2      |
| Dead code            | 0        | 0     | 0      | 0      |
| Duplication          | 0        | 0     | 0      | 5      |
| Readability          | 0        | 0     | 0      | 9      |
| Refactoring          | 0        | 0     | 0      | 0      |
| Best practices       | 0        | 0     | 0      | 1      |
| System design        | 0        | 0     | 0      | 1      |
| SOLID and OOP        | 0        | 0     | 0      | 0      |
| QA and testing       | 0        | 0     | 0      | 7      |
| **Total**            | **0**    | **5** | **3**  | **28** |

## Fix first

1. **SEC-01** · High · plugin file names are compared by exact case, so `Hooks/hooks.json` or `.MCP.json` passes the review and `pull --yes` writes it.
2. **SEC-02** · High · `skills/` folders are grouped by exact-case name and need the manifest among the incoming files, so case twins or a lone `hooks/hooks.json` add command hooks unreviewed.
3. **SEC-03** · High · the "never a folder that holds Claude Code's own folder" check is case-sensitive on macOS (review 15 SEC-01 not fully closed).
4. **SEC-04** · High · a pulled `env.CLAUDE_CODE_PLUGIN_DIRS` is never reviewed and can load a hooks folder the same bundle writes.
5. **SEC-05** · High · `GIT_CONFIG_PARAMETERS` is not in the code-loading list, so a saved value runs a command on every git call.
6. **SEC-08** · Medium · a mod that hooks `tool.check` and answers `allow` is shown with no warning (hook side of review 15 SEC-04).
7. **SEC-07** · Medium · a quoted `"hooks":` frontmatter key passes the Markdown check.
8. **SEC-06** · Medium · restored plugin data can carry `node_modules` code and is written without review.
9. **UX-01** · Low · pull's summary line for claude.ai skills counts skills `--yes` left out and can say `no` after `--yes`.
10. **BUG-01** · Low · a setup over 10,000 files stops push halfway with a raw Zod error.

## Findings

### Bugs

#### BUG-01 · Low · A setup over 10,000 files stops push halfway with a raw Zod error

- [ ] **Where:** `packages/contracts/src/bundle.ts:87-89` (the cap, a bare `10_000`, not exported); `packages/cli/src/push/push-command.ts:476-480` (encode inside `uploadOne`), `:550-553` (`apply` loop), `:591` (`finishSetups`); no test anywhere (`packages/contracts/test/bundle.test.ts` covers paths and duplicates, not the count).
- **Problem:** `BundleFilesSchema` refuses more than 10,000 files. Push never checks this: its plan step counts no files. The first check is `deps.codec.encode` → `BundleSchema.parse` in `createGzipBundleCodec` (`packages/core/src/gzip-bundle-codec.ts:103`), inside the apply step, after "Upload it now?". The `ZodError` is not caught in `uploadOne` (only `ApiError` `revision_conflict` is, `:513-516`). It leaves `apply`, so the setups after it are never tried, `finishSetups` never runs, and `describeError` (`packages/cli/src/cli/error-messages.ts:24`) prints `error.message`. In zod 4.6.5 that is the JSON issue list (probed: `[ { "origin": "array", "code": "too_big", "maximum": 10000, … "path": ["files"], "message": "Too big: expected array to have <=10000 items" } ]`).
- **Why it matters:** A large setup, for example a global setup with every project's auto memory or a big `skills/` tree, can reach the cap while still compressing under 5 MB. The user then gets a JSON blob with no file names and no hint about what to remove, and later setups in the same run are silently not saved. The README promises that a setup that cannot be saved is reported, while "the other setups are still done first, and one message lists what was not" (README "From scripts and CI"). That works for the 5 MB limit (`too-large`, `:523-531`) but not for this one. Mutation check: deleting `.max(10_000)` fails no test.
- **Fix:** Export the cap from contracts (`MAX_BUNDLE_FILES = 10_000`, used in `BundleFilesSchema` and named in CONTRIBUTING's constants list). In push's plan step, treat a bundle over it as a not-done outcome like the size limit, for example "`<setup>`: 12,345 files, over the 10,000 limit". Add a contracts test (10,000 accepted, 10,001 refused) and a push-command test. This changes no server field, no error code and no bundle format, so CLIs 1.0.3 to 1.0.6 are unaffected.
- **Effort:** S
- **Confidence:** high (code path read; error format probed with the installed zod).

### Security

#### SEC-01 · High · The plugin gate matches file names by exact case, while Windows and macOS do not, so `pull --yes` writes a plugin with hooks or servers unasked

- [ ] **Where:** `packages/cli/src/agents/claude-code/skills-dir-plugins.ts:70-89` (`skillsPluginFolders`: `file.path === PLUGIN_MANIFEST`, `mod: … === PLUGIN_HOOKS`); `packages/cli/src/agents/claude-code/plugin-review.ts:275-279` (`jsonAt`: `entry.path === at`), `:363-376` (`commandHooksOf`), `:317-357` (`startsOf`), `:405-416` (`runsCode`: `RUNS_CODE.files.includes(file.path)`, `file.path.startsWith(\`${part}/\`)`).
- **Problem:** every plugin-file check compares bundle paths with the exact names `.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json` and `monitors/`. On Windows (NTFS) and on macOS (default APFS) a file saved as `Hooks/hooks.json` or `.MCP.json` is the file Claude Code opens as `hooks/hooks.json` or `.mcp.json`. Run against the real module with a validator that passes and lists no modules (validate does not list classic command hooks):
  - `hooks/hooks.json` with a `SessionStart` command hook → `runsCode: true`, hook shown;
  - `Hooks/hooks.json` → `runsCode: false`, no hook shown; `hooks/Hooks.json` → the same;
  - `.MCP.json` with a server → `runsCode: false`;
  - `skills/x/.Claude-Plugin/plugin.json` → `skillsPluginFolders` finds no plugin folder at all, so `skills/` gets no review.
    `askPluginFolders` (`plugin-review.ts:492-495`) accepts a folder with `runsCode: false` without a question, also under `--yes`. The same review serves T98, T99 and T101, so local marketplaces, plugin folders and claude.ai plugins are affected too; `restorer.ts` writes these names as they are.
- **Why it matters:** this breaks the README promise ("`--yes` alone never writes" a plugin with code; "Nothing runs unseen") on Windows and macOS for a crafted bundle, the same class as review 15 SEC-02. It also breaks review 15's standard "Names from a bundle are compared the way the target PC compares them" (review 15 SEC-05); the restore rules (`restore-rules.ts:63-65`) and `isGeneratedInPlugin` already ignore case.
- **Fix:** compare plugin paths without case in all of these places (one helper, for example `samePluginPath(a, b)` or lower-casing the paths once in `skillsPluginFolders` and at the top of `reviewPluginFolder`, then reading files by the lower-case key). Treat a folder holding a case variant of a `runsCode` name as running code everywhere (simplest and safe on Linux too). Add tests with `Hooks/hooks.json`, `.MCP.json`, `Monitors/monitors.json` and `.Claude-Plugin/plugin.json` under `assumeYes: true` that expect the folder skipped.
- **Effort:** S
- **Confidence:** high for the code path (run). Medium that every Claude Code lookup goes through the filesystem by name (case-insensitive by default on NTFS and APFS); not probed with a real Claude Code.
- **Also:** the contracts schema (`packages/contracts/src/bundle.ts:87-102`) refuses only exact duplicate paths, and the restorer folds case twins into one write (`restorer.ts:194-196`); the fix belongs in pull, see SEC-02 for the `skills/` grouping.

#### SEC-02 · High · The plugin review misses a `skills/` folder whose manifest is not in the incoming files under the same name, so `pull --yes` can add command hooks to a plugin unreviewed

- [ ] **Where:** `packages/cli/src/agents/claude-code/claude-code-adapter.ts:128-147` (`reviewSkillsPlugins`), `:247-265` (`withAccountCopies`); `packages/cli/src/agents/claude-code/account-copies.ts:68-86` (`planSavedCopies`). The grouping it relies on is `packages/cli/src/agents/claude-code/skills-dir-plugins.ts:70-90` (`skillsPluginFolders`, SEC-01).
- **Problem:** `reviewSkillsPlugins` reviews only the folders `skillsPluginFolders(files)` returns: incoming files grouped by the exact-case folder name, kept only when that group holds `.claude-plugin/plugin.json`. Two ways round it:
  1. **Case twins.** `skills/Evil/.claude-plugin/plugin.json` and `skills/evil/hooks/hooks.json` are two groups. `Evil` has no hooks, so `runsCode` is false and it is accepted without a question, also under `--yes`. `evil` has no manifest, so it is not reviewed at all. On Windows and macOS (the restorer itself treats both as folding names, `restorer.ts:195`) both land in one folder: a plugin with command hooks. The restorer's own case check (`restorer.ts:538-550`) only catches two entries that are the same file, not two files in folders that differ by case. The saved claude.ai skills take the same path, and they are added by default under `--yes` (T114): `planSavedCopies` checks each copy against the names on this PC, never against the other copies, so `Evil` and `evil` are both added. Run against the real modules: `planAccountSkills` with saved skills `Evil` (manifest, `SKILL.md`) and `evil` (`hooks/hooks.json` with a `SessionStart` command hook) gives both in `toAdd` with `runsCommands: false`. `skillsPluginFolders` of the result gives one folder, `skills/Evil`, `mod: false`.
  2. **Manifest already on disk.** A setup's `skills/<name>/hooks/hooks.json` without its manifest, for a skills-dir plugin this PC already has (`~/.claude/skills/<name>/.claude-plugin/plugin.json`), is not a plugin folder to `skillsPluginFolders`, so it is never reviewed. It is a new file, so the restorer asks nothing and writes it into the existing plugin, on every OS. (A saved claude.ai skill cannot do this: `localSkillNames` skips a name already in `skills/`.) `reviewRunnable` does not look at `hooks/hooks.json` either (`command-review.ts:233-260` reads settings, MCP files and Markdown only).
- **Why it matters:** this is the hole review 15 closed for claude.ai skills (review 15 SEC-03) and plugin parts (review 15 SEC-02), reopened through how folders are grouped. The README promise "`--yes` alone never writes a plugin with code" fails for a crafted bundle (a compromised or careless source PC, which also knows the names of the user's local plugins). Claude Code then runs the command hooks at the next session.
- **Fix:** review every `skills/<name>/` folder of the incoming files that holds any runs-code part (`plugins.runsCode` files and folders), together with what is on disk at `<base>/skills/<name>/`: treat it as a plugin when the incoming files _or_ the folder here hold the manifest, and pass the disk manifest to `reviewPluginFolder`. Group names case-blind on `win32` and `darwin` (as `sameFileKey` does), or refuse a setup with two `skills/` folders that differ only by case. In `planSavedCopies`, skip a copy whose lower-case name an earlier copy already took ("another saved copy has this name"). Tests: case twins under `--yes` (setup files and saved skills), and `hooks/hooks.json` alone for a plugin already in `skills/`, each expecting the hooks file not written.
- **Effort:** M
- **Confidence:** high for the code path (grouping run against the real modules; restorer and review read). That Windows and macOS put `Evil/` and `evil/` in one folder is how NTFS and default APFS work; not run on those PCs here.

#### SEC-03 · High · Review 15 SEC-01's "never a folder that holds Claude Code's own folder" check is case-sensitive on macOS (review 15 SEC-01 not fully fixed)

- [ ] **Where:** `packages/cli/src/agents/claude-code/local-marketplaces.ts:428-446` (`homeFolderFor`, the `holds` test at `:441-445`). Also used by `plugin-dirs.ts` (T99).
- **Problem:** the T117 fix sends a saved folder to the fallback when it is inside Claude Code's base folder or holds it, using `path.relative` from `pathsOf(platform)`. On `darwin` that is `path.posix`, which compares case-sensitively, while the Mac's default file system does not. A saved local marketplace whose `path` is `.Claude` (or `.CLAUDE`) is therefore placed at `~/.Claude`, which on macOS is `~/.claude`. Run against the real module with `platform: 'darwin'`, home `/Users/me`, base `/Users/me/.claude` and a file `skills/evil/.claude-plugin/plugin.json`: `.claude` gives the fallback, `.Claude` and `.CLAUDE` give `/Users/me/.Claude` and `/Users/me/.CLAUDE`. (`win32` gives the fallback, as `path.win32.relative` ignores case.) The per-file `homePathProblem` check does not cover the base folder. `restoreFolder` (`restorer.ts:641-648`) checks only for a safe relative path, `.git` and Windows names. The T97 review covers only the folders of the marketplace's installed plugins (`:601-614`). So every other file goes into `~/.claude` unreviewed: a new `skills/<x>/` plugin with hooks needs no answer at all, and an existing `settings.json` is merged under `--yes` (`pull-command.ts:251`, `--yes` answers `merge`). The same holds with `CLAUDE_CONFIG_DIR` below home (`.Config` for a base of `~/.config/claude`).
- **Why it matters:** this is the class SEC-01 (High) of review 15 fixed, still open on macOS for a crafted bundle: the setup's settings review and the plugin review are both skipped. The project's own rule is that Windows and macOS ignore case (`under(…, { ignoreCase: true })` in `claude-md-imports.ts:216` and `hook-scripts.ts:28`, `foldsNames` in `restorer.ts:195`); this check does not follow it.
- **Fix:** compare case-blind on `win32` and `darwin`. For example, in `holds`, lower-case both paths before `path.relative` when the platform folds names, or reuse `bundlePathInside`/`underFolder` with `ignoreCase`. Add a test on `darwin` with `path: '.Claude'` (and a `CLAUDE_CONFIG_DIR` case variant) that expects the fallback, in the local-marketplaces and plugin-dirs tests.
- **Effort:** S
- **Confidence:** high (run against the module). That APFS is case-insensitive by default is documented macOS behaviour; a case-sensitive volume is not affected.

#### SEC-04 · High · A pulled `env.CLAUDE_CODE_PLUGIN_DIRS` that points at a folder the setup writes elsewhere is never reviewed

- [ ] **Where:** `packages/cli/src/agents/claude-code/reviewed-settings.ts:36-56` (the name is in no watched list), used by `command-review.ts:154-160` (only loader and redirect `env` names become review entries); `packages/cli/src/agents/claude-code/plugin-dirs.ts:311-331` (`withPluginDirs`: an entry that matches no saved folder is kept as it is, `if (write === undefined) return [entry]`); `packages/cli/src/agents/claude-code/restore-rules.ts:164-166` (any file under a synced folder such as `hooks/` is written).
- **Problem:** T99 reviews the plugin folders push saved under `.agentnomad/plugin-dirs/`. Nothing reviews the variable itself. A bundle can set `settings.json` `env.CLAUDE_CODE_PLUGIN_DIRS` to `~/.claude/hooks/x` with no saved plugin-dir entry, and carry `hooks/x/.claude-plugin/plugin.json` and `hooks/x/hooks/hooks.json` with a command hook. Run against the real modules: `reviewRunnable` returns 0 entries for that `settings.json`, and `globalDestination` gives `target` for all three files. `hooks/` is written whole without review (T112: "a script there runs only when a settings file names it"), and the T97 review looks only at `skills/<name>/` (`claude-code-adapter.ts:128-137`). Claude Code then loads `~/.claude/hooks/x` as `x@inline` (ARCHITECTURE section 7, T99 facts) and runs its hook. Under `--yes` the `settings.json` conflict is merged, so the value lands too.
- **Why it matters:** `pull --global --yes`, without `--allow-commands`, can install a plugin with command hooks that runs at the next Claude Code start, and nothing is shown. Same impact class as review 15 SEC-02. It needs a crafted bundle, as all the gate findings do.
- **Fix:** add `CLAUDE_CODE_PLUGIN_DIRS` to the watched `env` names (a review entry `setting env CLAUDE_CODE_PLUGIN_DIRS`, and `WATCHED_SETTINGS` so the drift check sees it). In `withPluginDirs`, drop entries of a pulled value that match no saved folder pull wrote, or keep them only when they already name a folder in this PC's own value. Optionally run any folder in the bundle that the value names through `askPluginFolders`. Add a test with the three files above under `assumeYes: true`.
- **Effort:** S
- **Confidence:** high for agentnomad's side (run). Medium that Claude Code loads such a folder with no prompt of its own (taken from the T99 facts in ARCHITECTURE; not probed).

#### SEC-05 · High · `GIT_CONFIG_PARAMETERS` passes the code-loading gate, so `pull --yes` adds a saved value that runs a command on every `git status`

- [ ] **Where:** `packages/cli/src/env/loader-variables.ts:1-14` (the list, line 14); used at `packages/cli/src/env/env-restore.ts:104-109` (split into loaders, redirects and plain) and `:124-135` (`deps.assumeYes ||` adds every plain name). The same list gates a settings `env` block in `packages/cli/src/agents/claude-code/command-review.ts:158`.
- **Problem:** `LOADER_VARIABLE` names Git's config-through-the-environment variables `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*` and `GIT_CONFIG_VALUE_*`, and its comment says it covers "Git config files and entries given through the environment". It misses `GIT_CONFIG_PARAMETERS`, the variable `git -c` itself uses to pass config entries to every git process. `isRedirectVariable` (`reviewed-settings.ts:36-61`) does not list it either. So a saved `GIT_CONFIG_PARAMETERS` is a "plain" value: `planEnvRestore` adds it under `--yes` with no question and no warning, and with `--env-values all` too. `EnvSectionSchema` accepts it (`env-section.ts:17,32-34`: any name, quotes allowed in the value). Checked here with git 2.56.0 in a throwaway repository: `GIT_CONFIG_PARAMETERS="'core.fsmonitor'='echo PWNED-fsmonitor >&2; false'" git status` printed `PWNED-fsmonitor` twice, and an `alias.*` entry runs `!` commands the same way. Push never saves such a value (it saves only names the setup references), but pull does not check that: a crafted bundle carries any name.
- **Why it matters:** this is the review 15 SEC-05 class again, on every OS rather than Windows only. `agentnomad pull --yes` (no `--allow-commands`) writes the value into the shell profile or the Windows user variables, and from the next terminal on, every `git status` (also the ones Claude Code and editors run in the background) runs the bundle's command. README:159 and `env-restore.ts:70-75` promise that a value that "makes programs run code" needs `--allow-commands` or a yes, and threat-model row 38 says the loader list covers Git config given through the environment. The precondition is the one the gate exists for: a setup pushed from a compromised or careless PC on the same account. Related names that also make git or other tools run code but need a file the bundle can supply (pull expands `{{HOME}}` in `env.json` through `fromBundleFiles`, `pull-command.ts:334`, so a path into a restored skill folder is portable): `GIT_TEMPLATE_DIR` (hooks copied into every clone), `GIT_EXEC_PATH`, `GIT_SSH` and `XDG_CONFIG_HOME` (a `git/config` or `fish/config.fish` under it). Those are confidence medium; `GIT_CONFIG_PARAMETERS` needs no file.
- **Fix:** gate every Git variable instead of naming them one by one: replace the `GIT_*` alternatives with `GIT_.+` (a saved Git variable is rare and only ever asked about, never dropped). Add `XDG_CONFIG_HOME` to the list. Add a test in `env.test.ts` that saves `GIT_CONFIG_PARAMETERS` (and a lowercase `git_config_parameters`) and expects it gated under `--yes`, and the same case in the settings review test. Update threat-model row 38 and the ARCHITECTURE `loader-variables.ts` row. Optional second line of defence: let pull offer only saved names the restored setup references (`scanEnvReferences` on the planned files), as push already requires.
- **Effort:** S
- **Confidence:** high (code path read at the lines above; the command execution was run with git 2.56.0 offline)
- **Also:** `docs/security/threat-model.md:140` (finding 38) and `docs/ARCHITECTURE.md:1098` describe the list and change with it.

#### SEC-06 · Medium · Restored plugin data can carry code (`node_modules`, virtual environments) and is written without a review

- [ ] **Where:** `packages/cli/src/agents/claude-code/plugin-data.ts:198-213` (`savedPluginData`: any bundle-safe path under a safe folder name), `:262-268` (the question), `:308-331` (written with `restoreFolder`); `packages/cli/src/agents/claude-code/restorer.ts:243-249` (`modeFor`: a saved `executable` or `#!` file gets mode 755); described in `docs/security/threat-model.md:61` (row 22, "The data is not code, so it gets no plugin review") and README's plugin-source table ("No (it is data, not code)").
- **Problem:** Claude Code's plugin docs say `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`) is "for `node_modules`, virtual environments, and caches" and "installed dependencies such as `node_modules`, generated code", and show a `SessionStart` hook that runs `npm install` there only when `package.json` differs, with MCP servers setting `NODE_PATH` to `${CLAUDE_PLUGIN_DATA}/node_modules`. Push leaves `node_modules` out (skipped names), but pull does not check: `globalDestination('.agentnomad/plugin-data/p-m/node_modules/x/index.js')` is `metadata`, and the follow-up writes it into `plugins/data/p-m/node_modules/x/index.js` once plugin `p@m` is installed. A crafted bundle with the plugin's own `package.json` and a changed dependency makes the reviewed plugin load that code. The question says only "It holds what plugins and mods keep, e.g. a mod's saved choices."
- **Why it matters:** opt-in only (a person's yes or `--plugin-data`; `--yes` never), but the person agrees to "data", and the threat model and README say it is not code. A reviewed or reinstalled plugin then runs code nobody saw.
- **Fix:** on pull, refuse in saved plugin data what push never saves (the skipped names, `node_modules` first) and, where it is cheap, files that can run (a script extension, the executable flag, a `#!` line); or list those and accept them only with `--allow-commands` or a separate yes. Reword the question ("can hold installed dependencies plugins run"). Correct threat-model row 22 and the README row. Add a test with a `node_modules` file in saved plugin data.
- **Effort:** S
- **Confidence:** medium-high (code path certain; the docs quoted above confirm plugins keep code there).
- **Also:** the doc lines to change read as described: `docs/security/threat-model.md:61` (row 22) and `README.md:245` (plugin-source table, "No (it is data, not code)").

#### SEC-07 · Medium · Frontmatter `hooks` is found only as an unquoted key, so `"hooks":` in a skill passes the review

- [ ] **Where:** `packages/cli/src/agents/claude-code/runnable-markdown.ts:10-13` (`/^hooks\s*:/m`).
- **Problem:** YAML reads `"hooks":` and `'hooks':` as the key `hooks`. Run against the module: `hooks:` gives `['hooks in its frontmatter']`, `"hooks":` gives `[]`. A skill, command or subagent file whose frontmatter uses the quoted key carries hooks that Claude Code runs while it is active, and the review never shows it (the account-skills gate uses the same function).
- **Why it matters:** under `--yes` such a file is written without a question, against "skills, commands or subagents with commands that run by themselves" being listed (README "Nothing runs unseen"). It needs a crafted bundle.
- **Fix:** match `^\s*["']?hooks["']?\s*:` (and fail toward showing: also flag a frontmatter with a flow mapping `{` or a `? ` complex key). Add the quoted case to the runnable-markdown tests.
- **Effort:** S
- **Confidence:** medium (the regex gap is certain; that Claude Code parses skill frontmatter as standard YAML is from its docs, not probed).

#### SEC-08 · Medium · The mod review flags risky calls only, so a module that hooks `tool.check` and allows every tool call gets no warning

- [ ] **Where:** pinned by `packages/cli/test/claude-code-plugin-review.test.ts:278-301` ("flags exactly these of the program's mod calls") over `packages/cli/test/claude-code-plugin-fixtures.ts:301-420` (`MOD_CALLS`). Code: `packages/cli/src/agents/claude-code/plugin-review.ts:241-261` (`modulesOf`: `risky` is built from `calls` only), `:441-446` (the `⚠` line), `:462-471` (`riskyModuleFiles`: the source is offered only for risky calls); `packages/cli/src/agents/claude-code/reviewed-settings.ts:90-106` (`RISKY_MOD_CALLS`).
- **Problem:** validate lists two things per module: the hooks it registers (`hooks:`) and the `$` methods it calls (`calls:`). Only calls are checked for risk. In Claude Code 2.1.296 a mod hook on `tool.check` answers the permission question for a tool call: the program maps the hook's `{ decision }` to `allow`, `deny` or `ask` (`switch(…e.decision){case"allow":return{behavior:"allow",updatedInput:…}`, and the log line `tool.check ${tool} …: ${behavior} -> ${decision} by ${plugins}`). A module that hooks `tool.check` and answers `allow` approves every Bash command the model proposes, with no prompt. The review shows it only as `./register.ts hooks: tool.check`, with no `⚠` line and no offer to show the source. The pin cannot catch this: `MOD_CALLS` mixes hook names with call names (its comment says so: "reaches as `$.<name>` or hooks with `on("<name>")`"), and the test runs every name through `riskOfCall` as a call. Smaller, same place: `$.session.authorize` mints a handle that makes `$.http.fetch` send the user's Claude login headers to the first-party API host (`HWt.mint(e, y.headers, r)`; the headers are added when `y.host === G.host`). It is shown only as "uses the network" through `$.http.fetch`, not as using the user's login.
- **Why it matters:** this is the hook-side twin of review 15 SEC-04 (Medium), whose fix covered calls only. The mod still needs a yes, and `--yes` alone skips it, so nothing is written unasked. But the review's job is to tell the user what a mod can do before that yes (README "flagging programs, file writes, model and network calls"). A mod that turns off Claude Code's permission prompts looks harmless next to one that calls `$.store.get`.
- **Fix:** add a `RISKY_MOD_HOOKS` list beside `RISKY_MOD_CALLS`, at least `tool.check` ("decides tool permissions, can allow Bash"), and include matching hooks in `risky`, so the `⚠` line and the source offer follow. Add `$.session.authorize` ("uses your Claude login") to `RISKY_MOD_CALLS`. Split the fixture as the program does (its own scan lists are `{ hooks: [...], calls: [...] }`): `MOD_HOOKS` and `MOD_CALLS`, each pinned with its own "flags exactly these" test, so a newer Claude Code's new hook shows up as a diff too.
- **Effort:** S
- **Confidence:** high that hooks are never flagged (code read at the lines above). Medium-high on the program behaviour: read from the 2.1.296 strings, not run with a real mod.

#### SEC-09 · Low · The full dependency audit reports one High advisory in a dev-only package under vitest

- [ ] **Where:** `pnpm-lock.yaml` (the resolved `source-map-js` under `@vitest/coverage-v8 > vitest > @vitest/mocker > vite > postcss`); `.github/workflows/audit.yml:4-5` and `ci.yml` run `pnpm audit --prod`, which does not see it.
- **Problem:** `pnpm audit` on `7d93902` reports GHSA-68fv-2mgg-jv7q, High, `source-map-js` `>=1.0.0 <1.2.2`, patched in `1.2.2`. It is reached only through the test runner, so `pnpm audit --prod`, which CI and the weekly audit run, passes. Nothing ships it: the published CLI and the server bundle no dev dependency.
- **Why it matters:** the advisory is in the toolchain every contributor and CI job runs, and the lockfile pins the vulnerable version until someone updates it. Low because no user of agentnomad is exposed and the fix is a lockfile change.
- **Fix:** `pnpm update source-map-js --recursive` (or a `pnpm.overrides` entry for `source-map-js@>=1.2.2` in the root `package.json` if the update does not resolve it) and re-run `pnpm check`. Decide whether the weekly audit should also run without `--prod` and report, without failing, dev-only advisories.
- **Effort:** S
- **Confidence:** high

### Database and queries

#### DB-01 · Low · Every 50th save waits for a sweep over every user's stored files

- [ ] **Where:** `packages/server/src/storage/postgres-blob-store.ts:41-55` (`deleteOrphans`); `packages/server/src/bundles/bundle-service.ts:197` (`if (shouldSweep()) await sweepQuietly();`); `packages/server/src/db/schema.ts:130-137` (`bundle_blobs` indexes: only `id` and `(user_id, id)`).
- **Problem:** the sweep is one `DELETE` over all of `bundle_blobs`, for every user. Its filter is `created_at < now() - 1 hour` and "no `bundles` row points here". `created_at` has no index. An index would not help anyway: every current file older than an hour matches the time filter, so Postgres must anti-join almost the whole table against `bundles_blob_id_key` to find the rare orphans. The save that drew the 2% chance awaits this before it answers. The other two housekeeping queries each have their index (`rate_limits_window_started_at_idx`, `sessions_expires_at_idx`, the second added for an earlier review's DB-02), and only the stale rows match them.
- **Why it matters:** the cost grows with all files of all accounts (up to 100 per account), not with the saver's own, and lands on a random user's push. It costs nothing at today's size. It is the first per-request query whose cost grows with the whole user base, and ARCHITECTURE "What will break first" does not list it.
- **Fix:** take the sweep off the request path. Run it with the rate limiter's prune, not awaited, or from a timer in `main.ts`. Or bound it: `DELETE … WHERE id IN (SELECT id … LIMIT 100)`. Better still, record the files a failed or interrupted save leaves behind (the only orphan sources, `blob-store.ts:36-38`), so the sweep never scans current files. Add it to the scale list either way.
- **Effort:** S (move it off the request path) to M (track orphans)
- **Confidence:** high that the query reads every file row (no index can narrow it); medium on when it matters (needs real row counts)

### User experience

#### UX-01 · Low · Pull's summary line for claude.ai skills counts skills that `--yes` left out, and can say `no` after `--yes`

- [ ] **Where:** `packages/cli/src/agents/claude-code/claude-code-adapter.ts:250-257` and `:363-366`; `packages/cli/src/agents/claude-code/account-skills.ts:276-284`.
- **Problem:** `askAccountSkills` drops the skills that run commands when a flag or `--yes` answered and `--allow-commands` is not given (`blocked`), and returns only the others as `names`. The adapter then plans a second time with `planAccountSkills` to name what was offered. `skillsOffered` includes the blocked skills, and the line says `yes` only when `names` is not empty. So with `pull --yes` and skills `a` (plain) and `b` (runs commands), the summary reads `--account-skills yes (a, b)` though `b` is not written. With only `b`, it reads `--account-skills no (b)`, though `--yes` said yes and only `--allow-commands` is missing. The second plan also decodes every saved Markdown file again (`runsCommands`) and parses every saved plugin again.
- **Why it matters:** this is the summary UX-01 of review 15 added, shown right before "Restore it now?". The warning "Add --allow-commands to add it anyway" comes earlier, but the summary contradicts it and names the wrong flag.
- **Fix:** let `askAccountSkills` and `askAccountPlugins` return what they offered and what they added (they already hold the plan), and build the line from those. Name the blocked ones, for example `--account-skills yes (a); b needs --allow-commands`. Add a test with one plain skill and one that runs commands, under `--yes`.
- **Effort:** S
- **Confidence:** high

#### UX-02 · Low · `pull --env-values <names>` says a name was "not added" for a setup without values, even when another setup in the same pull adds it

- [ ] **Where:** `packages/cli/src/pull/pull-command.ts:454-459` (T118, UX-05 of review 15), `packages/cli/src/env/env-restore.ts:50-59` (`warnNotSaved`), `:84`
- **Problem:** the review 15 UX-05 fix warns per setup: every planned setup with no `env.json` section calls `warnNotSaved(reporter, options.envValues, [])`, and every setup with a section warns for the names it lacks. The line names no setup ("Not in the saved setup, so not added: GITHUB_TOKEN."). With `pull --global --project app --env-values GITHUB_TOKEN`, where the global setup saved `GITHUB_TOKEN` and the project saved no values, the global setup plans to add it and the project then prints "Not in the saved setup, so not added: GITHUB_TOKEN."; the apply step later prints "Added GITHUB_TOKEN to ~/.zshrc.". Before T118 the project said nothing in this case. The only test (`pull-command.test.ts:1050-1058`) pulls one setup.
- **Why it matters:** the two lines contradict each other, and a script that greps warnings reports a value as missing that was written. It is wording only; the right value is added.
- **Fix:** warn once per pull, after the loop at `:454-490`, for the names no planned setup's section holds (collect `Object.keys(section.variables)` of every restore), and drop the per-setup warning in `planEnvRestore`. Add a test with a global setup holding the value and a project without values.
- **Effort:** S
- **Confidence:** high (traced in the code; not run)

### Duplication

#### DUP-01 · Low · Two "left out" reasons are written out in both claude.ai files, though `NAME_NOT_A_FOLDER` was shared

- [ ] **Where:** `packages/cli/src/agents/claude-code/account-plugins.ts:60` and `:63`; `packages/cli/src/agents/claude-code/account-skills.ts:98` and `:100`. Shared constant: `account-copies.ts:10`.
- **Problem:** `'it comes from your organization or claude.ai, not from you'` and `'agentnomad cannot tell which claude.ai marketplace it comes from'` appear word for word in both files. T117 (review 15 DUP-01) moved the third shared reason, `NAME_NOT_A_FOLDER`, into `account-copies.ts`, but left these two.
- **Why it matters:** push shows both in its notices for skills and plugins. A wording change in one leaves the other behind, the drift review 15 DUP-01 was about.
- **Fix:** export both from `account-copies.ts` next to `NAME_NOT_A_FOLDER` and use them in both files.
- **Effort:** S
- **Confidence:** high

#### DUP-02 · Low · The loader-variable gate's "upper-case first" rule is repeated at each caller

- [ ] **Where:** `packages/cli/src/agents/claude-code/command-review.ts:158`; `packages/cli/src/env/env-restore.ts:104`; pattern `packages/cli/src/env/loader-variables.ts:13`. Compare `reviewed-settings.ts:61` (`isRedirectVariable`, which upper-cases inside).
- **Problem:** the review 15 SEC-05 fix (T118) wrote `LOADER_VARIABLE.test(name.toUpperCase())` at both call sites. The rule lives in a comment on the pattern. The redirect check beside it is a function that upper-cases itself. On one line of `command-review.ts` the two checks of the same name are done in two ways.
- **Why it matters:** Review 15 SEC-05 happened because a caller forgot the upper-casing. A third caller of the exported pattern can forget it again.
- **Fix:** export `isLoaderVariable(name)` from `loader-variables.ts` (upper-cases, then tests), use it at both sites, and stop exporting the bare pattern if nothing else needs it.
- **Effort:** S
- **Confidence:** high

#### DUP-03 · Low · `unknown-files.ts` follows memory-file imports twice, a fourth copy of the same loop

- [ ] **Where:** `packages/cli/src/agents/claude-code/unknown-files.ts:73-102` (`importedNames`, global) and `:121-150` (in `projectSavedNames`, added by the review 15 UX-04 fix); the same "list rules recursively, read memory files, `followImports` with `isFile: false`" shape in `restorer.ts:286-313` (`importedIn`) and `project-collector.ts:108-141` (`importedFiles`).
- **Problem:** the two blocks in `unknown-files.ts` differ only in the folder, the memory-file list and the place function.
- **Why it matters:** review 15's standard is one implementation per job; a change to how memory files are found (a new memory file name, a rules depth) must be made in four places.
- **Fix:** one helper in `claude-md-imports.ts`, e.g. `importsOf(dir, memoryFileNames, place, read, context)`, used by the four callers.
- **Effort:** S
- **Confidence:** high

#### DUP-04 · Low · `planStepWith` takes no adapter options, so three plan steps are still built by hand

- [ ] **Where:** helper `packages/cli/test/claude-code-project-fixtures.ts:113-136` (`planStepWith(validate, answers, overrides, homedir)`). Built by hand: `packages/cli/test/claude-code-account-skills.test.ts:278-306` (`run`: prompter, reporter, `claudeCodeAdapter(home)`, `planContext`, no validator), `packages/cli/test/claude-code-adapter.test.ts:57-75` (`planStep`, with `isClaudeRunning`) and `:142-159` (the same again, inline).
- **Problem:** DUP-03 of review 15 added `planStepWith` and moved most copies onto it. The helper cannot take adapter options (`isClaudeRunning`), and it needs a `ValidateRun`, although `validatorFor` already takes `null` for "no `claude` here". So the three plan steps that need one of these still repeat the script, reporter, adapter and context set-up (10 to 25 lines each). Two of the copies are in `claude-code-adapter.test.ts` and are the same. The account-skills `run` was written for SEC-03 in T117, at the same time as the helper.
- **Why it matters:** this is the same cost review 15 DUP-03 named: when `RestorePlanContext` or the adapter's options gain a field, these copies must be changed by hand. The review-14 standard says a multi-line structure that a shared helper builds is taken from the helper.
- **Fix:** give `planStepWith` an options object `{ answers, overrides, homedir, adapter?: Partial<ClaudeCodeAdapterOptions> }` and accept `ValidateRun | null`. Use it in the three places: `run` restores and follows up on what it returns, and the `~/.claude.json` tests pass `isClaudeRunning`. Update its line in CONTRIBUTING.
- **Effort:** S
- **Confidence:** medium (the copies are certain; whether they cross the "multi-line structure" bar is a judgement call)

#### DUP-05 · Low · `fakes.ts` keeps its own `exists` and `isJsonObject` after T117 made them shared in `system/`

- [ ] **Where:** `packages/cli/test/fakes.ts:127-128` (`isJsonObject`, used by `readJson` at `:131-135`) and `:137-142` (`exists`, exported); the shared copies `packages/cli/src/system/json.ts:6-8` and `packages/cli/src/system/files.ts:17-18`
- **Problem:** review 15 DUP-02 moved `exists` and `isJsonObject` into `system/` so there is "one copy each". The fix covered `packages/cli/src` (no other copy there) but not the test fakes, which had both since T82 (`git log -L127,128:packages/cli/test/fakes.ts` → `207f4ba`). The bodies do the same thing (`stat` success; object, not null, not array). `fakes.ts` already imports CLI modules by path (`../src/state/local-state.ts`, `../src/secrets/secret-store.ts`), and `system/` loads no agent adapter, so the agent-boundary rule at `fakes.ts:12-13` allows importing them.
- **Why it matters:** two copies of each helper again, one of them in the shared test file every CLI test uses; a change to what "exists" means (for example a broken link) would differ between the code and the tests that check what it wrote.
- **Fix:** in `fakes.ts`, `export { exists } from '../src/system/files.ts';` and import `isJsonObject` from `../src/system/json.ts`; delete the local copies. CONTRIBUTING's list keeps naming `exists` under `fakes.ts`.
- **Effort:** S
- **Confidence:** medium (the copies are certain; whether test helpers should share the code's helpers is a judgement call; review 15 applied "one copy each" to `src/` only)

### Readability

#### READ-01 · Low · An orphaned doc comment in the adapter, and the plan step's comment leaves out the plugin folders

- [ ] **Where:** `packages/cli/src/agents/claude-code/claude-code-adapter.ts:239-246` and `:315-321`.
- **Problem:** two JSDoc blocks are stacked on `withAccountCopies`. The first ("Saved claude.ai plugins (T101) the user agreed to add, as `skills/<name>/` files next to the setup's own…") is the pre-T117 comment, which T117 left above the new one. Only the last block attaches. This is the same fault READ-03 of review 15 fixed in `plugins.ts`. The `planRestore` comment lists the questions as "…saved local marketplaces (T98), then plugins, programs and plugin data (T102)". It leaves out the `CLAUDE_CODE_PLUGIN_DIRS` folders (T99, `planPluginDirs`, `:385-390`), which READ-11 of review 15 added to ARCHITECTURE.
- **Why it matters:** a reader sees two descriptions of one function, the first stale. The comment is the map of pull's Claude Code questions.
- **Fix:** delete `:239-242`. In `:318-319`, write "…saved local marketplaces (T98) and `CLAUDE_CODE_PLUGIN_DIRS` folders (T99), then plugins, programs and plugin data (T102)".
- **Effort:** S
- **Confidence:** high

#### READ-02 · Low · `claude-code-contents.data.ts` names the wrong test file

- [ ] **Where:** `packages/cli/src/agents/claude-code/claude-code-contents.data.ts:5-6`.
- **Problem:** "program.test.ts fails when they differ". The check against the README "What is synced" table is in `packages/cli/test/claude-code-contents-data.test.ts` (it imports `CLAUDE_CODE_CONTENTS` and reads `readmeSection('## What is synced')`). `program.test.ts` only passes the adapters' `contents` into the help it renders. READ-06 of review 15 fixed the same wrong pointer in `help-text.ts`, but not here.
- **Why it matters:** someone editing the lists looks in the wrong file for the test that will fail.
- **Fix:** "claude-code-contents-data.test.ts fails when they differ".
- **Effort:** S
- **Confidence:** high

#### READ-03 · Low · ARCHITECTURE Part 2 rows miss two exports that other modules now use

- [ ] **Where:** `docs/ARCHITECTURE.md:1134` (row `account-copies.ts`) and `:1136` (row `auto-memory.ts`). Code: `account-copies.ts:52` (`sortedCopies`, imported by `account-plugins.ts:16`), `auto-memory.ts:51` (`repositoryRoot`, imported by `claude-json-merge.ts:10` and `project-collector.ts:11` since T117, review 15 BUG-02).
- **Problem:** both rows list what the file holds by name, but not these two. `repositoryRoot` is now how the `~/.claude.json` project key is found, and that lives in the auto-memory module, which the row does not hint at.
- **Why it matters:** this breaks review 14's standard: "A new export of a file is named in that file's row … when the row lists what the file holds". A reader looking for "the git root" will not find it.
- **Fix:** add `sortedCopies` to the `account-copies.ts` row. Add "`repositoryRoot` (the main repository's root, also the key of a project's `~/.claude.json` entry, review 15 BUG-02)" to the `auto-memory.ts` row.
- **Effort:** S
- **Confidence:** high
- **Also found by a second reviewer:** `docs/ARCHITECTURE.md:1202`; code `packages/e2e/src/fixtures.ts:15` (`MOD_HOOKS`, used by `steps.ts:13,197`), added in T119 (review 15 DUP-06).

#### READ-04 · Low · The threat model and ARCHITECTURE still state two rules as they were before T117 (review 15 BUG-02 project key, SEC-01 per-file check)

- [ ] **Where:**
  - Review 15 BUG-02: `docs/security/threat-model.md:51` (row 12, "adds only its local MCP servers … to the entry of the folder pull runs in") and `docs/ARCHITECTURE.md:186` (reserved entry `.agentnomad/claude-json-project.json`, "Merged into the entry of the folder pull runs in"). Code: `claude-json-merge.ts:338` and `project-collector.ts:162` pass `repositoryRoot(...)`, and `auto-memory.ts:51-73` follows `commondir` to the main repository.
  - Review 15 SEC-01: `docs/security/threat-model.md:59` (row 20, the fallback applies when the folder is "outside home, or in a folder for keys, autostart files or Claude Code's own folder"). Code: `local-marketplaces.ts:436-445` (`homeFolderFor`) also sends the folder to the fallback when any saved file's path from home has a `homePathProblem`, and when the folder holds Claude Code's base folder.
- **Problem:** both fixes changed the rule, and the docs still describe the old one. A second reviewer reports the same wording at ARCHITECTURE:442-443 and :644-646 (below), but not these two places. Finding 54 in the threat model's own findings table describes the review 15 SEC-01 fix correctly, yet the row it fixes was not updated.
- **Why it matters:** these are the rows a reader checks to see where pull writes. Run from a subfolder or a worktree, pull now writes to the main repository's entry, not the folder's. A saved `.config` folder holding `fish/config.fish` now goes to the fallback as one piece. Review 15's standard is that "the threat model's header and rows" change in the same task as the code.
- **Fix:** Row 12 and ARCHITECTURE:186: "…to the entry of the main repository root of the folder pull runs in (the folder itself outside git; review 15 BUG-02)". Row 20: "…outside home, in or holding a folder for keys, autostart files or Claude Code's own folder, or with any file that would land in one (each file is checked from home, T117): `~/.agentnomad/marketplaces/<name>`". Fix all five places together.
- **Effort:** S
- **Confidence:** high
- **Also found by a second reviewer:** `docs/ARCHITECTURE.md:442-443` ("goes into the entry of the folder pull runs in"), `:644-646` ("The key is the git root of the folder Claude Code runs in … Push looks up the folder it runs in"); code `packages/cli/src/agents/claude-code/project-collector.ts:158-165` and `claude-json-merge.ts:338`, both through `repositoryRoot` (`auto-memory.ts:51-73`, which follows `commondir` to the main repository from a worktree).

#### READ-05 · Low · ADDING-AN-AGENT does not mention `AgentRestorePlan.summary` (review 15 UX-01)

- [ ] **Where:** `packages/cli/src/agents/adapter.ts:263-268` (new `summary`); `docs/ADDING-AN-AGENT.md:248-253` (the `planRestore` bullet names only `declined`).
- **Problem:** T118 added `summary` so pull's last summary names an agent's own choices; `pull-summary.ts:34,44` reads it. The guide, which is the contract for a new adapter (review 15 READ-13), does not say a plan should fill it.
- **Why it matters:** a second agent would ship a plan whose choices pull's summary leaves out, the gap review 15 UX-01 closed for Claude Code.
- **Fix:** add to the bullet: "Fill `summary` (`files` it writes, and one line per choice, e.g. `--<part> yes (names)`) so pull's summary before `Restore it now?` shows them (review 15 UX-01)."
- **Effort:** S
- **Confidence:** high
- **Also:** `docs/ARCHITECTURE.md:349` (the section 6 adapter table, `planRestore` row names only `declined`); fix both together.

#### READ-06 · Low · `noManagedSettings` names two different things in the Claude Code tests

- [ ] **Where:** `packages/cli/test/claude-code-adapter.test.ts:53` (`const noManagedSettings = fakeManagedSystem({ platform: 'linux' })`), against `packages/cli/test/claude-code-plugin-fixtures.ts:69` (`export const noManagedSettings: ManagedSettings`, used in `claude-code-managed-settings.test.ts:6,219` and as `noPolicy` in `claude-code-after-restore.test.ts:5`). The same system value is also built inline at `claude-code-adapter.test.ts:149` and `:319`.
- **Problem:** in the shared fixtures, `noManagedSettings` is a detection result (no sources, no limits). In the adapter test, the same name is a fake system that the adapter reads managed settings from. The two have different types, and a reader moving between files cannot tell which one is meant. The adapter test then builds the same fake system twice more under no name.
- **Why it matters:** a reader who copies the local name into another test, or imports the shared one here, gets a type error at best, or the wrong kind of value at worst. One name for two things is the readability rule CONTRIBUTING follows.
- **Fix:** name the local value `noManagedSystem` (or `linuxWithoutPolicy`), move it to file level, and use it at `:149` and `:319` too.
- **Effort:** S
- **Confidence:** high

#### READ-07 · Low · The plugin fixtures' header describes a much smaller file

- [ ] **Where:** `packages/cli/test/claude-code-plugin-fixtures.ts:14`
- **Problem:** the file opens with `/** Plugin files shared by the plugin and plugin sync tests (review 7 READ-01). */` (written in T85). The file is now 869 lines. It holds managed settings, `claude plugin validate` runs and the validator, mods, claude.ai synced skills and plugins, local marketplaces, scripted git, saved folders, plugin data and the mod API names. Seventeen files import it, `claude-code-project-fixtures.ts` among them since T120. The comment is also a doc block followed directly by another doc block (on `installedPluginsFile`), so editors attach it to nothing: the same orphaned-comment pattern as review 15 READ-03.
- **Why it matters:** a contributor looking for a shared helper reads the header first, as CONTRIBUTING asks, and is told the file is for two test files. That makes a new copy of an existing helper more likely, which is the duplication reviews 8 and 15 kept finding.
- **Fix:** make it a plain block comment that says what the file holds in one sentence, and point to CONTRIBUTING's Tests section for the list. For example: `/* The plugin fixtures of the Claude Code tests: what Claude Code 2.1.295 and 2.1.296 keep and answer for plugins, mods and claude.ai synced files. CONTRIBUTING's Tests section lists every helper. */`
- **Effort:** S
- **Confidence:** high

#### READ-08 · Low · The root package.json description leaves out the e2e package

- [ ] **Where:** `package.json:5`
- **Problem:** "agentnomad monorepo: contracts, core, cli and server packages". The workspace has five packages; `packages/e2e` (T37) is in `tsconfig.json`, CONTRIBUTING's repository table and ARCHITECTURE §2.
- **Why it matters:** Small, but it is the first description a reader or a tool sees, and the other three places list five.
- **Fix:** "agentnomad monorepo: contracts, core, cli, server and e2e packages".
- **Effort:** S
- **Confidence:** high

#### READ-09 · Low · SECURITY.md's list of what pull writes outside the agent's folder is still incomplete (review 15 READ-10 not fully closed)

- [ ] **Where:** `SECURITY.md:47-50`. Code: `packages/cli/src/env/shell-profile.ts:91-114` (`~/.config/fish/config.fish`, `~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`), `packages/cli/src/agents/claude-code/claude-json-merge.ts` (the `~/.claude.json` merge), `packages/cli/src/agents/claude-code/global-paths.ts:127-131` (`TOOL_SETTINGS_BUNDLE_PATHS`; ARCHITECTURE:188 says "known tool settings always").
- **Problem:** T121 rewrote the sentence as "Outside the agent's folder pull writes only scripts the setup's own hooks run, saved plugin and marketplace folders …, Markdown files its memory files import, and auto memory …, never into a Startup, autostart or shell-profile folder." Pull also writes three other things outside `~/.claude`:
  - It merges MCP servers, preferences and a project's entry into `~/.claude.json`.
  - It writes saved environment values as a marked block in the shell profile. For fish users that file is `~/.config/fish/config.fish`, which is inside the fish profile folder the sentence says pull never writes to.
  - It writes known tool settings such as ccstatusline's back to the home folder.

  The threat model gets this right in rows 12, 15 and 13.

- **Why it matters:** users read this page to learn what pull can change on their PC. A user who reads "never into a … shell-profile folder" and then finds an agentnomad block in `config.fish` sees the security page contradicting itself. All three writes are gated or limited (rows 12 and 15), so this is a wording problem, not a hole.
- **Fix:** "Outside the agent's folder pull writes only: scripts the setup's own hooks run and known tool settings; saved plugin and marketplace folders (after the plugin review); Markdown files its memory files import; auto memory in the folder `autoMemoryDirectory` names; a merge into `~/.claude.json`; and, for the environment values you add, one marked block in your shell profile (or Windows user variables). It never drops a file into a Startup, autostart or shell-profile folder."
- **Effort:** S
- **Confidence:** high

### Best practices

#### BP-01 · Low · The drift workflow's self-test does not run when the settings list it watches changes

- [ ] **Where:** `.github/workflows/drift-check.yml:17-22`; `packages/cli/scripts/drift/drift.ts:20-21`
- **Problem:** The push trigger is commented "When the check itself changes, run it … to prove it still works", but it lists only the workflow, `packages/cli/scripts/drift/**` and `claude-code-paths.data.ts`. The check also imports `WATCHED_SETTINGS` from `packages/cli/src/agents/claude-code/reviewed-settings.ts` (since T55, `65a8756`) and `compareVersions` from `packages/cli/src/agents/notices.ts`. A change to those, such as T107 (`ed6a769`) or the reviewed-settings part of T117, changes what the weekly report compares, but the workflow does not run on it.
- **Why it matters:** Review 15 made the drift check the one durable defence for pull's safety lists ("What will break first at scale", item 1). A change that breaks the live run (fetching and parsing the docs with the new settings list) is only seen on the next Monday, as a failed scheduled run, not on the push that caused it. The unit tests in `claude-code-drift.test.ts` cover the comparison offline, which is why this is Low.
- **Fix:** Add `packages/cli/src/agents/claude-code/reviewed-settings.ts` and `packages/cli/src/agents/notices.ts` to the `push.paths` list, with a comment that it lists every source module the check imports.
- **Effort:** S
- **Confidence:** medium (the trigger gap is certain; the cost depends on how often those two files change alone).

### System design

#### ARCH-01 · Low · The drift check only notices changelog lines that name a plugin part it already knows

- [ ] **Where:** `packages/cli/scripts/drift/drift.ts:131-145` (`WATCHED_NAMES`, `WATCHED`), `:147-160` (`changelogSince`), `:250-257` (the issue's to-do list)
- **Problem:** the review 15 SEC-02 follow-up adds `plugins.runsCode` (`hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `monitors`, and the four manifest keys) to the watched names, so a changelog line that names one of them is reported. A new plugin part, the case that opens a review 15 SEC-02 hole, is not in that list by definition, and is reported only when its line also matches `WHERE` (a `.claude/` path, "stored in", "new folder"…). Run offline against `changelogSince(…, '2.1.296')` with six sample lines: "Added plugin `monitors` …" and "Added `PostToolUse` hooks matcher …" were kept; "Added plugin workflows: a `workflows/` folder at the plugin root starts background jobs", "Added `channels` to plugin.json: plugins can now start channel servers" and the real 2.1.287 line "Added Claude Mods: plugins may now modify deeper behavior" were dropped. The issue's to-do list also still points only at `reviewed-settings.ts` and the pull review; it does not say to add a new part to `plugins.runsCode` and `plugin-review.ts`.
- **Why it matters:** review 15 named "pull's safety review as Claude Code grows" as the first thing to break at scale, with the drift check as the durable fix. As built, the weekly issue stays silent for the kind of change it is meant to catch, and a maintainer who does see such a line is not told where to act.
- **Fix:** also keep a `KIND` line that mentions plugins together with a word for starting or loading something, e.g. `/\bplugins?\b/i.test(line) && /\b(start|run|load|spawn|launch|server|background|hook|monitor)/i.test(line)`, or simply every `KIND` line that says "plugin". Add a to-do bullet: "A new plugin part that starts programs: add it to `plugins.runsCode` in the paths data file and to the plugin review." Add the three dropped lines above as cases in `claude-code-drift.test.ts`.
- **Effort:** S
- **Confidence:** high (probe run against the module at `7d93902`)

### QA and testing

#### QA-01 · Low · No test checks that login and account delete use the key settings the server saved

- [ ] **Where:** `packages/cli/test/auth-commands.test.ts:49-56` (`FAST_KDF_PARAMS`, `fastCrypto`), `:621-631` (`secretTrackingCrypto` hands `params` on to `fastCrypto`), `:805-811` and `:837` (account delete). Code covered: `packages/cli/src/auth/auth-commands.ts:270-274` (login derives with `prelogin.kdfParams`) and `:343-347` (account delete, the same).
- **Problem:** `fastCrypto().deriveKeys(password, salt)` drops its third argument and always derives with `FAST_KDF_PARAMS`. Every login and register test in the file goes through it, so the params the CLI passes are never seen. The account-delete tests use the real crypto with params from the fake `prelogin`, but only check that the auth key is 32 bytes, which any params give. Changing `prelogin.kdfParams` to `DEFAULT_KDF_PARAMS` in `login` or `accountDelete` would leave every test in this file green. `packages/cli/test` and `packages/e2e` have no other check (searched for `kdfParams` and `deriveKeys`): the e2e accounts are all registered with the defaults.
- **Why it matters:** the params are stored per account so they can be raised later (CONTRIBUTING: formats are versioned, never changed in place). If login stopped using the saved ones, every account made with other params could no longer log in or delete itself, and no test would catch it. No user hits this today, because every account so far has the defaults.
- **Fix:** let `secretTrackingCrypto` record the `params` it gets. Add one test where `prelogin` answers params other than the defaults (for example `{ ...FAST_KDF_PARAMS, passes: 3 }`) and assert that login and account delete passed exactly those to `deriveKeys`.
- **Effort:** S
- **Confidence:** high

#### QA-02 · Low · Review 15 QA-02 not fully applied: the "never writes into Claude Code's own folder" test checks only the fallback

- [ ] **Where:** `packages/cli/test/claude-code-local-marketplaces.test.ts:319-324`
- **Problem:** review 15 QA-02 asked for a negative check in the tests whose titles promise nothing is written, and named this test ("The same one-line negative check fits `claude-code-local-marketplaces.test.ts:320-325`"). T120 added the check to the keys-folder test next to it (`:316`) and to the plugin-dirs tests, but this one still asserts only `plan.marketplaces`. Nothing checks that `~/.claude/tools` (`join(base, TOOLS)`) was not created.
- **Why it matters:** this test stands for the promise that pull never writes a saved folder into Claude Code's own folder. A change that wrote to the saved path and also made the fallback would pass.
- **Fix:** add `expect(await exists(join(base, TOOLS))).toBe(false);` after the `plan.marketplaces` assertion.
- **Effort:** S
- **Confidence:** high

#### QA-03 · Low · The plugin-folder re-clone test does not check the "then writes the saved files" of its title

- [ ] **Where:** `packages/cli/test/claude-code-plugin-dirs.test.ts:363-368`
- **Problem:** the test is titled "re-clones the folder at the saved commit, then writes the saved files", but it asserts only the two git calls. Nothing checks that the folder has `.git` or that the saved files were written after the clone. The same test for local marketplaces does check both (`claude-code-local-marketplaces.test.ts:255-265`: `.git` exists, `register.ts` holds `MOD_MODULE`, no warnings). No other test in the plugin-dirs file covers the git path's write.
- **Why it matters:** a change that stopped writing the saved files after a successful re-clone (or wrote them before the clone, which then fails on a non-empty folder) would pass. The user would get a bare checkout without the edits saved on the other PC. This breaks review 15's standard that a test asserts what its title promises (review 15 QA-02).
- **Fix:** take the result's `report` and add, as the sibling test does: `expect(await exists(join(modFolder(), '.git'))).toBe(true)`, `expect(await readText(join(modFolder(), ...MODULE))).toBe(MOD_MODULE)` and `expect(report.warnings).toEqual([])`.
- **Effort:** S
- **Confidence:** high

#### QA-04 · Low · The code-loading gate's test leaves out 12 of its 34 names (11 tested nowhere), and its case rule is kept by each caller

- [ ] **Where:** `packages/cli/test/loader-variables.test.ts:6-38`; the gate `packages/cli/src/env/loader-variables.ts:1-14`; its two callers `packages/cli/src/env/env-restore.ts:104` and `packages/cli/src/agents/claude-code/command-review.ts:158`; `docs/ARCHITECTURE.md:1098`
- **Problem:**
  - The test lists 22 names that must match. These alternatives of `LOADER_VARIABLE` are not in it, and no other CLI test names them (searched `packages/cli/test` for each): `BASH_ENV`, `ENV`, `ZDOTDIR`, `PYTHONSTARTUP`, `PYTHONPATH`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`, `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF`, `DYLD_*`. (`PROMPT_COMMAND` is covered in `env.test.ts`; `GIT_SSH_COMMAND` appears only in the local-marketplaces test, about `findGit`.)
  - After review 15 SEC-05, the regex itself is still case-sensitive. The upper-casing lives at each caller (`LOADER_VARIABLE.test(name.toUpperCase())`, twice). The module comment tells callers to do it, and ARCHITECTURE:1098 says of the module "Names are matched upper-cased", which the export alone does not do: `LOADER_VARIABLE.test('node_options')` is `false`. The callers' lower-case cases are tested (`env.test.ts`, `claude-code-command-review.test.ts`), the module's test has none.
- **Why it matters:** this regex keeps `pull --yes` from adding a saved `BASH_ENV=<script>` or `PYTHONSTARTUP` to the shell profile without `--allow-commands`. Removing one of the 11 alternatives, or a third caller that forgets `.toUpperCase()` (the review 15 SEC-05 hole again), passes every test. Review 15's standard asks for a test that sends the hostile value for each guard that keeps pull from running a program.
- **Fix:** add the 11 names (with `DYLD_INSERT_LIBRARIES` for `DYLD_.+`) to the `it.each` list. Export one `isLoaderVariable(name)` from `loader-variables.ts` that upper-cases, use it in both callers, and test `node_options` and `ld_preload` on it in this file; ARCHITECTURE:1098 then holds as written. SEC-05 (`GIT_CONFIG_PARAMETERS`) adds one more name to the same list and test.
- **Effort:** S
- **Confidence:** high (names searched in `packages/cli/test`; callers read)

#### QA-05 · Low · The orphan sweep on the save path has no test, and the service tests leave it to chance

- [ ] **Where:** `packages/server/src/bundles/bundle-service.ts:107` (default `shouldSweep`), `:109-115` (`sweepQuietly`), `:197` (the call); `packages/server/test/bundle-service.test.ts:33-39` (`serviceWith`); `packages/server/test/support/app.ts:41` and `packages/e2e/src/local-server.ts:57` (both `shouldSweep: () => false`); compare `packages/server/src/server.ts:24-25,61` (`PRUNE_CHANCE`).
- **Problem:** No test runs a save with `shouldSweep` true. The API tests and the e2e server switch the sweep off, and `postgres-blob-store.test.ts:60-75` tests only `deleteOrphans` itself. So two things are unproven: that a save calls the sweep, and that a failing sweep is logged while the save still answers. ARCHITECTURE §8 (`:772`) states the second ("a failed sweep or prune is logged and never fails the request"). The matching rule for the rate-limit prune has its test (`postgres-rate-limiter.test.ts:302-310`, an earlier review's BUG-02). Also, `serviceWith` in `bundle-service.test.ts` passes no `shouldSweep`, so every `upload` in that file sweeps on `Math.random() < 0.02`. That is harmless today (no blob there is an hour old), but the test path is not fixed. The two chances are also set two ways: the prune chance is a named constant in `server.ts` and a required `ApiDeps` field; the sweep chance is an unnamed `0.02` default inside the service.
- **Why it matters:** if a later change lets a sweep error escape `sweepQuietly`, about one save in 50 fails with 500 and no test catches it. The random default makes the service tests run a different path now and then.
- **Fix:** make `shouldSweep` required in `BundleServiceDeps` and `ApiDeps`, with `SWEEP_CHANCE = 0.02` next to `PRUNE_CHANCE` in `server.ts`. Pass `() => false` in `serviceWith`. Add two service tests with `shouldSweep: () => true`: one where `deleteOrphans` is called once, and one where it rejects, `logError` gets `'Could not sweep unused bundle files'`, and the upload still returns `stored`.
- **Effort:** S
- **Confidence:** high (searched `packages/server` and `packages/e2e` for `shouldSweep`, `deleteOrphans` and `sweep`: only the lines named above)

#### QA-06 · Low · Two core tests do not prove the guard their titles name

- [ ] **Where:** `packages/core/test/gzip-bundle-codec.test.ts:115-117`; `packages/core/test/sodium-crypto.test.ts:62-65`
- **Problem:**
  - "rejects a bomb from its size label before decompressing" decodes the honest 65 MB bomb and expects `/too large/`. Without the size-label check (`gzip-bundle-codec.ts:39`), the running-total check (`:46`) throws the same error. Probed with fflate 0.8.3: the stream alone stops the bomb with "Bundle is too large to open". The test passes either way.
  - "refuses settings outside the allowed range before doing any work" asks for 4 GiB and expects any throw. Without `KdfParamsSchema.parse` (`sodium-crypto.ts:36`), libsodium 0.8.4 refuses that value itself (probed: `TypeError: memLimit must be an unsigned integer`). The test passes without the bound it is named for and never checks that no work was done. The value a hostile server would really send, just over 1 GiB (`memoryKiB: 1_048_577`), is one libsodium accepts and would allocate.
- **Why it matters:** These are the two client-side guards against a hostile server (memory at prelogin) and a crafted bundle (decompression bomb). A refactor that drops either guard keeps the suite green. That breaks review 15's standard that "a test whose title promises X asserts it" and that a guard has "a test that sends the hostile value".
- **Fix:** Size label: gzip a small payload, set its last 4 bytes to `MAX_DECOMPRESSED_BUNDLE_BYTES + 1`, and expect `/too large/` (only the size-label check catches it). KDF: use `{ memoryKiB: 1_048_577 }` (and `passes: 11`), and spy on `sodium.crypto_pwhash` to expect it was not called.
- **Effort:** S
- **Confidence:** high (both probed with the installed libraries).

#### QA-07 · Low · The plugin-gate steps push a setup that the leak check never searches

- [ ] **Where:** `packages/e2e/src/steps.ts:674-694` (`gateFirstPc`) and `:739-743` (`STEPS['1']`); the check runs only in `firstPc` (`:475`), `secondPc` (`:576`) and `thirdPc` (`:658`). The docs that say otherwise are `CONTRIBUTING.md:195-196` ("which every e2e test that pushes ends with"), `docs/ARCHITECTURE.md:869` ("Every request is recorded and checked") and `:1203` ("for the steps and every one-OS test").
- **Problem:** step 1 runs `firstPc` and then `gateFirstPc` on the same server. `firstPc` calls `expectNothingReadable` before it returns, and `gateFirstPc` makes its own requests after that. Those are a register for `e2e-gate` and a `push --global --yes` of three plugins in `skills/`: `REVIEW_SKILL` ("Read the diff"), two copies of `MOD_MODULE` (`e2e-mod-seen`) and the broken manifest. Nothing calls `expectNoLeaks` after them. In step 2, `gateSecondPc` only pulls, and its requests also come after `secondPc`'s check.
- **Why it matters:** this is the only e2e push of plugins whose review splits three ways (plain, mod, broken), and it runs cross-OS. If a regression sent one of their names or contents outside the bundle, every e2e test would still pass. QA-05 of review 15 closed this gap for the one-OS tests, but the gate steps were missed.
- **Fix:** end `gateFirstPc` with `expectNoLeaks(server, await secretsOf({ username: 'e2e-gate', password: USER.password }, pc), ['Read the diff', 'e2e-mod-seen', 'gate-plain', 'gate-mod', 'gate-broken'])`, the same way `firstPc` does. Do the same at the end of `gateSecondPc`. Name the gate account as a `const GATE_USER` beside `USER`, so `GATE_LOGIN` and the check share it.
- **Effort:** S
- **Confidence:** high

## Standards to adopt

Review 14's three standards and review 15's seven stay. This round adds these, each from a job the code does in more than one way:

- **One rule for comparing names from a bundle with names on this PC.** Today case is folded five ways: `underFolder(…, { ignoreCase: true })`, `restorer.sameFileKey` (win32 and darwin), `projectKeyOf` (win32 only), the auto-memory `matches` (win32 only) and `homeFolderFor` (never). The plugin review and `skillsPluginFolders` fold nothing (SEC-01, SEC-02, SEC-03). From now on one shared helper decides whether the platform folds names and every comparison of a bundle path, plugin file name, `skills/` folder name or home path goes through it. The contracts schema keeps accepting case twins (`settings.json` and `Settings.json`), so pull is where they are refused or folded.
- **A gate's name list is a function, not a pattern, and it names every variable that loads code or plugins.** `isLoaderVariable(name)` upper-cases inside, as `isRedirectVariable` does (DUP-02); `GIT_CONFIG_PARAMETERS` and `CLAUDE_CODE_PLUGIN_DIRS` are in the lists (SEC-04, SEC-05); every name in a list has a test that sends it (QA-04); and the drift check reads the settings modules those lists live in (BP-01).
- **The mod review covers what a module hooks as well as what it calls,** each pinned to the Claude Code version in its own fixture, so a new hook shows up as a diff too (SEC-08).
- **A Markdown check reads frontmatter the way YAML does:** quoted and unquoted keys alike, and it fails toward showing when the frontmatter is not plain (SEC-07).
- **Nothing pull writes that Claude Code can run is "data".** Saved plugin data is refused or reviewed when it holds what push never saves (`node_modules` first) or files that can run (SEC-06); the threat model and README say so.
- **A pull-time warning speaks for the whole pull, not one setup** (UX-02), and a summary line names what was added and what was left out, not what was offered (UX-01).
- **A limit a bundle has is checked in the plan, with the setup's name, not at encode** (BUG-01).
- **Docs change with the code, in the same task,** and the fix task reads every statement of the rule it changes: the threat model's rows (not only its findings table), ARCHITECTURE sections 6 and 7 and the Part 2 rows, SECURITY.md and ADDING-AN-AGENT (READ-03, READ-04, READ-05, READ-09). Seven statements lagged T117 to T121.
- **A test's title is what it asserts** (QA-02, QA-03, QA-06), and every e2e step that pushes ends with the leak check (QA-07).

Looked at again and left, with the reason:

- The restorer folds case-only duplicate paths into one write (`restorer.ts:194-196`) and the contracts schema accepts both spellings; this is where SEC-01 and SEC-02 are fixed, not a separate finding.
- The e2e `ok()` and `exists` one-liners repeat per test file, and `UPLOAD_QUESTION` is the same regex in two CLI tests; review 14's standard allows one-expression repeats.
- `plugin-data.test.ts` keeps its own `MOD_MODULE` because its module differs (`$.store.set`); not a duplicate of the fixture.
- `GIT_CONFIG_PARAMETERS` (SEC-05) was checked against git 2.56.0 (`core.fsmonitor` runs on every status); the T118 list comment says what the list is for, and this name belongs on it.

## What will break first at scale

1. **Case handling in pull's gates.** Each new path into `skills/` (claude.ai skills and plugins, local marketplaces, plugin folders) has needed its own case and on-disk handling, and this round three High findings are that handling done differently. Files: `packages/cli/src/agents/claude-code/skills-dir-plugins.ts`, `plugin-review.ts`, `account-copies.ts`, `local-marketplaces.ts`, `restorer.ts`.
2. **The gates' deny lists against Claude Code's releases.** `loader-variables.ts` and `reviewed-settings.ts` are hand-kept lists that every new tool or Claude Code variable can slip past (SEC-04, SEC-05), the drift check reads changelog lines only for names it already knows (ARCH-01) and does not run when those modules change (BP-01). An allow-list tied to Claude Code's documented environment page, read by the drift check, is the durable form. Files: `packages/cli/src/env/loader-variables.ts`, `packages/cli/src/agents/claude-code/reviewed-settings.ts`, `packages/cli/scripts/drift/`, `.github/workflows/drift-check.yml`.
3. **Documentation and the server's housekeeping.** `ARCHITECTURE.md` is 1,222 lines and the threat model's rows 12, 13, 19, 20 and 22 are the cells every gate change must touch; seven statements lagged one fix wave. On the server, the orphan sweep anti-joins every user's `bundle_blobs` with no usable index on about 2% of saves (DB-01), the one query that grows with the whole table. Files: `docs/ARCHITECTURE.md`, `docs/security/threat-model.md`, `packages/server/src/bundle-service.ts`, `postgres-blob-store.ts`.

## Suggested order of work

1. **The plugin gate's case handling and grouping: SEC-01, SEC-02, SEC-03, UX-01, DUP-01, READ-01, READ-02.** All in `packages/cli/src/agents/claude-code` (`skills-dir-plugins.ts`, `plugin-review.ts`, `account-copies.ts`, `account-skills.ts`, `local-marketplaces.ts`, `claude-code-adapter.ts`); one shared name-folding helper serves the three security items.
2. **The settings and environment gates: SEC-04, SEC-05, SEC-07, SEC-08, DUP-02, UX-02, ARCH-01, BP-01, QA-04.** `reviewed-settings.ts`, `loader-variables.ts`, `runnable-markdown.ts`, `command-review.ts`, `plugin-dirs.ts`, `env-restore.ts`, the drift check and its workflow, and the loader-variables test; the pinned `MOD_CALLS` fixture splits into hooks and calls.
3. **Plugin data and the import loop: SEC-06, DUP-03.** `plugin-data.ts`, `unknown-files.ts`, `claude-md-imports.ts`, with threat-model row 22 and the README plugin-source row.
4. **Tests: QA-01, QA-02, QA-03, QA-05, QA-06, DUP-04, DUP-05, READ-06, READ-07.** CLI, server and core tests, after 1 to 3 are merged so the shared helpers cover the new tests too.
5. **Contracts, server, CI and e2e: BUG-01, DB-01, SEC-09, QA-07, READ-08.** The push plan's file cap, the sweep's index and named chance, the dev-only advisory, the e2e gate steps' leak check.
6. **Docs: READ-03, READ-04, READ-05, READ-09.** Last, so the text matches the fixed code; each item lists every place the old rule is still stated.

## Not reviewed

- Skipped by rule, 44 files: `pnpm-lock.yaml`, the 7 drizzle snapshots in `packages/server/drizzle/meta/`, images (`.a1x6/images`, `docs/images`), the `.a1x6/` portfolio data and the 27 earlier review records in `docs/reviews/`.
- Git-ignored files (`packages/server/.env`, `node_modules`, build output, `coverage/`) and the untracked `CLAUDE.local.md`.
- Not run: anything against the production database or the hosted API; a Windows or macOS run of the case findings (SEC-01 to SEC-03 rest on how NTFS and default APFS resolve names, documented behaviour; a case-sensitive macOS volume is not affected); whether Claude Code 2.1.296 loads a `CLAUDE_CODE_PLUGIN_DIRS` folder with no prompt of its own (SEC-04, taken from the T99 facts in ARCHITECTURE); a `tool.check` hook with a real mod (SEC-08, read from the 2.1.296 program strings); whether Claude Code parses skill frontmatter as standard YAML (SEC-07, from its docs).
- The e2e suite was not re-run for this report; its last run on this code is the T121 merge (21 of 21 on this PC, CI run 38151021757).
