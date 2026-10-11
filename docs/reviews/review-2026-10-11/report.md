# Code Review — Agent Nomad — 2026-10-11 (review 15)

**Scope:** the whole repository on `dev` at `e062640`, after T95 to T115 (plugin and mod sync, claude.ai skills and plugins, `hooks/`, CLAUDE.md imports, the project's `~/.claude.json` entry, auto memory, `loop.md`, the 2.1.296 state names, `--env-values`, `cli/help-text.ts`, the push and pull summaries). The earlier review records under `docs/reviews` are historical and out of scope.
**Stack:** pnpm monorepo, TypeScript (strict), Node ≥ 22.13; packages `contracts` (Zod schemas), `core` (encryption, bundle format, merge), `cli` (the `agentnomad` command, Commander and clack), `server` (Hono, Drizzle, Neon Postgres, PGlite in tests), `e2e`. Tests with Vitest.
**Coverage:** 320 of 320 files read in full, 48,426 lines. See `files.md` for one row per file.
**Checks run:** `pnpm check` (type check, lint, format, tests) pass: 2,018 passed and 18 skipped in 95 files · `pnpm knip` pass (nothing unused) · `pnpm audit --prod` pass (no known vulnerabilities) · `pnpm test:e2e` pass (21 of 21 on this PC) · CI on `e062640` pass (run 38133024139, 12 jobs).

**How it was done:** nine readers each read one part of the repo line by line and confirmed their findings at exact lines (several by running the real modules offline, or by reading the installed Claude Code 2.1.296 program). The orchestrator re-opened the code behind every High and Medium finding and the main bugs, checked the program strings the two security findings rest on, merged the findings two readers reported twice, and did the cross-file passes. The bar is the "Standards to adopt" of review 14, whose code (dev `5758178`) was clean; everything merged since was new to review.

## Summary

The new code is in good shape for its size (about 13,000 lines since review 14): no Critical finding, 43 findings in all, of which 2 High, 5 Medium and the rest Low. Both High findings and three of the Medium ones are in pull's safety gates, which are the one promise the README makes ("Nothing runs unseen", "`--yes` alone never writes a plugin with code"). A saved local marketplace or plugin folder whose path is a parent of a refused folder (`~/.config`, `~/Library`, `~/Documents`) has its files written without the per-file home-path check, so a crafted bundle can drop a fish or PowerShell profile, a LaunchAgent or an autostart entry (SEC-01). The plugin review does not know the plugin parts Claude Code 2.1.296 starts by itself, `monitors/`, `.lsp.json` and the servers and hooks declared in `plugin.json`, so `pull --yes` writes such a plugin without a question (SEC-02). A saved claude.ai skill that is also a plugin bypasses that review entirely (SEC-03), the mod review does not flag the `$` methods that run tools and commands (SEC-04), and the code-loading gate for environment values is case-sensitive while Windows variable names are not (SEC-05).

The other two Medium findings are about what the user sees and what the tests prove: pull's last summary before writing leaves out what the agent's own questions chose, so the riskiest parts are the ones it does not list (UX-01), and the guards on the git remote that pull clones from, the one place pull runs a program on a value from the bundle, have no test (QA-01).

The Low findings are three narrow bugs (imports counted inside fenced code in CRLF files, the `~/.claude.json` project key taken from the current folder instead of the git root, a 500 on a download racing a save), small message and wording gaps, copied test set-ups, and documentation that did not follow the latest changes: SECURITY.md, the ROADMAP, ARCHITECTURE Part 2 rows, the threat-model header and the README's `--yes` row and "every choice has a flag" sentence. None of the review 14 code regressed.

Nothing found blocks a merge of `dev` into `main` once the two High and the three security Medium findings are fixed; they are all in `packages/cli/src/agents/claude-code` and `packages/cli/src/env`, small, and need no server or bundle-format change.

## Scores

| Area                         | Score /10 | One-line reason                                                                                                                                                               |
| ---------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness                  | 8         | No High bug; three narrow Low bugs (BUG-01 to BUG-03), one of them losing a project's local MCP servers silently.                                                             |
| Security                     | 7         | Encryption, auth and the server hold; pull's safety gates have two holes for crafted bundles (SEC-01, SEC-02) and three narrower gaps (SEC-03 to SEC-05).                     |
| Performance                  | 9         | Nothing new; the known ceilings (whole bundles in memory, per-request database round trips) are unchanged.                                                                    |
| User experience              | 8         | Clear messages and help; pull's last summary is incomplete (UX-01) and five small Low items.                                                                                  |
| Readability                  | 7         | Code well named and commented; nine documentation drifts since T95 (READ-01, READ-08 to READ-14) and three small comment faults.                                              |
| Maintainability              | 8         | Strict lint, knip, shared fakes; the claude.ai skills and plugins paths and several test set-ups are written twice (DUP-01 to DUP-06).                                        |
| Architecture and scalability | 9         | Package and adapter boundaries hold; the agent's plan does not yet report what it adds or drops to the generic summary (UX-01).                                               |
| Test coverage                | 8         | 2,018 tests and cross-OS e2e chains; the git-remote guards (QA-01) and a few "nothing written" rules are untested, and the leak check misses the newest bundle parts (QA-05). |

| Category             | Critical | High  | Medium | Low    |
| -------------------- | -------- | ----- | ------ | ------ |
| Bugs                 | 0        | 0     | 0      | 3      |
| Security             | 0        | 2     | 3      | 1      |
| Database and queries | 0        | 0     | 0      | 0      |
| Performance          | 0        | 0     | 0      | 0      |
| User experience      | 0        | 0     | 1      | 5      |
| Dead code            | 0        | 0     | 0      | 1      |
| Duplication          | 0        | 0     | 0      | 6      |
| Readability          | 0        | 0     | 0      | 14     |
| Refactoring          | 0        | 0     | 0      | 0      |
| Best practices       | 0        | 0     | 0      | 0      |
| System design        | 0        | 0     | 0      | 0      |
| SOLID and OOP        | 0        | 0     | 0      | 0      |
| QA and testing       | 0        | 0     | 1      | 6      |
| **Total**            | **0**    | **2** | **5**  | **36** |

## Fix first

1. **SEC-01** · High · a saved folder's files are not checked against the home-path rules, so a crafted bundle writes into autostart and key folders.
2. **SEC-02** · High · the plugin review ignores `monitors/`, `.lsp.json` and manifest-declared servers and hooks, so `pull --yes` writes such a plugin unasked.
3. **SEC-05** · Medium · a lowercase `node_options` passes the code-loading gate, and on Windows it is `NODE_OPTIONS`.
4. **SEC-03** · Medium · a saved claude.ai skill that is a plugin skips the plugin review, also under `--yes`.
5. **SEC-04** · Medium · mod calls through `$.tool.call`, `$.command.run`, `$.mcp.*`, `$.config.set`, `$.prompt.submit` and `$.session.send` are not flagged.
6. **QA-01** · Medium · the schema and environment guards on the git remote pull clones from have no test.
7. **UX-01** · Medium · pull's summary before "Restore it now?" omits the agent's own choices and counts the wrong files.
8. **BUG-02** · Low · the `~/.claude.json` project entry is keyed by the current folder, so a push from a subfolder loses the local MCP servers silently.
9. **BUG-01** · Low · imports inside fenced code count in CRLF files.
10. **UX-04** · Low · push calls a project's `.claude/scripts/` "left out" after saving it.

## Findings

### Bugs

#### BUG-01 · Low · Imports inside fenced code count in CRLF files

- [ ] **Where:** `packages/cli/src/agents/claude-code/claude-md-imports.ts:88-95` (`withoutFences`)
- **Problem:** lines are split on `\n` only, and the opening pattern `/^ {0,3}(`{3,}|~{3,})(.*)$/`cannot match a line that ends in`\r`, because `.`does not match`\r`. In a CRLF file a fence never opens. The inline-code pass hides a block with no blank line in it, but not one that has a blank line. Run against the module: `"Intro\n\n`sh\necho hi\n\n@notes.md\n`\n\nAfter @real.md\n"`gives`["real.md"]`with LF and`["notes.md","real.md"]` with CRLF.
- **Why it matters:** CLAUDE.md files on Windows are often CRLF. Push then saves, or warns about, a file Claude Code never imports, and pull's allowed set takes in a file Claude Code would not read. Only documents can come this way, so nothing runs. `claude-code-claude-md-imports.test.ts` has no CRLF case.
- **Fix:** split with `/\r?\n/` and rejoin with the original line endings, or use `([^\r]*)\r?$` in the opening pattern. Add the CRLF case above as a test.
- **Effort:** S
- **Confidence:** high

#### BUG-02 · Low · A project's `~/.claude.json` entry is keyed by the current folder, not the git root

- [ ] **Where:** `packages/cli/src/agents/claude-code/claude-json-merge.ts:139-154` (`projectKeyOf`). Callers: `project-collector.ts:161`, and `projectPart` (`:299-316`) with `projectDir` from `push-command.ts:222` and `pull-command.ts:332` (`deps.cwd`).
- **Problem:** T109's own probe of Claude Code 2.1.296 (worker-t109 memory: "key = git root of cwd (else cwd)") says `claude mcp add` keys `projects[...]` by the repository root. `projectKeyOf` uses the folder as given ("the folder as given, with `/` for `\`"). Run push or pull from a subfolder of a repository and push finds no entry (local MCP servers silently not saved). Pull writes an entry under the subfolder's key, which Claude Code never reads. `auto-memory.ts` already finds the repository root for the same reason (`repositoryRoot`, `:51-73`).
- **Why it matters:** local MCP servers do not come along, and nothing is said about it. Running from the repository root works.
- **Fix:** key by the git root as Claude Code does. Use the folder itself only outside a repository. Check whether Claude Code uses the main repository or the worktree root before reusing `repositoryRoot` (which follows `commondir` to the main repository). Add a test from a subfolder.
- **Effort:** S
- **Confidence:** medium (rests on the T109 probe; not run again here)

#### BUG-03 · Low · A download racing a save or delete answers 500 instead of the new copy or 404

- [ ] **Where:** `packages/server/src/bundles/bundle-service.ts:139-146` (with `:182-185` and `:200-204`)
- **Problem:** `download` reads the metadata (blob id X), then the blob, in two separate queries. A concurrent PUT of the same setup commits a new revision and then deletes X (`deleteQuietly(userId, result.replacedBlobId)`). A concurrent DELETE removes the row and X. If either lands between the two reads, `blobs.get` returns null and the code throws a plain `Error`, so the client gets 500 `internal_error` and an `unhandled_error` log line. The comment at `:143` says this can only mean a broken database, which is not true.
- **Why it matters:** A PC that pulls while another pushes or deletes gets "Something went wrong on the server", and the log shows a false alarm. It is rare, and a retry fixes it.
- **Fix:** Read the meta and the bytes in one query (join `bundles` to `bundle_blobs` on `blob_id`). Or, when the blob is null, re-read the meta once: if the setup is gone, throw `BundleNotFoundError`; if the blob id is new, fetch that blob. Add a test with a repository whose `get` returns the old meta after a save.
- **Effort:** S
- **Confidence:** medium (traced in the code; not reproduced)

### Security

#### SEC-01 · High · A saved folder can write files into autostart and key folders inside it

- [ ] **Where:** `packages/cli/src/agents/claude-code/local-marketplaces.ts:421-432` (`homeFolderFor`), `:500-541` (`writeFolders`). The per-file check it relies on is in `packages/cli/src/agents/claude-code/restorer.ts:473-479` (`folderEntryProblem`, batch of the restorer). `plugin-dirs.ts` uses the same two helpers (T99).
- **Problem:** `homeFolderFor` checks only the saved folder's own path: `homePathProblem(savedPath)` and "not inside the base folder". Each saved file is then written to `<dir>/<file>` by `restorer.restoreFolder`. That checks only for a safe relative path, `.git` and Windows names, never `homePathProblem` for the file's full path from home. So a saved local marketplace (or T99 plugin folder) whose `path` is a parent of a refused folder passes, and its files land inside the refused folder. Run against the real modules: `homeFolderFor('.config', …)` gives `~/.config`, `'Library'` gives `~/Library`, `'Documents'` gives `~/Documents`. Yet `homePathProblem('.config/fish/config.fish')` says "a folder whose files run by themselves" and `homePathProblem('.config/gh/hosts.yml')` says "a folder for keys and logins". The same hole applies when `CLAUDE_CONFIG_DIR` sits in a subfolder of home: with base `~/.config/claude`, `homeFolderFor('.config', …)` gives `~/.config`, so a saved file `claude/settings.json` is written into Claude Code's base folder through `restoreFolder`. That skips the global restore rules and the review of the setup's settings. Only plugin folders of installed plugins are reviewed (`:586-613`). Every other file of the saved folder is written without being listed, and a new file needs no answer at all.
- **Why it matters:** this breaks the defence that threat-model rows 20 and 21 claim ("in a folder for keys, autostart files or Claude Code's own folder: `~/.agentnomad/marketplaces/<name>`"), and it brings back the class of resolved findings 1, 10 and 11 there. A pulled bundle can drop a fish or PowerShell profile, a LaunchAgent or an XDG autostart entry, which run by themselves at the next login. It can also replace `~/.config/gh/hosts.yml`. It needs a crafted bundle (a tampered or compromised source PC). A real local marketplace almost never sits at `~/.config` or `~/Library`. The tests cover only a saved path inside a refused folder (`claude-code-local-marketplaces.test.ts:320`, `claude-code-plugin-dirs.test.ts:288`).
- **Fix:** check every file, not only the folder. In `writeFolders` (or `homeFolderFor` returning the home-relative folder with the dir), refuse a file whose path from home (`<savedPath>/<file.path>`) has a `homePathProblem`, or that lands in the base folder (`bundlePathInside(baseDir, native) !== null`). Alternatively, send the whole folder to the fallback when any file would be refused, which keeps it in one piece. Also refuse a `dir` that is an ancestor of `baseDir` (`bundlePathInside(dir, baseDir) !== null`). Add tests for `path: '.config'` with `fish/config.fish`, for `path: 'Library'` with `LaunchAgents/x.plist`, and for a `CLAUDE_CONFIG_DIR` below the saved folder, in both test files.
- **Effort:** S
- **Confidence:** high

#### SEC-02 · High · The plugin review does not see monitors, LSP servers, or servers and hooks declared in `plugin.json`, so `pull --yes` writes them without asking

- [ ] **Where:** `packages/cli/src/agents/claude-code/plugin-review.ts:243-277` (`commandHooksOf`, `reviewPluginFolder`). This one gate is used by `claude-code-adapter.ts:118-136` (`skills/`), `local-marketplaces.ts:610`, `plugin-dirs.ts:289-292` and claude.ai plugins (T101).
- **Problem:** `runsCode` is true only when validate fails or is unavailable, when validate lists mod modules, when `hooks/hooks.json` holds command hooks, or when the folder has `hooks/hooks.json` or `.mcp.json`. The Claude Code 2.1.296 program loads more parts of a plugin that run programs:
  - `monitors/monitors.json`, or a `monitors` entry in the manifest. The program describes these as "Background watch scripts the host arms as persistent Monitor tasks (unsandboxed, same trust tier as hooks)… When omitted, monitors/monitors.json at the plugin root is loaded if present."
  - `.lsp.json`, or `lspServers` in the manifest ("Path to .lsp.json configuration file relative to plugin root" / "LSP server configurations keyed by server name").
  - `mcpServers` and `hooks` written inline in `.claude-plugin/plugin.json`, or pointing at another path.

  The program's own list of plugin-root entries is `["commands","skills","agents","hooks","themes","output-styles","monitors","workflows"]` plus `["SKILL.md",".mcp.json",".lsp.json"]`. A folder with only one of the parts above gets `runsCode: false`. `askPluginFolders` (`:342-345`) then accepts it with no question, including under `--yes`. `commandHooksOf` reads only `hooks/hooks.json`, so command hooks declared in the manifest are not shown either. The general review (`command-review.ts:231-256`) checks settings files, the scope's MCP files and Markdown. It never reads `skills/<plugin>/.lsp.json`, `monitors/monitors.json` or `plugin.json`. No file in `packages/cli/src` mentions `monitors`, `.lsp.json` or `lspServers`.

- **Why it matters:** the README promises "Nothing runs unseen" and "`--yes` alone never writes" a plugin with code (README 66-72, 254-264). A setup, for example one pushed from a compromised or shared PC, can put a plugin into `~/.claude/skills/` whose monitor script or LSP server Claude Code starts on this PC, and pull never shows it or asks about it.
- **Fix:** in `reviewPluginFolder`, set `runsCode` when the folder has `.lsp.json` or anything under `monitors/`. Also set it when the parsed manifest has `hooks`, `mcpServers`, `lspServers` or `monitors`. List these entries in `pluginReviewLines`, as `commandHooks` are listed: each server's command and each monitor's command, read with the existing T44 readers. Put the file and key names in the paths data file (`plugins.runsCodeEntries`), so the weekly drift check covers them. Add a test per entry that runs `askPluginFolders` with `assumeYes: true` and expects the folder to be skipped.
- **Effort:** M
- **Confidence:** high that the gate ignores these parts (code and program strings checked). Medium that Claude Code 2.1.296 starts a `@skills-dir` plugin's monitors, LSP servers and MCP servers with no further consent; check with one probe in an empty `CLAUDE_CONFIG_DIR`.

#### SEC-03 · Medium · A saved claude.ai skill that is a plugin or mod skips the plugin review

- [ ] **Where:** `packages/cli/src/agents/claude-code/after-restore.ts:232-302` (`accountSkills`), `packages/cli/src/agents/claude-code/account-skills.ts:236-240` (`runsCommands`), `packages/cli/src/agents/claude-code/claude-code-adapter.ts:323-328` (the T97 review runs only on the setup's files and the saved claude.ai plugins).
- **Problem:** saved claude.ai skills are turned into `skills/<name>/...` files in the follow-up and written with `restorer.restore` after the plan. They never pass through `reviewSkillsPlugins`. The only gate is `runsCommands`, which looks at `.md` files for `` !` `` lines, ` ```! ` blocks and frontmatter hooks. A skill folder that also holds `.claude-plugin/plugin.json` and `hooks/hooks.json` becomes a skills-dir plugin with command hooks or mod modules (README "Plugins and mods in `skills/`"). It is written without `claude plugin validate` and without the review, and it is not blocked under `--yes`, which adds claude.ai skills by default since T114 (`:254-272`). The restorer's own review (`reviewRunnable`) does not look at `hooks/hooks.json` inside `skills/`. claude.ai plugins take the right path: the adapter adds them before the review "so the T97 gate reviews them (one implementation)".
- **Why it matters:** the README says "A plugin with code is written only after your yes or with `--allow-commands`; `--yes` alone never writes it". A synced skill folder is inert on the source PC (Claude Code does not load plugins from `skills/synced/`), but becomes running code on the PC that pulls it. Whether claude.ai accepts a skill upload holding those two files was not checked.
- **Fix:** treat a saved skill with `PLUGIN_MANIFEST` as a plugin folder. Either leave it out in `planAccountSkills` with a reason ("it is a plugin; save it as a claude.ai plugin"), or move account skills into the plan step next to `withAccountPlugins`, so `reviewSkillsPlugins` sees their `skills/<name>/` files. The second also gives one implementation for both. Add a test with a saved skill holding a manifest and `hooks/hooks.json` under `--yes`.
- **Effort:** S (leave out) / M (move into the plan step)
- **Confidence:** medium (the code path is certain; whether such a skill can exist on claude.ai is not known)

#### SEC-04 · Medium · Mod calls that run tools, commands or MCP servers are not flagged as risky, so the review offers no source and gives no warning for them

- [ ] **Where:** `packages/cli/src/agents/claude-code/reviewed-settings.ts:83-116` (`RISKY_MOD_CALLS`, `riskOfCall`); used by `plugin-review.ts:224-241` and `:313-320`; described in `README.md:259-261`.
- **Problem:** `riskOfCall` flags only `$.process`, `$.model`, `$.net`, `$.http`, `$.fetch`, `$.web`, `$.ws` and `$.fs` writes. The `$` methods the 2.1.296 program names include `$.tool.call`, `$.command.run`, `$.mcp.connect`, `$.mcp.call`, `$.config.set`, `$.session.send` and `$.prompt.submit`; `$.model.complete` exists too, so `$.model` stays. `$.tool.call` runs any tool of the session by name: the program throws `no tool named "${r}"` otherwise, and accepts a `consent` string that it records as a human message (`consent:s … origin:{kind:"human"}`). That includes Bash. A mod whose module calls `$.tool.call` is therefore shown with no `⚠` line, and pull never offers its source. Validate also writes `env writes:` and `state writes:` notes, which `NOTE` (`plugin-review.ts:186`) does not match, so they are dropped from the review.
- **Why it matters:** the mod still needs a yes, because `runsCode` is true for any module. But the user is told about `$.process` while a module that runs shell commands through the Bash tool, starts MCP servers or changes settings looks harmless. The README's "flagging programs, file writes, model and network calls" does not hold for the methods the program has.
- **Fix:** add `$.tool.call` (runs tools, Bash included), `$.command.run` (runs commands), `$.mcp` (starts or calls MCP servers), `$.config.set` (changes settings), and `$.session.send` / `$.prompt.submit` (sends prompts) to `RISKY_MOD_CALLS`. Keep `$.model`. Show `env writes:` lines in the review. Pin the program's method list in a test fixture, as `claude-code-state-names.ts` pins state names (T108), so a newer Claude Code's list shows up as a diff.
- **Effort:** S
- **Confidence:** high for the missing names (program strings; `$.tool.call`'s behavior read in the program). Medium for exactly how validate writes each call on the `calls:` line.

#### SEC-05 · Medium · On Windows, a saved lowercase loader variable such as `node_options` is added without the code-loading gate

- [ ] **Where:** `packages/cli/src/env/loader-variables.ts:12-13`; used at `packages/cli/src/env/env-restore.ts:91-96` (and `:112-120`, where `--yes` adds every "plain" value)
- **Problem:** `LOADER_VARIABLE` is case-sensitive (no `i` flag, names upper case only). Saved names may be lower case: `ENV_NAME` (`env-section.ts:17`) is `/^[A-Za-z_][A-Za-z0-9_]*$/`, and `EnvSectionSchema` accepts it. The redirect check beside it upper-cases first (`agents/claude-code/reviewed-settings.ts:61`, `REDIRECT_NAMES.has(name.toUpperCase())`), the loader check does not. So `node_options` (or `java_tool_options`, `git_ssh_command`, `bash_env`…) counts as a plain variable. On Windows, environment variable names are case-insensitive: `createWindowsEnvWriter` (`shell-profile.ts:222-225`) sets a user variable `node_options`, and every program started later reads it as `NODE_OPTIONS`.
- **Why it matters:** `agentnomad pull --yes` on Windows, without `--allow-commands`, adds a saved `node_options=--require <script>` without asking and without the warning, and every Node program the user starts from then on loads that script. README:158 and `env-restore.ts:56-60` promise the opposite: a variable that makes programs run code "still needs `--allow-commands` or your yes". It needs a setup pushed with such a value (from another PC on the account, compromised or careless), which is the same threat the gate is for. On macOS and Linux the lowercase names do nothing, so the bypass is Windows only.
- **Fix:** test the upper-cased name, as `isRedirectVariable` does: `LOADER_VARIABLE.test(name.toUpperCase())` in `env-restore.ts:91` (and in `agents/claude-code/command-review.ts:155`, see Cross-file notes), or add the `i` flag to the pattern. Add a test that saves `node_options` and `ld_preload` and expects them gated under `--yes`.
- **Effort:** S
- **Confidence:** medium. The code path is confirmed at the lines above, and no test covers a lowercase name (searched `packages/` for `node_options` / `ld_preload`). That Node on Windows reads `node_options` as `NODE_OPTIONS` is how Windows environment lookups work, but it was not run on a Windows PC here.

#### SEC-06 · Low · MCP server names from a bundle are shown without `printableLine`

- [ ] **Where:** `packages/cli/src/agents/claude-code/claude-json-merge.ts:183-215` (`projectPartItems`, `claudeJsonProjectNote`), shown by `claude-code-adapter.ts:321-322` and in `claudeJsonProjectQuestion` (`:35-38`)
- **Problem:** server names and approved or rejected names from the pulled `.agentnomad/claude-json-project.json` are joined into the note and the question as they are. The prompter applies `printable()`, which hides escape sequences but keeps line breaks. A key with `\n` can add lines that look like more entries. Elsewhere, values from a bundle shown on one line use `printableLine` (SEC-03 of an earlier review; `claude-md-imports.ts:339`, `local-marketplaces.ts:488`).
- **Why it matters:** it can make the plan output misleading. The review list itself is not affected.
- **Fix:** map each name through `printableLine` in `projectPartItems`.
- **Effort:** S
- **Confidence:** high

### User experience

#### UX-01 · Medium · Pull's summary leaves out what the agent's own questions chose

- [ ] **Where:** `packages/cli/src/pull/pull-summary.ts:26-47`, `packages/cli/src/pull/pull-command.ts:476-495` and `:595-598`; the tests that pin it: `packages/cli/test/pull-summary.test.ts:5-56`, `packages/cli/test/pull-command.test.ts:956-970`
- **Problem:** T115's last question before writing ("Restore it now?") follows a summary built only from the generic part of the plan: `files` (the bundle's files as downloaded), `conflicts`, `env.toAdd` and `declined` (commands in settings only). The agent's own answers live in `agentPlan` (`AgentRestorePlan`, `adapter.ts:253-263`), which exposes only `declined?: boolean` and is never passed to `pullSummary`. So the summary never names the claude.ai skills or plugins the user just agreed to add, plugin data, plugin installs, or plugin/mod folders the review left out; its "N files" counts files the agent plan later drops and misses the account-plugin files it adds (`withAccountPlugins`, `claude-code-adapter.ts:234-238`); and "--allow-commands no (what runs programs is left out)" appears only for declined settings commands, not for a declined plugin folder (`agentPlan.declined`, used for `partial` at `pull-command.ts:539`). Push's summary does list each optional part with its flag (`push-command.ts:346-355`), so the two summaries differ.
- **Why it matters:** README ("From scripts and CI") says push and pull "show what they will save or write and ask once more". On pull the parts left out are the ones that add code (claude.ai plugins, plugins and mods), so the last confirmation shows the least about the riskiest part. Nothing is written that the user did not answer yes to earlier, so this is wording, not a hole.
- **Fix:** let `AgentRestorePlan` carry a short `summary: readonly string[]` (e.g. `--account-plugins yes (2)`, `--plugin-data no`, `plugin folders left out: x`) filled by the Claude Code plan step, and have `pullSummary` append it to the "Restored only when you choose" line; show `--allow-commands no` when `declined || agentPlan.declined`. Add a `pull-command.test.ts` case with an account plugin and a declined mod folder.
- **Effort:** M
- **Confidence:** high
- **Also found by a second reviewer:** `packages/cli/src/pull/pull-command.ts:476-487` (the `files` and `declined` the summary gets are set here), `:494` (the agent's plan runs after), `:597` (`pullSummary(plan.restores)`); `packages/cli/src/pull/pull-summary.ts:30-44`; the agent's changes at `packages/cli/src/agents/claude-code/claude-code-adapter.ts:326-333` and `:388`

#### UX-02 · Low · Older CLIs warn once per file of every saved claude.ai plugin

- [ ] **Where:** `packages/cli/src/agents/claude-code/account-plugins.ts:148-161` (`collectAccountPlugins`), `global-paths.ts:60`
- **Problem:** each file of a saved plugin is its own reserved entry `.agentnomad/account-plugins/<name>/<file>`. CLIs 1.0.3 to 1.0.6 refuse unknown reserved entries one by one with "Refused …: unknown agentnomad entry" (shown by the T100 and T102 old-CLI proofs, one warning per file). T98 chose one packed file per marketplace for exactly this reason (`global-paths.ts:95-99`). Since T114, push saves claude.ai plugins unless told no, so a default push makes a bundle that prints one warning per plugin file on an older CLI.
- **Why it matters:** pull on an older CLI works but prints noise in proportion to plugin size. The data itself is fine.
- **Fix:** pack each plugin into one `.agentnomad/account-plugins/<name>.json`, as `SAVED_FOLDER_SHAPE` does for local marketplaces. Keep reading the folder layout for bundles already saved. Otherwise accept the noise and say so in ARCHITECTURE.
- **Effort:** M
- **Confidence:** medium (old-CLI behaviour taken from the T100 and T102 proofs; not run for this layout)

#### UX-03 · Low · Push leaves out some of the user's own claude.ai skills without saying so

- [ ] **Where:** `packages/cli/src/agents/claude-code/account-skills.ts:149-162`
- **Problem:** a skill judged `'own'` is skipped in silence when its name fails `isUsableSkillName` or its folder is missing (`isDirectory`). `readSyncedPlugins` names both cases ("its name cannot be a folder in ~/.claude/skills", "its folder here has no …", `account-plugins.ts:113-125`).
- **Why it matters:** the README promises "push names any skill it leaves out". A skill that is in the manifest but not yet downloaded just disappears from the copy.
- **Fix:** add both cases to `leftOut`, with the same wording as `readSyncedPlugins`. Add a test.
- **Effort:** S
- **Confidence:** high

#### UX-04 · Low · For a project, push calls `.claude/` folders "left out" when their hook scripts or imported files were saved

- [ ] **Where:** `packages/cli/src/agents/claude-code/unknown-files.ts:116-161` (project branch `:134-146`; only the global branch adds `hookScriptNames` and `importedNames`, `:149-154`).
- **Problem:** the project collector saves every script a project hook runs inside the project (`project-collector.ts:199-211`, `hook-scripts.ts:128-160`, e.g. `.claude/scripts/check.sh`). It also saves every document the project's memory files import (`:212`, T111). `restore-rules.ts:194-199` writes both back. `findUnknownEntries` for a project counts only the data file's lists, so `.claude/scripts/` is reported and push says "Only this is left out, because agentnomad does not know it yet: .claude/scripts/." For the global setup the same case is handled (T49 for scripts, T111 for imports).
- **Why it matters:** the warning contradicts what push saved, and it suggests updating agentnomad when nothing is missing.
- **Fix:** in the project branch, add the top-level `.claude/` names of `projectHookScripts(...)` bundle paths and of the project's imported files, as `hookScriptNames` and `importedNames` do for the global setup. Add one test for a hook script in `.claude/scripts/`.
- **Effort:** S
- **Confidence:** high (code read on both sides; the existing project test at `claude-code-unknown-files.test.ts:123-133` has no hook-script case).

#### UX-05 · Low · `pull --env-values <names>` says nothing when the setup has no saved values

- [ ] **Where:** `packages/cli/src/pull/pull-command.ts:456-475`; compare `packages/cli/src/env/env-restore.ts:69-72` and `packages/cli/src/push/push-command.ts:326-332`
- **Problem:** pull only checks the names given to `--env-values` inside `planEnvRestore`, which runs only when the setup has an `.agentnomad/env.json` section. With no section (or a damaged one, which `parseEnvSection` turns into `null`), the names are dropped and nothing is said. When a section exists but lacks a name, pull warns "Not in the saved setup, so not added". Push warns for every named value it does not save.
- **Why it matters:** a script running `agentnomad pull --env-values GITHUB_TOKEN` against a setup saved without values exits with 0 and says nothing, so the user believes the token was added.
- **Fix:** when `options.envValues` is a list and `section` is `null`, warn with the same "Not in the saved setup, so not added: …" line. Add a test.
- **Effort:** S
- **Confidence:** high

#### UX-06 · Low · A size just over a limit is shown as equal to the limit

- [ ] **Where:** messages in `packages/cli/src/agents/claude-code/plugin-data.ts:178-181` (T102), `packages/cli/src/agents/claude-code/local-marketplaces.ts:213-216` (T98, also used by T99 plugin folders) and `packages/cli/src/push/push-command.ts:530`; pinned by `packages/cli/test/claude-code-plugin-data.test.ts:158-165` and `packages/cli/test/claude-code-plugin-dirs.test.ts:193-202`
- **Problem:** `formatSize` (`src/ui/format-size.ts`) rounds to one decimal in MB, so anything up to about 50 KB over 5 MB prints the same as the limit. The tests pin the result: "the data of probe-mod@skills-dir is 5.0 MB, over the 5.0 MB limit for one plugin" and "its files are 5.0 MB, more than the 5.0 MB a saved setup can hold".
- **Why it matters:** The user is told a folder is left out because 5.0 MB is more than 5.0 MB. It reads like a bug and gives no idea how much to remove.
- **Fix:** One helper next to `formatSize`, for example `formatOverLimit(size, limit)`, that adds decimals (or says how much over, "5.0 MB, 1 B over the 5.0 MB limit") when the two round to the same text; use it in the three messages and update the two pinned strings.
- **Effort:** S
- **Confidence:** high

### Dead code

#### DEAD-01 · Low · `Pc.runScript` has no caller since T115, and two ARCHITECTURE rows still describe the removed push helper

- [ ] **Where:** `packages/e2e/src/pc.ts:48-49,122`; `docs/ARCHITECTURE.md:1182,1198`
- **Problem:** `runScript` ran `push-env-value.ts` (at `5758178`: `steps.ts:316`, `await pc.runScript(PUSH_ENV_VALUE, …)`). T115 (`a078b01`) deleted that file, and `git grep runScript` now finds only the interface member and its implementation. knip does not report unused members of an interface. ARCHITECTURE still says pc.ts runs "the built CLI … or another Node script" (`:1182`). Its `knip.json` row says the entries include "the e2e push helper, which runs as a child process" (`:1198`), but the e2e entry is now `src/fake-claude.ts` (`knip.json:5-7`).
- **Why it matters:** dead test plumbing, and two file-reference rows that describe a file that no longer exists.
- **Fix:** remove `runScript` from `Pc` and `newPc`. Make the pc.ts row "runs the built CLI (or `E2E_CLI`) with no terminal; small file helpers", and the knip row "(including the e2e fake `claude`, which runs as a child process through the launcher pc.ts writes)".
- **Effort:** S
- **Confidence:** high

### Duplication

#### DUP-01 · Low · claude.ai skills and plugins repeat the same plan and question code

- [ ] **Where:** `account-skills.ts:210-247` against `account-plugins.ts:185-223` (group bundle files by name, sort, skip synced and local names, map to `skills/`). `after-restore.ts:241-266` against `account-plugins.ts:281-304` (list, ask with default yes, "Not added. To add them later" hint). `account-skills.ts:212` writes out the `NamesHere` type that `account-plugins.ts:173-178` exports. `readSyncedSkills` and `readSyncedPlugins` share their account loop and notice building.
- **Problem:** T101 copied T42's flow. The two have already drifted (UX-03, and SEC-03's different review path).
- **Why it matters:** a fix to one is easy to miss in the other.
- **Fix:** one `planSavedFolders(prefix, bundleFiles, here, extraCheck)` used by both. Use `NamesHere` in `planAccountSkills`. One `askSavedCopies` for the list, question and hint, with the wording passed in.
- **Effort:** M
- **Confidence:** high

#### DUP-02 · Low · Small file and JSON helpers live outside their shared module

- [ ] **Where:** `local-marketplaces.ts:457-461` (`exists`, exported, used by `plugin-dirs.ts:16,273`) and `account-skills.ts:116-117` (`isDirectory`), beside `system/files.ts:10-11` (`isFile`, "files and programs, one copy each", T62). `claude-json-merge.ts:111-115` (`isJsonObject`, `strings`) against `command-review.ts:183-184` (the same `strings`) and `JsonObjectSchema` in `system/json.ts`.
- **Problem:** generic helpers are defined again inside feature modules. `exists` is a file-system helper exported from the local-marketplaces module only because T99 needed it.
- **Why it matters:** this goes against the "one copy each" rule of `system/`. A third copy is likely.
- **Fix:** move `exists` and `isDirectory` into `system/files.ts`, and `strings` and `isJsonObject` into `system/json.ts`, and import them from there.
- **Effort:** S
- **Confidence:** high

#### DUP-03 · Low · The Claude Code plan step and test restorer are set up by hand in several test files

- [ ] **Where:** the plan step, with `executableLookup` (linux, `/usr/bin/claude`), `validateCli`, `findPluginValidator`, `claudeCodeAdapter` and a full `RestorePlanContext` literal: `packages/cli/test/claude-code-account-plugins.test.ts:260-299`, `packages/cli/test/claude-code-adapter.test.ts:250-277` (and the same context literal at `:64-77` and `:158-168`), `packages/cli/test/claude-code-plugin-data.test.ts:212-244` (another batch). The test restorer, `createClaudeCodeRestorer({ baseDir: base, homedir: home, platform: process.platform, env: {}, customConfigDir: false, isClaudeRunning: () => Promise.resolve(false) })`: `packages/cli/test/claude-code-account-skills.test.ts:270-277`, `packages/cli/test/claude-code-local-marketplaces.test.ts:225-232`, `packages/cli/test/claude-code-plugin-dirs.test.ts:232-239` (another batch).
- **Problem:** The context literal with `conflictAnswer: undefined` appeared once in the CLI tests at review 14 (`5758178`) and appears five times now (`git grep -c`). The 8-line restorer block is the same in three files. The plan-step block is about 25 lines in each copy and differs only in the validate report and the overrides. The project's standard is that a multi-line structure tests repeat is taken from a shared helper named in `CONTRIBUTING.md`.
- **Why it matters:** When `RestorePlanContext` or the restorer's dependencies gain a field (as `parts` did in T114), every copy must be edited the same way, and a copy that drifts tests a different setup from the others without anyone noticing.
- **Fix:** Add `planStepWith(validate, answers, overrides)` and `testRestorer()` to `packages/cli/test/claude-code-plugin-fixtures.ts` (or `claude-code-project-fixtures.ts`, next to `claudeCodeAdapter`), use them in the five files, and name them in the Tests section of `CONTRIBUTING.md`.
- **Effort:** S
- **Confidence:** high

#### DUP-04 · Low · The probe mod is written into `skills/` by a hand loop in five tests while `writeModFolder` exists

- [ ] **Where:** helper `packages/cli/test/claude-code-plugin-fixtures.ts:663-668` (`writeModFolder`); copies: `packages/cli/test/claude-code-plugin-data.test.ts:69-74` (`modInSkills`), `packages/cli/test/claude-code-plugin-review.test.ts:322-328`, `packages/cli/test/claude-code-adapter.test.ts:297-299` (batch R4), `packages/cli/test/pull-command.test.ts:693-695` and `:778-780` (other batch)
- **Problem:** Each copy is `for (const file of modFiles(...)) await writeTestFile(join(dir, ...file.path.split('/')), file.content)`, which is what `writeModFolder(dir)` does (with `dir` = `<base>/skills/probe-mod`). `plugin-review.test.ts:326` even decodes the content to a string first. `git grep "for (const file of modFiles"` finds the helper plus these five.
- **Why it matters:** CONTRIBUTING says to use a named helper instead of a new copy. When the mod's layout changes (as `modFiles` did for the T97 probe), the copies must stay in step by hand.
- **Fix:** Replace each loop with `await writeModFolder(join(base, 'skills', MOD_NAME))` (in `plugin-data.test.ts` the `modInSkills` function can go). Optionally add `writeModInSkills(base)` to the fixtures and name it in CONTRIBUTING.
- **Effort:** S
- **Confidence:** medium (the facts are certain; whether a one-statement loop crosses the "multi-line structure" bar is a judgement call)

#### DUP-05 · Low · The local marketplace catalog is written out twice in the plugin fixtures

- [ ] **Where:** `packages/cli/test/claude-code-plugin-fixtures.ts:557-562` (`writeLocalMarketplace`) and `:688-693` (`savedLocalMarketplace`)
- **Problem:** Both build the same `.claude-plugin/marketplace.json` object, `{ name, owner: { name: 'me' }, plugins: [{ name: MOD_NAME, source: './probe-mod' }] }`, one to write it on disk and one to save it in an entry. Neither is a value an assertion compares against.
- **Why it matters:** The saved entry is meant to be what push writes from the folder `writeLocalMarketplace` makes (its doc comment says so). If one copy changes, push-side and pull-side tests use different catalogs without anyone noticing.
- **Fix:** `const localCatalog = (name: string) => ({ name, owner: { name: 'me' }, plugins: [{ name: MOD_NAME, source: `./${MOD_NAME}` }] })` in the fixtures file, used by both.
- **Effort:** S
- **Confidence:** high

#### DUP-06 · Low · The e2e tests copy the fake-claude path and the mod and marketplace layout of `steps.ts`

- [ ] **Where:**
  - `FAKE_CLAUDE`: `packages/e2e/src/steps.ts:52`, `test/account-parts.test.ts:15`, `test/local-marketplaces.test.ts:21`, `test/plugin-data.test.ts:16`, `test/plugin-dirs.test.ts:15`.
  - The mod folder writer: `steps.ts:85-89` (`writeMod`), `plugin-dirs.test.ts:23-27` (`pluginFolder`, the same three writes), `plugin-data.test.ts:53-56`.
  - The marketplace catalog and mod: `steps.ts:361-369`, `local-marketplaces.test.ts:31-50`.
  - Near-identical `MOD_MODULE` texts: `steps.ts:47-48`, `local-marketplaces.test.ts:25-26`, `plugin-dirs.test.ts:19-20`.
  - `ok` and `exists` in six and two test files.
- **Problem:** the e2e package has no shared set-up file. `pc.ts` exports `newPc`, `read`, `write`, `forward` and `isExecutable`, which seven files use, but CONTRIBUTING's shared-helper list (`:119-189`) does not name it. So each T98–T114 test rebuilt the probe mod, the local marketplace and the path to the built fake. By the review-14 standard, one-expression idioms such as `ok`, `exists` and `FAKE_CLAUDE` may repeat on their own. The finding is the repeated multi-line mod and marketplace layout, together with the unnamed shared file.
- **Why it matters:** a change to the mod shape Claude Code accepts, or to where the fake is built, has to be made in four or five files.
- **Fix:** move `FAKE_CLAUDE`, `MOD_MODULE`, `writeMod` and a `writeLocalMarketplace(dir, name)` into `packages/e2e/src/` (for example `pc.ts`, or a `fixtures.ts`). Use them from the tests, and name the file and its helpers in CONTRIBUTING's Tests section.
- **Effort:** S
- **Confidence:** medium (the standard allows the short repeats; the layout copy is a judgement call)

### Readability

#### READ-01 · Low · ARCHITECTURE Part 2 rows miss two exports

- [ ] **Where:** `docs/ARCHITECTURE.md` rows for `local-marketplaces.ts` and `global-paths.ts`. Code: `local-marketplaces.ts:457` (`exists`), `global-paths.ts:93` (`PLUGIN_VERSIONS_BUNDLE_PATH`, T100).
- **Problem:** the `local-marketplaces.ts` row lists the folder rules shared with T99 but not `exists`, which `plugin-dirs.ts` imports. The `global-paths.ts` row lists the reserved bundle paths (`plugins.json`, `programs.json`, …) but not `plugin-versions.json`.
- **Why it matters:** this breaks review 14's standard: "A new export of a file is named in that file's row … when the row lists what the file holds."
- **Fix:** add both to the rows, or drop `exists` from the row once DUP-02 moves it.
- **Effort:** S
- **Confidence:** high
- **Also found by a second reviewer:** `docs/ARCHITECTURE.md:1127` (row for `skills-dir-plugins.ts`) and `:1117` (row for `synced-plugins.ts`); the exports are `skills-dir-plugins.ts:13` `SKILLS_DIR_MARKETPLACE`, `:19` `PLUGIN_HOOKS` (T97) and `synced-plugins.ts:17` `SYNCED_PLUGINS_DIR` (T101).
- **Also found by a second reviewer:** `packages/cli/src/cli/help-text.ts:109-118`; `docs/ARCHITECTURE.md:1004`

#### READ-02 · Low · `AgentContents` says it has four lists; it has seven

- [ ] **Where:** `packages/cli/src/agents/adapter.ts:265-286` (T115).
- **Problem:** the comment says "The four lists are the README table's cells, item for item". The interface has seven lists: `global`, `globalAlso`, `project`, `projectAlso`, `globalNever`, `globalNeverAlso`, `projectNever`. The `…Also` lists come from other README rows.
- **Why it matters:** someone adding a second agent reads this contract first and may fill it wrong.
- **Fix:** "The lists are the README 'What is synced' cells, item for item: the `…Also` lists come from the rows other than Global and Project."
- **Effort:** S
- **Confidence:** high

#### READ-03 · Low · An orphaned doc comment in `plugins.ts`

- [ ] **Where:** `packages/cli/src/agents/claude-code/plugins.ts:41-46`.
- **Problem:** the block "One saved marketplace and one saved plugin, as pull accepts them. Push checks each entry with the same schema before saving it (BUG-01)…" sits right before a second doc comment on `MarketplaceNameSchema`, which T98 (`84a36ae`) inserted between it and the two schemas it describes. Editors and TypeDoc attach only the last block, so the BUG-01 rule is attached to nothing.
- **Why it matters:** the reason push and pull share one schema is easy to miss, and that rule is what keeps pull from refusing what push saved.
- **Fix:** move `MarketplaceNameSchema` and its comment above the BUG-01 block, so the block sits on `MarketplaceEntrySchema`.
- **Effort:** S
- **Confidence:** high

#### READ-04 · Low · README's `--yes` row says pull leaves environment values out, but pull adds every plain one

- [ ] **Where:** `README.md:164`; the code is `packages/cli/src/env/env-restore.ts:112-120` (`deps.assumeYes ||` adds the plain values)
- **Problem:** the `-y, --yes` row (push, pull, …) says `--yes` "leaves out memory, environment values and plugin data". For pull that is wrong. The `--env-values` row two lines up (README:158), `FLAG_HELP.yes.pull` (`cli/help-text.ts:55`, "add missing plain environment values") and `docs/ARCHITECTURE.md:815` ("every plain one") all say pull's `--yes` adds them. The README test checks the flags are listed, not this wording.
- **Why it matters:** a user who reads the `--yes` row expects `pull --yes` to write no environment values, but it adds them to the shell profile or Windows user variables.
- **Fix:** "…it includes your claude.ai skills and plugins and leaves out memory and plugin data; push saves no environment values and pull adds every plain one."
- **Effort:** S
- **Confidence:** high

#### READ-05 · Low · CONTRIBUTING lists five shared test helper files as separate rules instead of under "Shared test helpers live in these files"

- [ ] **Where:** `CONTRIBUTING.md:143-178` (entries for `claude-code-state-names.ts`, `claude-code-settings-reference.ts`, `claude-code-plugin-fixtures.ts`, `stub-restorer.ts`, `readme.ts`)
- **Problem:** The list opened at `:119` nests `fakes.ts` (`:121`) and `claude-code-project-fixtures.ts` (`:135`) with two spaces; the next five entries start at column 0 (`- `), so they render as top-level rules of the Tests section, between "Shared test helpers live in these files" and "Use a named constant", rather than as items of the helper list.
- **Why it matters:** The review standard relies on this list ("a helper named in CONTRIBUTING.md"). As rendered, a reader sees two helper files and five loose bullets, and can miss that the plugin fixtures are part of the shared set.
- **Fix:** Indent those five entries (and their continuation lines) by two spaces so they sit under the helper list.
- **Effort:** S
- **Confidence:** high

#### READ-06 · Low · `help-text.ts` names the wrong test file

- [ ] **Where:** `packages/cli/src/cli/help-text.ts:6-7`
- **Problem:** the header says "program.test.ts checks the README Commands and "What is synced" tables against it". The Commands table is checked in `help-text.test.ts:18-31`; the "What is synced" table is checked in `claude-code-contents-data.test.ts:6-46`, against `CLAUDE_CODE_CONTENTS`, not against `help-text.ts`. `program.test.ts` checks the Flags table.
- **Why it matters:** someone changing a command's words looks in the wrong file for the check that will fail.
- **Fix:** "help-text.test.ts checks the README Commands table against it; program.test.ts checks the Flags table against the declared flags."
- **Effort:** S
- **Confidence:** high

#### READ-07 · Low · `readme.ts` does a little less than its comments say

- [ ] **Where:** `packages/cli/test/readme.ts:9-16`, `:18-34`
- **Problem:** `tableRows` says it returns "the body rows of the first Markdown table in `section`", but it keeps every line starting with `|` in the section and drops the first two, so a second table in the same section would add its header and `---` rows as body rows. `readmeSection` ends a section at any line matching `/^#{1,6} /`, which includes a `# comment` line inside a fenced shell block. Neither happens in the three sections read today (Commands, Flags, What is synced each hold one table and no such line), so nothing fails now.
- **Why it matters:** both are latent: a README edit (a second table under "What is synced", a `# …` comment in an example) would make the drift checks fail or pass for the wrong reason.
- **Fix:** stop `tableRows` at the first non-`|` line after the table starts; skip fenced blocks in `readmeSection`, or fix the comments to say what the code does.
- **Effort:** S
- **Confidence:** high

