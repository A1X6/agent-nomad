# File Ledger — Agent Nomad — 2026-10-09 (review 15)

35 files, 11,138 lines, all read in full at `dev` `a8de540` (the files T95 and T96 changed, `30eb20f..a8de540`). Verdicts as reviewed: 7 clean, 26 minor, 2 needs work, 0 rewrite. Finding IDs refer to `report.md` in this folder.

## After the fixes

All 40 findings are fixed on the review branch the same day. The 28 files that had a `minor` or `needs work` verdict now read `fixed`; their finding IDs stay in the last column as the record. Rows, line counts and descriptions are as reviewed at `a8de540`.

## CLI: agent adapters (`packages/cli/src/agents`)

The adapter interfaces every agent implements, and the Claude Code adapter: what push collects, what pull may write, the review of anything that can run, and (T96) the plugins and mods in the skills folder. Push and pull call it only through `adapter.ts`.

| File                                                            | Lines | What it does                                                                                                                                                                                    | Verdict | Findings                               |
| --------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------- |
| `packages/cli/src/agents/adapter.ts`                            | 294   | The agent-neutral adapter interfaces; T96 made `reviewRunnable` async, let a reviewed entry's `file` be a folder (`reviewCovers`) and added the optional `describeCollected`.                   | clean   | —                                      |
| `packages/cli/src/agents/claude-code/claude-code-adapter.ts`    | 163   | Builds the Claude Code adapter for this PC, wiring the plugin validator into the restorer and `pluginNotes` into the inspector.                                                                 | fixed   | QA-01                                  |
| `packages/cli/src/agents/claude-code/claude-code-paths.data.ts` | 272   | The one data file of every Claude Code path list, Zod-checked at load; T95 added `policy-limits.json.stamp.json` and `plugins.generatedInPlugin`.                                               | fixed   | READ-02                                |
| `packages/cli/src/agents/claude-code/global-paths.ts`           | 114   | Gives the data file's global lists names and lookups; T96 added `PLUGIN_GENERATED_PATHS` and `isPluginGenerated` (whole segments, case kept).                                                   | fixed   | SEC-03, DUP-02                         |
| `packages/cli/src/agents/claude-code/skills-dir-plugins.ts`     | 374   | Pure text rules for plugins in `skills/`: finds them, reads hooks and MCP sources in every manifest shape, names them for push, reads a validate report and builds the folder-level review.     | fixed   | BUG-01, SEC-02, READ-03, DUP-03, QA-03 |
| `packages/cli/src/agents/claude-code/plugin-validate.ts`        | 67    | Writes a pulled plugin to a temporary folder, runs `claude plugin validate --json` there with a 60 s timeout, and never throws.                                                                 | fixed   | SEC-01, UX-02, QA-04                   |
| `packages/cli/src/agents/claude-code/command-review.ts`         | 357   | Finds what in settings, MCP and Markdown files runs programs and which entries are new or changed; `hookEntries`, `serverEntries` and `unreadableEntry` are now exported for the plugin review. | fixed   | DUP-03                                 |
| `packages/cli/src/agents/claude-code/restore-rules.ts`          | 145   | Pure rules for where a bundle entry may be written; T96 refuses anything under `.claude-plugin/types`.                                                                                          | fixed   | SEC-03                                 |
| `packages/cli/src/agents/claude-code/global-collector.ts`       | 201   | Collects the global setup; its skip predicate now also drops what Claude Code generates in a plugin folder.                                                                                     | fixed   | DUP-02                                 |
| `packages/cli/src/agents/claude-code/project-collector.ts`      | 141   | Collects a project setup, with the same skip-predicate extension.                                                                                                                               | fixed   | DUP-02                                 |
| `packages/cli/src/agents/claude-code/restorer.ts`               | 445   | Writes a pulled setup; `reviewRunnable` is now async and appends `reviewPlugins` with the injected validator.                                                                                   | fixed   | QA-02                                  |
| `packages/cli/src/index.ts`                                     | 77    | The package's barrel file; exports the two new modules.                                                                                                                                         | clean   | —                                      |

## CLI: commands (`packages/cli/src/push`, `packages/cli/src/pull`)

Push and pull, plan step then apply step, reaching agents only through the adapter interfaces.

| File                                    | Lines | What it does                                                                                                                                                            | Verdict | Findings              |
| --------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------- |
| `packages/cli/src/pull/pull-command.ts` | 601   | Pull's plan step (choose, download, review what runs, ask every question) and apply step (write, remember the revision, env values); T96 drops a declined folder whole. | fixed   | PERF-01, UX-01, QA-05 |
| `packages/cli/src/push/push-command.ts` | 546   | Push's plan step (choose, collect, the adapter's notes, revision checks) and apply step (encrypt, upload); T96 prints `describeCollected` notes.                        | clean   | —                     |

## Lint configuration

| File               | Lines | What it does                                                                                                           | Verdict | Findings       |
| ------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------- | ------- | -------------- |
| `eslint.config.js` | 113   | The lint boundaries: the agent boundary, the pure modules; T96 added `skills-dir-plugins.ts` to the no-`node:*` block. | fixed   | READ-04, BP-01 |

## CLI tests (`packages/cli/test`)

Vitest tests of the CLI, one file per module, with shared fakes and fixtures.

