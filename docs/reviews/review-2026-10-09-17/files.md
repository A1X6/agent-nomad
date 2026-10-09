# File Ledger — Agent Nomad — 2026-10-09 (review 17)

51 files, 15,013 lines, all read in full on branch `review-reports` at `ee2f8d5` (the files T95, T96, the review-15 fixes and the review-16 fixes changed, `30eb20f..ee2f8d5`). Verdicts: 13 clean, 36 minor, 2 needs work, 0 rewrite. Finding IDs refer to `report.md` in this folder.

## After the fixes

All 46 findings are fixed on the review branch the same day. The 38 files that had a `minor` or `needs work` verdict now read `fixed`; their finding IDs stay in the last column as the record. Rows, line counts and descriptions are as reviewed at `ee2f8d5`. One test file is new since the review: `packages/cli/test/import-cycles.test.ts` (ARCH-01).

## CLI: agent adapters (`packages/cli/src/agents`)

The adapter interfaces every agent implements, the shared helpers, and the Claude Code adapter: what push collects, what pull may write, the review of anything that can run, the plugins and mods in the skills folder (T96) and the claude.ai synced skills (T42). Push and pull call it only through `adapter.ts`.

| File                                                            | Lines | What it does                                                                                                                                                             | Verdict | Findings         |
| --------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ---------------- |
| `packages/cli/src/agents/adapter.ts`                            | 296   | The agent-neutral adapter interfaces every command uses to reach an agent, `reviewCovers` and `RESERVED_DIR`.                                                            | fixed   | READ-01          |
| `packages/cli/src/agents/shared/bundle-paths.ts`                | 43    | Pure bundle-path rules for any adapter: `underFolder`, and now `inHomeFolder` and `isSensitiveHomePath`.                                                                 | fixed   | ARCH-02          |
| `packages/cli/src/agents/shared/file-gathering.ts`              | 168   | Walks and reads an agent's files into bundle entries with link, size and clutter limits.                                                                                 | fixed   | PERF-01          |
| `packages/cli/src/agents/claude-code/account-skills.ts`         | 173   | Reads claude.ai synced skills, saves the user's own, and plans which pull may add as local skills (never a plugin).                                                      | fixed   | DEAD-01, ARCH-02 |
| `packages/cli/src/agents/claude-code/claude-code-adapter.ts`    | 163   | Wires detector, collectors, restorer, inspector and the plan step into one adapter for this PC.                                                                          | fixed   | READ-13          |
| `packages/cli/src/agents/claude-code/claude-code-paths.data.ts` | 274   | The one data file of every list the adapter syncs, skips or refuses, Zod-checked at load.                                                                                | clean   | —                |
| `packages/cli/src/agents/claude-code/command-review.ts`         | 356   | Finds what in settings, MCP and Markdown files runs programs and which entries are new or changed.                                                                       | fixed   | ARCH-01, READ-13 |
| `packages/cli/src/agents/claude-code/env-files.ts`              | 28    | Names the files where a Claude Code setup uses `${VAR}`, now with the plugin MCP path rule.                                                                              | fixed   | ARCH-01          |
| `packages/cli/src/agents/claude-code/global-collector.ts`       | 195   | Collects the global `~/.claude` setup, hook scripts, programs, `~/.claude.json` keys, plugins and account skills.                                                        | fixed   | READ-13          |
| `packages/cli/src/agents/claude-code/global-paths.ts`           | 137   | Named views and lookups over the data file for the global scope, `isPluginGenerated`, `neverSyncedIn`, `TOOL_CONFIG_PATHS`.                                              | fixed   | READ-01          |
| `packages/cli/src/agents/claude-code/managed-settings.ts`       | 228   | Detects organization-managed settings and words the notices and plugin-failure reasons.                                                                                  | fixed   | READ-01, READ-02 |
| `packages/cli/src/agents/claude-code/plugin-sync.ts`            | 342   | Plans, asks about and runs `claude plugin` reinstalls with a cmd.exe-safe program runner.                                                                                | clean   | —                |
| `packages/cli/src/agents/claude-code/plugin-validate.ts`        | 87    | Writes a pulled plugin to a temporary folder under a fixed name and runs `claude plugin validate --json` there.                                                          | fixed   | READ-13          |
| `packages/cli/src/agents/claude-code/project-collector.ts`      | 135   | Collects a project's `.claude/` setup, hook scripts, auto memory and plugins.                                                                                            | clean   | —                |
| `packages/cli/src/agents/claude-code/restore-rules.ts`          | 144   | Pure rules for where each bundle entry may be written, or why it is refused.                                                                                             | fixed   | ARCH-02, BP-01   |
| `packages/cli/src/agents/claude-code/restorer.ts`               | 466   | Writes a pulled setup with merges, backups, line endings and refusals; the script sets and other-OS warnings are module functions.                                       | fixed   | READ-01, DUP-01  |
| `packages/cli/src/agents/claude-code/settings-commands.ts`      | 177   | Pure readers of a settings file's hooks and commands, their words and their program.                                                                                     | fixed   | PERF-02          |
| `packages/cli/src/agents/claude-code/skills-dir-plugins.ts`     | 428   | Pure text rules for plugins in `skills/`: finds them, reads their declarations with the reason for any unreadable part, the validate report and the folder-level review. | fixed   | ARCH-01          |
| `packages/cli/src/env/env-references.ts`                        | 101   | Finds `${VAR}` references in the MCP and settings files an adapter names, with where each is used.                                                                       | fixed   | BUG-01, UX-01    |
| `packages/cli/src/system/json.ts`                               | 32    | The shared JSON-object schema and the never-throwing `parseJsonWith` and `valueOrNull`.                                                                                  | clean   | —                |
| `packages/cli/src/index.ts`                                     | 78    | The package's barrel file for tests and the e2e package.                                                                                                                 | clean   | —                |