#### READ-08 · Low · README says every push and pull choice has a flag; six questions have none, on purpose

- [ ] **Where:** `README.md:171-172`
- **Problem:** "Every choice push and pull ask about has a flag". These questions have no flag:
  - push's "Push anyway?" after a partial pull (`packages/cli/src/push/push-command.ts:380-381`);
  - push's replace-the-newer-copy question (`push-command.ts:391-396`);
  - pull's "Restore this older copy anyway?" (`packages/cli/src/pull/pull-command.ts:318`);
  - pull's close-Claude-Code select (`packages/cli/src/agents/claude-code/claude-code-adapter.ts:304-312`);
  - "Write … anyway?" for a broken plugin, and "Show the source of …?" (`packages/cli/src/agents/claude-code/plugin-review.ts:361-370`).

  `docs/ARCHITECTURE.md:807-832` lists these exceptions with (\*), (\*\*) and (\*\*\*). The README states the rule with no exception, and its own line 248-249 ("one that `claude plugin validate` finds broken only after your yes") contradicts it.

- **Why it matters:** someone writing a script looks for a flag that does not exist, for example to restore an older copy or write a broken plugin.
- **Fix:** "Every choice about what to save or restore has a flag; the safety questions (replacing a newer or older copy, a broken plugin, closing Claude Code) only a person can answer yes to, and `--yes` answers them no."
- **Effort:** S
- **Confidence:** high