| File                                                       | Lines | What it does                                                                                                                                                                 | Verdict | Findings                                             |
| ---------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------- |
| `packages/cli/test/agent-boundary.test.ts`                 | 333   | Runs push and pull against a second, hand-built adapter to prove the adapter boundary; T96 only made its `reviewRunnable` return a Promise.                                  | clean   | —                                                    |
| `packages/cli/test/claude-code-account-skills.test.ts`     | 245   | Tests reading and saving claude.ai synced skills and pull adding them, plus (T95) the no-`creatorType` 2.1.295 case.                                                         | fixed   | READ-11                                              |
| `packages/cli/test/claude-code-global-collector.test.ts`   | 449   | Tests what the global collector takes from a realistic `~/.claude`, including (T96) a plugin in `skills/` minus its generated `.claude-plugin/types/`.                       | fixed   | DUP-01                                               |
| `packages/cli/test/claude-code-paths-data.test.ts`         | 61    | Checks the data file against the named views and (T96) `isPluginGenerated` on a table of paths.                                                                              | clean   | —                                                    |
| `packages/cli/test/claude-code-plugin-fixtures.ts`         | 232   | Shared plugin fixtures: installed-plugins files, managed-settings fakes, and (T96) `pluginFiles`, `writePluginFiles`, the real 2.1.295 validate report, `scriptedValidator`. | fixed   | DUP-01                                               |
| `packages/cli/test/claude-code-plugin-validate.test.ts`    | 127   | Tests `createPluginValidator` on a temporary folder with a fake `claude`: not installed, writes and cleans the copy, no report, unwritable folder, unsafe path.              | fixed   | QA-04, DUP-01, DUP-04                                |
| `packages/cli/test/claude-code-project-collector.test.ts`  | 216   | Tests what the project collector takes, links and size limits, including (T96) a plugin in `.claude/skills/` minus its generated types.                                      | fixed   | DUP-01                                               |
| `packages/cli/test/claude-code-project-fixtures.ts`        | 198   | Temporary home and project folders, the collectors, the real adapter, `stopHook`, and the claude.ai synced folder in the 2.1.283 and (T95) 2.1.295 formats.                  | fixed   | DUP-05                                               |
| `packages/cli/test/claude-code-restore-rules.test.ts`      | 177   | Table tests of `globalDestination` and `projectDestination`: refusals, home-script rules, and (T96) the generated-folder refusal.                                            | fixed   | SEC-03, READ-13                                      |
| `packages/cli/test/claude-code-restorer.test.ts`           | 893   | Tests the Claude Code restorer writing real files: round trips, refusals, conflicts, the `~/.claude.json` merge, per-OS fixes, and what pull asks (now awaited).             | fixed   | QA-02, REF-02                                        |
| `packages/cli/test/claude-code-skills-dir-plugins.test.ts` | 366   | Tests `pluginFolders`, `pluginNotes`, `reviewPlugins` and `readValidateReport` on in-memory bundle files with a scripted validator.                                          | fixed   | QA-03, DUP-01, READ-12, REF-01                       |
| `packages/cli/test/pull-command.test.ts`                   | 886   | Drives `agentnomad pull` end to end against a fake bundle server with the real adapter; T96 added four tests on plugins and mods in the skills folder.                       | fixed   | QA-01, QA-05, QA-06, READ-14, DUP-01, DUP-06, REF-03 |
| `packages/cli/test/push-command.test.ts`                   | 676   | Drives `agentnomad push` with a fake collecting adapter; T96 added the `describeCollected` info line test.                                                                   | fixed   | QA-01, READ-15                                       |
| `packages/cli/test/stub-restorer.ts`                       | 15    | A restorer that reviews nothing, has no conflicts and writes nothing, for tests about other parts; now returns a Promise from `reviewRunnable`.                              | clean   | —                                                    |

## End-to-end (`packages/e2e`)

| File                        | Lines | What it does                                                                                                                                                 | Verdict | Findings |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | -------- |
| `packages/e2e/src/steps.ts` | 499   | The three cross-OS end-to-end steps against the local API; T96 added a mod in `skills/` with its generated folder, the push note and the review line checks. | clean   | —        |

## Documentation

| File                            | Lines | What it does                                                                                                                 | Verdict | Findings                  |
| ------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------- |
| `README.md`                     | 231   | User-facing overview, features, flags and the "What is synced" table; T96 added one sentence and one cell.                   | fixed   | READ-07                   |
| `CONTRIBUTING.md`               | 218   | Setup, conventions, test rules and the shared-helper list; T95 and T96 extended the fixture lists.                           | fixed   | READ-09                   |
| `docs/ADDING-AN-AGENT.md`       | 343   | The guide for writing an adapter; T96 added the `describeCollected` bullet but not the `reviewRunnable` changes.             | fixed   | READ-01, READ-08          |
| `docs/ARCHITECTURE.md`          | 885   | How the system works plus a file-by-file reference; T96 added prose in section 7 and two file rows, but not the table cells. | fixed   | READ-06, READ-07, READ-16 |
| `docs/security/threat-model.md` | 178   | Assets, attackers, the 19-row threat table, findings and accepted risks; T96 added row 19.                                   | fixed   | READ-05, READ-10          |