## CLI: commands (`packages/cli/src/cli`, `packages/cli/src/push`, `packages/cli/src/pull`)

The commander program and the two commands, plan step then apply step, reaching agents only through the adapter interfaces.

| File                                    | Lines | What it does                                                                                                                         | Verdict | Findings                     |
| --------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ------- | ---------------------------- |
| `packages/cli/src/cli/program.ts`       | 273   | Builds the commander program: every command, flag and help text, handing parsed options to injected handlers.                        | fixed   | READ-07, QA-15               |
| `packages/cli/src/pull/pull-command.ts` | 618   | Pull's plan step (choose, download, review what runs, ask every question) and apply step (write, remember the revision, env values). | fixed   | BUG-02, UX-02, DUP-02, QA-02 |
| `packages/cli/src/push/push-command.ts` | 546   | Push's plan step (choose, collect, the adapter's notes, revision checks) and apply step (encrypt, upload).                           | fixed   | DUP-02, QA-03                |

## Lint configuration

| File               | Lines | What it does                                                                                         | Verdict | Findings |
| ------------------ | ----- | ---------------------------------------------------------------------------------------------------- | ------- | -------- |
| `eslint.config.js` | 117   | The lint boundaries: the agent boundary and the pure modules kept from `node:*` and the file walker. | fixed   | ARCH-02  |

## CLI tests (`packages/cli/test`)

Vitest tests of the CLI, one file per module, with shared fakes and fixtures.