#### READ-09 · Low · ROADMAP still lists claude.ai plugins as Planned; the README roadmap has no claude.ai row

- [ ] **Where:** `docs/ROADMAP.md:90`; `README.md:326-332`
- **Problem:** the claude.ai account items table says "**Plugins turned on in claude.ai** | Planned". T101 built this: the `account-plugins` optional part (`packages/cli/src/agents/claude-code/claude-code-adapter.ts:171-201`), and T114 made it saved unless the user says no. What shipped is narrower than the row says. It covers plugins the user uploaded (My Uploads); "turned on" ones from the directory or an organization are never saved. The README's Roadmap table also has no "claude.ai account items" row, though `docs/ROADMAP.md:10` has one (Started).
- **Why it matters:** the public roadmap says a shipped, default-on feature is not built yet, and the two roadmap tables disagree.
- **Fix:** ROADMAP:90 becomes "**Plugins you uploaded to claude.ai** | Done (`--account-plugins`) | Only your own uploads; saved unless you say no, added as `skills/<name>/` after the plugin review; directory and organization plugins never." Add the claude.ai row to the README table, or drop the row from both.
- **Effort:** S
- **Confidence:** high

#### READ-10 · Low · SECURITY.md says pull writes outside the agent's folder only the scripts its hooks run

- [ ] **Where:** `SECURITY.md:44-46`
- **Problem:** "It only restores files outside the agent's folder that its own hooks run, never into a Startup, autostart or shell-profile folder." Since T98, T99 and T111 this is no longer true. Pull now also writes the following outside `~/.claude`:
  - saved local marketplace folders and `CLAUDE_CODE_PLUGIN_DIRS` folders, at the same path from home (`packages/cli/src/agents/claude-code/local-marketplaces.ts:421-433`, `homeFolderFor`);
  - files that memory files import (`packages/cli/src/agents/claude-code/restore-rules.ts:104-109`: "documents its memory files import (T111)");
  - auto memory.

  The threat model's rows 20, 21 and 23 describe these correctly. SECURITY.md also does not mention the plugin review (T97). That review is now the defence for code those folders bring.

- **Why it matters:** this is the page users read to learn what pull can write on their PC, and it understates it.
- **Fix:** "Outside the agent's folder it writes only scripts the setup's own hooks run, saved plugin and marketplace folders (after the plugin review) and Markdown files its memory files import, never into a Startup, autostart or shell-profile folder." Add a clause that plugins with code need a yes or `--allow-commands`.
- **Effort:** S
- **Confidence:** high

#### READ-11 · Low · ARCHITECTURE's list of Claude Code's pull questions misses three