| File                                                       | Lines | What it does                                                                                                                                                              | Verdict | Findings                                       |
| ---------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------- |
| `packages/cli/test/adapter.test.ts`                        | 18    | The direct test of `reviewCovers`, the one function `agents/adapter.ts` exports.                                                                                          | fixed   | BP-02                                          |
| `packages/cli/test/agent-boundary.test.ts`                 | 333   | Runs push and pull against a second, hand-built adapter to prove the adapter boundary.                                                                                    | clean   | —                                              |
| `packages/cli/test/claude-code-account-skills.test.ts`     | 272   | Tests reading and saving claude.ai synced skills, the plan (a plugin is never added, every account's problem kept) and pull adding them.                                  | clean   | —                                              |
| `packages/cli/test/claude-code-adapter.test.ts`            | 168   | Tests the adapter's plan step, identity and wiring, and the T96 push note through the real `describeCollected`.                                                           | fixed   | REF-01                                         |
| `packages/cli/test/claude-code-after-restore.test.ts`      | 268   | Tests program installs, plugin reinstalls, the plan and follow-up split, unreadable saved files and the managed-settings explanation.                                     | fixed   | QA-01, DUP-03, QA-08, READ-09                  |
| `packages/cli/test/claude-code-global-collector.test.ts`   | 442   | Tests what the global collector takes from a realistic `~/.claude`, including the probe mod minus its generated folder.                                                   | fixed   | READ-12, QA-11                                 |
| `packages/cli/test/claude-code-managed-settings.test.ts`   | 209   | Tests detecting managed settings per OS, the remote cache, the notices and `explainPluginFailure`.                                                                        | fixed   | QA-09, READ-10                                 |
| `packages/cli/test/claude-code-paths-data.test.ts`         | 72    | Checks the data file against the named views and tables `isPluginGenerated`.                                                                                              | fixed   | READ-11                                        |
| `packages/cli/test/claude-code-plugin-fixtures.ts`         | 256   | Shared plugin fixtures: installed plugins, managed-settings fakes, the probe mod in both scopes, the generated folder, the real validate report.                          | fixed   | READ-10                                        |
| `packages/cli/test/claude-code-plugin-validate.test.ts`    | 160   | Tests `createPluginValidator` with a recording `claude`: not installed, the fixed folder name, the four no-report reasons as a table, unsafe path.                        | fixed   | QA-05, READ-09                                 |
| `packages/cli/test/claude-code-project-collector.test.ts`  | 203   | Tests what the project collector takes, links and the size limit, including the mod in `.claude/skills/` minus its generated folder.                                      | fixed   | QA-12                                          |
| `packages/cli/test/claude-code-project-fixtures.ts`        | 170   | Temporary home and project folders, the collectors, the real adapter, and the claude.ai synced folder in two formats.                                                     | clean   | —                                              |
| `packages/cli/test/claude-code-restore-rules.test.ts`      | 185   | Table tests of `globalDestination` and `projectDestination`: refusals, home-script rules, the generated-folder refusal.                                                   | fixed   | QA-06                                          |
| `packages/cli/test/claude-code-restorer.test.ts`           | 913   | Tests the restorer on real files: round trips, refusals, conflicts, the `~/.claude.json` merge, per-OS fixes, the combined review.                                        | fixed   | QA-07, REF-01                                  |
| `packages/cli/test/claude-code-skills-dir-plugins.test.ts` | 532   | Tests `pluginFolders`, `readPlugin` in every shape with the reasons for unreadable parts, `pluginNotes`, `reviewPlugins` and `readValidateReport`.                        | fixed   | QA-04, REF-01, READ-08                         |
| `packages/cli/test/env.test.ts`                            | 717   | Tests `env/`: the `${VAR}` scan (plugins included), the env section, the shell-profile block, the Windows writer, restoring values and `agentnomad env`.                  | fixed   | UX-01, DEAD-03, QA-13, QA-14, REF-01, READ-13  |
| `packages/cli/test/fakes.ts`                               | 435   | The shared test fakes (temporary folders, collected files, prompter, reporter, bundle server, secret store, `fakeExecutables` with overrides) that load no agent adapter. | clean   | —                                              |
| `packages/cli/test/pull-command.test.ts`                   | 983   | Drives `agentnomad pull` end to end against a fake bundle server with the real adapter, including the T96 block on plugins and mods in both scopes.                       | fixed   | QA-02, QA-10, REF-01, DEAD-02, DUP-04, READ-13 |
| `packages/cli/test/push-command.test.ts`                   | 676   | Drives `agentnomad push` with a fake collecting adapter, including the `describeCollected` info line.                                                                     | fixed   | QA-03, DUP-04, REF-01                          |
| `packages/cli/test/stub-restorer.ts`                       | 15    | A restorer that reviews nothing, has no conflicts and writes nothing, for tests about other parts.                                                                        | clean   | —                                              |

## End-to-end (`packages/e2e`)

| File                        | Lines | What it does                                                                                                                                   | Verdict | Findings |
| --------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| `packages/e2e/src/steps.ts` | 499   | The three cross-OS end-to-end steps against the local API, with the probe mod, its generated folder, the push note and the review line checks. | clean   | —        |

## Documentation

| File                            | Lines | What it does                                                                                                      | Verdict | Findings                           |
| ------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------- |
| `README.md`                     | 232   | User-facing overview, features, flags, exit codes and the "What is synced" table.                                 | clean   | —                                  |
| `CONTRIBUTING.md`               | 223   | Setup, conventions, test rules and the shared-helper list (every export of the three helper files is named).      | fixed   | READ-04, READ-06                   |
| `docs/ADDING-AN-AGENT.md`       | 353   | The guide for writing an adapter against the real interfaces.                                                     | fixed   | READ-01                            |
| `docs/ARCHITECTURE.md`          | 893   | How the system works plus the file-by-file reference and where each module's tests live.                          | fixed   | READ-03, READ-04, READ-05, READ-11 |
| `docs/security/threat-model.md` | 181   | Assets, attackers, the 19-row threat table, the fixed findings and accepted risks; rows 18 and 19 match the code. | clean   | —                                  |