- [ ] **Where:** `docs/ARCHITECTURE.md:296-299` (and the flowchart node at `:291`)
- **Problem:** the doc lists the agent's own questions as "closing Claude Code …, then saved claude.ai plugins and the plugin folders in `skills/`, then plugins, programs and claude.ai skills". `planRestore` also asks three more:
  - the saved local marketplaces (`planLocalMarketplaces`, `claude-code-adapter.ts:337-343`);
  - the `CLAUDE_CODE_PLUGIN_DIRS` folders (`planPluginDirs`, `:344-349`);
  - plugin data (`planPluginData`, `:354-356`, asked last).

  Each has its own review or conflict questions. The adapter's own comment (`claude-code-adapter.ts:288-294`) names marketplaces and plugin data. The flowchart's "after restore: plugins, missing programs, account skills" also leaves out plugin data, which is written last (`:384-387`).

- **Why it matters:** this paragraph is the map for anyone adding a question to pull, and it is missing half of the T98–T102 questions.
- **Fix:** "…then saved claude.ai plugins and the plugin folders in `skills/`, saved local marketplaces (T98) and `CLAUDE_CODE_PLUGIN_DIRS` folders (T99), then plugins, programs, claude.ai skills and plugin data (T102)". Add "plugin data" to the flowchart node.
- **Effort:** S
- **Confidence:** high

#### READ-12 · Low · CONTRIBUTING and ARCHITECTURE describe the e2e package as the three-step chain only

- [ ] **Where:** `CONTRIBUTING.md:33,202-206`; `docs/ARCHITECTURE.md:855,935-941`
- **Problem:**
  - CONTRIBUTING's script table says `pnpm test:e2e` uses "four simulated PCs". The cross-OS steps now make six (`steps.ts` first, second, third, stale, gate-first, gate-second). Six more test files make two each: `account-parts`, `claude-md-imports`, `global-auto-memory`, `local-marketplaces`, `plugin-data`, `plugin-dirs`.
  - CONTRIBUTING:202-204 says a push, pull or bundle change "belongs in the end-to-end steps too (`steps.ts`)". T98, T99, T102, T110, T111 and T114 added a one-OS test file each instead, and the rule does not say when that is the right place.
  - ARCHITECTURE section 11 (`:855`) and the Part 2 test-file list ("Every other test file is one of these", `:924-941`) name only `cross-os.test.ts` for e2e. The six new files are not named after a module, so they belong in that list and are missing from it.
- **Why it matters:** a contributor following CONTRIBUTING has two places to add an e2e check and no rule to pick one. The file reference no longer covers every test file, which the review-14 standard requires.
- **Fix:**
  - CONTRIBUTING:33: "(the cross-OS steps and one-OS scenario tests)".
  - CONTRIBUTING:202: "…in the cross-OS steps (`steps.ts`) when it must cross operating systems, else in a scenario test of its own in `packages/e2e/test/`".
  - ARCHITECTURE:940: add the six files with one phrase each, for example "`local-marketplaces.test.ts` (T98, one OS)".
- **Effort:** S
- **Confidence:** high

#### READ-13 · Low · ADDING-AN-AGENT misses `contents` (T115) and the `files` argument of `versionNotice` (T103)

- [ ] **Where:** `docs/ADDING-AN-AGENT.md:223-249` (`:229` in particular)
- **Problem:**
  - Step 6 documents `inspector.versionNotice(savedWith, here)`. The interface is `versionNotice?(savedWith, here, files)` (`packages/cli/src/agents/adapter.ts:210-214`), so an adapter can name what in the setup this PC's version cannot run.
  - Step 6 does not mention `AgentAdapter.contents` (`adapter.ts:306-307`, T115). That field is what `push --help` and `pull --help` show under "What is saved" and "What is restored". A new adapter without it has no such section, and nothing in the guide says to add it.
- **Why it matters:** the guide is the contract for new adapters; a new agent would ship without the help section T115 added for every agent.
- **Fix:** change `:229` to `inspector.versionNotice(savedWith, here, files)` with "and what in `files` this version cannot run (Claude Code: mods)". Add a bullet: "**`contents`:** what a setup always, optionally and never holds, in the words of `--help` (see `claude-code/claude-code-contents.data.ts`)".
- **Effort:** S
- **Confidence:** high

#### READ-14 · Low · The threat model's header says "updated through T104"; rows from T109–T114 follow it

- [ ] **Where:** `docs/security/threat-model.md:3`
- **Problem:** "updated through T104". Rows 12, 18 and 23 and the `hooks/` and logins paragraphs (`:71-84`) were changed or added in T108, T109, T110, T111, T112 and T114 (`git log 5758178..e062640 -- docs/security/threat-model.md`).
- **Why it matters:** a reader reads the date line to decide whether the model covers the newest features. This one says it does not.
- **Fix:** "updated through T114".
- **Effort:** S
- **Confidence:** high

### QA and testing

#### QA-01 · Medium · The guards on the git remote that pull clones from have no test

- [ ] **Where:** `packages/cli/test/claude-code-local-marketplaces.test.ts:260-301` (the re-clone tests); guards in `packages/cli/src/agents/claude-code/local-marketplaces.ts:43-59` (`RemoteSchema`, the commit pattern) and `:94-108` (`findGit`: `GIT_ALLOW_PROTOCOL`, `GIT_TERMINAL_PROMPT`, `GCM_INTERACTIVE`, ssh `BatchMode`)
- **Problem:** Pull runs `git clone -- <saved remote> <folder>` and then `git reset --quiet <saved commit>` from a saved local marketplace (T98). The source refuses a remote that starts with `-`, holds `::` (git's `ext::` helper runs any command) or holds white space, and accepts only a 40 or 64 character hex commit. `findGit` also limits git to `file:git:http:https:ssh` and turns off every password prompt. No test sends a hostile saved entry (for example `remote: "ext::sh -c touch% x"`, `remote: "--upload-pack=x"`, `commit: "--hard"`), and no test looks at the env `findGit` builds. I searched `packages/cli/test` for `ext::`, `findGit`, `GIT_ALLOW_PROTOCOL` and `GIT_TERMINAL_PROMPT`: no hits. The only "cannot be read" test (`:412-420`) uses an entry with missing fields. If the pattern were loosened to `z.string()`, or the env line dropped, all 475 tests in this batch would still pass.
- **Why it matters:** This is the one place where pull runs a program on a value read from the bundle. Both lines of defence (the schema and `GIT_ALLOW_PROTOCOL`) can be broken by a refactor without any test failing. A broken guard means command execution on the pulling PC from a bundle, which is worse than a wrong file written.
- **Fix:** In the T98 pull block, add `it.each` over hostile entries (`ext::…`, a leading `-`, a space or control character, a non-hex or short commit). For each, assert that `plan.marketplaces` is empty, the "could not be read" line is shown and `scriptedGit` got no calls. Add one test that calls `findGit` with `executableLookup` and a recording `ProgramCli` factory (or reads the env it passes) and asserts `GIT_ALLOW_PROTOCOL`, `GIT_TERMINAL_PROMPT=0` and ssh `BatchMode` unless the user set `GIT_SSH_COMMAND`.
- **Effort:** S
- **Confidence:** high

#### QA-02 · Low · Two plugin-folder pull tests do not check the "nothing written" their titles promise

- [ ] **Where:** `packages/cli/test/claude-code-plugin-dirs.test.ts:288-291` and `:393-400`
- **Problem:** "never writes into a folder for keys and logins" saves a folder at `.ssh/probe-mod` and only asserts that the fallback `~/.agentnomad/plugin-dirs/probe-mod` exists; nothing checks that `home/.ssh/probe-mod` was not made. "says so when a saved plugin folder cannot be read, and writes nothing" only checks the message; nothing checks that no folder was written. The keys-folder guard itself is `homePathProblem` via `homeFolderFor` in `local-marketplaces.ts` (correct today).
- **Why it matters:** These are the tests that stand for a security promise (pull never writes into `~/.ssh`). A change that wrote to the saved path and also made the fallback, or wrote part of an unreadable entry, would still pass.
- **Fix:** Add `expect(await exists(join(home, '.ssh', MOD_NAME))).toBe(false)` to the first test, and `expect(await exists(modFolder())).toBe(false)` to the second. The same one-line negative check fits `claude-code-local-marketplaces.test.ts:320-325` (batch R4).
- **Effort:** S
- **Confidence:** high

#### QA-03 · Low · A spare "yes" is appended to every scripted push and pull

- [ ] **Where:** `packages/cli/test/pull-command.test.ts:86` (`pushFrom`) and `:116` (`pullOn`), `packages/cli/test/push-command.test.ts:123` (`setup`)
- **Problem:** to answer T115's "Upload/Restore it now?" the helpers always append `true` to the script, whether or not that question comes. In a run where it does not come (flags answered everything, `--yes`), the spare `true` stays and would answer any new yes/no question a regression adds. Tests that also assert `asked` equals `[]` catch that; several do not (e.g. `pull-command.test.ts:297`, `:360-365`, `:418`, `:812`, `:854`; `push-command.test.ts:524-528`).
- **Why it matters:** "`--yes` and full flags ask nothing" is a promise to scripts (README "From scripts and CI"). A new question in those paths could pass these tests silently. The no-terminal tests (`pull-command.test.ts:982-988`, `push-command.test.ts:911-915`) cover only one path each.
- **Fix:** answer the summary question by its text and nothing else (e.g. wrap the scripted prompter so `confirm(RESTORE_IT)` / `confirm(UPLOAD_IT)` gets `options.restore ?? true` and every other question takes from the script), or check `script.left` is empty after each run that asks.
- **Effort:** S
- **Confidence:** medium (no hidden question exists today; this is a gap in what the tests would catch)

#### QA-04 · Low · The README checks run one way only

- [ ] **Where:** `packages/cli/test/help-text.test.ts:19-30`, `packages/cli/test/program.test.ts:560-570`
- **Problem:** the Commands check walks `COMMAND_HELP` and looks each command up in the README table; the Flags check walks the declared flags and looks each up in the README rows. Neither checks the other way: a README row for a command or flag the program no longer has (or a misspelt one) passes.
- **Why it matters:** T115's goal is that the README and the CLI's words "cannot drift apart" (`help-text.ts:3-7`). A removed or renamed flag would leave a README row that documents something the CLI refuses with "unknown option".
- **Fix:** also assert that every README Commands row names a key of `COMMAND_HELP` (`account` aside) and every flag in the Flags table's first column is in `declaredFlags()` for each command its row lists.
- **Effort:** S
- **Confidence:** high

#### QA-05 · Low · The leak check does not search for the T101 and T109 parts, and the one-OS e2e tests never run it

- [ ] **Where:** `packages/e2e/src/steps.ts:132-178`; `docs/security/threat-model.md:63-69`
- **Problem:** `expectNothingReadable` searches requests for a fixed list of strings.
  - Step 1 pushes the uploaded claude.ai plugin manifest (`ACCOUNT_PLUGIN`, `"my-account-plugin"`, `steps.ts:60,456`) and the project's `~/.claude.json` server (`notes-mcp.js`, `steps.ts:112`). Neither is in the list (`:135-168`), though `docs-mcp` and `db.js`, the same kinds of content, are.
  - Plugin data (T102), imported files (T111), every project's auto memory (T110) and the T114 defaults are pushed only by the one-OS tests. Those tests (`plugin-data`, `claude-md-imports`, `global-auto-memory`, `account-parts`, `local-marketplaces`, `plugin-dirs`) never call the leak check on `server.requests`.

  The threat model (`:63-66`) says the e2e run fails if any request contains "file contents". CONTRIBUTING:202-204 asks for a push or bundle change to be in the steps "including the check that nothing readable leaves the PC".

- **Why it matters:** the risk is small, because all of a setup is sealed as one bundle. Still, a new code path that sent one of these parts outside the bundle (a name in a header, metadata) would pass every e2e test.
- **Fix:** add `'my-account-plugin'` and `'notes-mcp.js'` to the list. Export a small `expectNoLeaks(server, known, extra)` from `steps.ts` (or a helper file named in CONTRIBUTING), and call it at the end of each one-OS test with that test's own strings (`CHOICE`, `'Use tabs.'`, `OTHER_NOTES`, `SKILL_MD`, `MOD_MODULE`).
- **Effort:** M
- **Confidence:** medium (that the strings are missing and the calls absent is certain; the leak risk itself is low)

#### QA-06 · Low · The local-marketplaces test runs git with the real home folder, so the developer's global git ignore applies

- [ ] **Where:** `packages/e2e/test/local-marketplaces.test.ts:52-67`
- **Problem:** `git()` passes `...process.env` with only `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM` changed. `GIT_CONFIG_GLOBAL` replaces the global config file only. git still reads the default global excludes and attributes files, `$XDG_CONFIG_HOME/git/ignore` or `$HOME/.config/git/ignore`, from the real home. Checked with git 2.56.0 and a stand-in home: with `GIT_CONFIG_GLOBAL` at an empty file, `git check-ignore -v` still matched a name from `<HOME>/.config/git/ignore`.

  If a developer's real global ignore matches `CHANGELOG.md`, `notes.md` or `README.md`, `git add CHANGELOG.md` (`:121`) fails, or `git add -A` (`:73`) leaves the file out, and the test fails or proves less. The CLI's own git runs are fine: `newPc` sets `HOME`/`USERPROFILE` and strips `XDG_CONFIG_HOME` (`pc.ts:32,84-87`).

- **Why it matters:** the house rule is that tests never read the real home folder (CONTRIBUTING:115-116). This one does, and its result can then depend on the machine.
- **Fix:** in `git()`, also set `HOME` and `USERPROFILE` to `remotes` and remove `XDG_CONFIG_HOME`, for example `{ ...process.env, HOME: remotes, USERPROFILE: remotes, XDG_CONFIG_HOME: undefined, … }` (pass `remotes` in place of `config`, and derive the config path from it).
- **Effort:** S
- **Confidence:** high

#### QA-07 · Low · The cross-OS steps check that the shell profile names the variable, not that it holds the value

- [ ] **Where:** `packages/e2e/src/steps.ts:258-262`
- **Problem:** the comment says "The saved environment value: in the shell profile". The assertion is `expect(await read(profile.path)).toContain(ENV_NAME)`. A profile block that names `AGENTNOMAD_E2E_TOKEN` with an empty or wrong value passes. That is the end-to-end proof that the value travelled, encrypted, from step 1 to steps 2 and 3. On Windows the check is skipped by design (`PRESET_ENV`).
- **Why it matters:** a regression in writing the value (quoting, home-path rewriting) would pass the cross-OS chains.
- **Fix:** `expect(profile).toContain(ENV_VALUE)`, or match the exact line the shell writer makes (for example `` `${ENV_NAME}='${ENV_VALUE}'` ``).
- **Effort:** S
- **Confidence:** high

## Standards to adopt

Review 14's three standards stay (shared test helpers named in `CONTRIBUTING.md`; a new export named in its ARCHITECTURE Part 2 row; literals that pin a stored format stay literals). The new code calls for these:

- **Every file pull writes from a bundle passes the home-path rules, not only its folder:** a saved folder's files are checked one by one with `homePathProblem` and against Claude Code's own folder before any write (SEC-01), and every path from a bundle is printed through `printableLine` (SEC-06).
- **The plugin review knows every plugin part Claude Code starts by itself,** and the list lives in the paths data file so the weekly drift check covers it: `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `monitors/`, and the `hooks`, `mcpServers`, `lspServers` and `monitors` keys of `plugin.json` (SEC-02). The `$` methods the mod review flags are pinned in a fixture, as the state names are (SEC-04).
- **One gate for everything that lands in `skills/`:** saved claude.ai skills go through the same plan step and review as saved claude.ai plugins and local plugin folders (SEC-03, DUP-01).
- **Names from a bundle are compared the way the target PC compares them:** environment variable names are upper-cased before the loader and redirect checks (SEC-05).
- **The agent's plan reports what it adds and drops,** so the generic summary before "Restore it now?" and "Upload it now?" shows every choice (UX-01).
- **A guard that keeps pull from running a program on bundle data has a test that sends the hostile value** (QA-01), and a test whose title promises "nothing written" asserts it (QA-02).
- **Docs change with the code, in the same task:** README tables and claims, SECURITY.md, the threat model's header and rows, ROADMAP status, ARCHITECTURE Part 2 rows and ADDING-AN-AGENT (READ-01, READ-08 to READ-14).

Looked at again and left, with the reason:

- `$.model` stays in `RISKY_MOD_CALLS`: one reader believed 2.1.296 has no such method, but the program names `$.model.complete`. SEC-04 asks to add names, not to drop this one.
- Push and pull's summary question is asked only when the plan asked something (T115). A no-terminal script without `--yes` still fails at the first unanswered question as before; nothing to change.
- The `--account-skills` and `--account-plugins` defaults (T114) and the T97 plugin review were re-read and hold, apart from SEC-03.

## What will break first at scale

1. **Pull's safety review as Claude Code grows.** Every new plugin part Claude Code starts by itself (monitors and LSP servers today, SEC-02) and every new `$` method (SEC-04) is a hole until agentnomad learns it. The weekly drift check reads paths and settings keys but not these lists; adding them to the data file and the check is the one durable fix. Files: `packages/cli/src/agents/claude-code/plugin-review.ts`, `reviewed-settings.ts`, `claude-code-paths.data.ts`, `packages/cli/scripts/drift/`.
2. **The Claude Code adapter's size.** `packages/cli/src/agents/claude-code` is 35 files and about 9,600 lines, with the skills and plugins paths written twice (DUP-01) and small helpers outside `system/` (DUP-02). The second agent will copy what is shared unless it moves to `agents/shared/` first. Files: `account-skills.ts`, `account-plugins.ts`, `after-restore.ts`, `local-marketplaces.ts`, `plugin-dirs.ts`.
3. **Tests and documentation.** The CLI tests are 17,800 lines with the plan step and restorer set up by hand in five files (DUP-03) and the probe mod written by hand in five tests (DUP-04); `ARCHITECTURE.md` is 1,200 lines that every change must update and nine of its statements lagged this round. The server is unchanged since review 14, and its known ceilings (unlimited reads per account were fixed in review 5; whole bundles in memory; per-request session and rate-limit statements) stand as described there.

## Suggested order of work

1. **Pull's safety gates and the Claude Code adapter: SEC-01, SEC-02, SEC-03, SEC-04, SEC-06, BUG-01, BUG-02, UX-02, UX-03, UX-04, DUP-01, DUP-02, READ-02, READ-03.** All in `packages/cli/src/agents/claude-code`; SEC-03 and DUP-01 share one fix (account skills into the plan step).
2. **Environment values and the command line: SEC-05, UX-01, UX-05, UX-06, READ-04, READ-06, READ-07, QA-03, QA-04.** `packages/cli/src/env`, `cli`, `push`, `pull` and their tests; UX-01 needs a field on `AgentRestorePlan` that the adapter fills.
3. **Server and e2e: BUG-03, DEAD-01, DUP-06, QA-05, QA-06, QA-07.** No migration; the e2e leak check and fixtures.
4. **CLI tests: QA-01, QA-02, DUP-03, DUP-04, DUP-05, READ-05.** After 1 and 2 are merged, so the shared helpers cover the new tests too.
5. **Docs: READ-01, READ-08, READ-09, READ-10, READ-11, READ-12, READ-13, READ-14.** Last, so the text matches the fixed code.

## Not reviewed

- Skipped by rule, 24 files: `pnpm-lock.yaml`, the 8 drizzle snapshots in `packages/server/drizzle/meta/`, 8 images (`.a1x6/images`, `docs/images`), the `.a1x6/` portfolio data and the earlier review records in `docs/reviews/`.
- Git-ignored files (`packages/server/.env`, `node_modules`, build output, `coverage/`) and the untracked `CLAUDE.local.md`.
- Not run: anything against the production database or the hosted API; a Windows run of SEC-05 (the finding rests on how Windows resolves variable names, documented behaviour); a probe of whether Claude Code 2.1.296 starts a `skills/` plugin's monitors and LSP servers with no further consent (SEC-02, the program strings say monitors load "if present"; the fix task should run one probe in an empty `CLAUDE_CONFIG_DIR`); whether claude.ai accepts a skill upload that holds a plugin manifest (SEC-03).
- Open from the code alone: whether Claude Code keys `~/.claude.json` projects by the main repository or the worktree root (BUG-02; T109's probe said git root of the current folder).
