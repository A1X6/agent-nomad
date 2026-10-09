# File Ledger — Agent Nomad — 2026-10-09 (review 16)

44 files, 13,331 lines, all read in full on branch `review-15-report` at `018324d` (the files T95, T96 and the review-15 fixes changed, `30eb20f..018324d`). Verdicts: 16 clean, 25 minor, 3 needs work, 0 rewrite. Finding IDs refer to `report.md` in this folder.

## CLI: agent adapters (`packages/cli/src/agents`)

The adapter interfaces every agent implements, and the Claude Code adapter: what push collects, what pull may write, the review of anything that can run, the plugins and mods in the skills folder (T96), and the claude.ai synced skills (T42). Push and pull call it only through `adapter.ts`.

| File                                                            | Lines | What it does                                                                                                                                                                             | Verdict    | Findings                    |
| --------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------- |
| `packages/cli/src/agents/adapter.ts`                            | 294   | The agent-neutral adapter interfaces every command uses to reach an agent, plus `reviewCovers` for folder-level review entries.                                                          | clean      | —                           |
| `packages/cli/src/agents/claude-code/account-skills.ts`         | 156   | Reads claude.ai synced skills, saves the user's own under the reserved folder, and plans adding them back as local skills.                                                               | needs work | SEC-01, BUG-02, PERF-02     |
| `packages/cli/src/agents/claude-code/claude-code-adapter.ts`    | 163   | Wires detector, collectors, restorer, inspector (`pluginNotes`) and the plan step into one adapter for this PC.                                                                          | clean      | —                           |
| `packages/cli/src/agents/claude-code/claude-code-paths.data.ts` | 274   | The one data file of every list the adapter syncs, skips or refuses, Zod-checked at load; `reviewedVersion` stays 2.1.292 with the reason.                                               | clean      | —                           |
| `packages/cli/src/agents/claude-code/command-review.ts`         | 357   | Finds what in settings, MCP and Markdown files runs programs and which entries are new or changed; exports `hookEntries`, `serverEntries`, `unreadableEntry`.                            | minor      | DUP-01                      |
| `packages/cli/src/agents/claude-code/global-collector.ts`       | 195   | Collects the global `~/.claude` setup, hook scripts, programs, `~/.claude.json` keys and plugins, skipping what Claude Code generates.                                                   | minor      | ARCH-02                     |
| `packages/cli/src/agents/claude-code/global-paths.ts`           | 130   | Named views of the data file's global lists, `isPluginGenerated` (with `ignoreCase`) and the shared `neverSyncedIn` predicate.                                                           | minor      | ARCH-01                     |
| `packages/cli/src/agents/claude-code/managed-settings.ts`       | 224   | Detects organization-managed settings and words the notices and the plugin-failure reasons.                                                                                              | minor      | UX-03                       |
| `packages/cli/src/agents/claude-code/plugin-sync.ts`            | 342   | Plans, asks about and runs `claude plugin` reinstalls with a cmd.exe-safe program runner; a run's result now carries `failure`.                                                          | clean      | —                           |
| `packages/cli/src/agents/claude-code/plugin-validate.ts`        | 87    | Writes a pulled plugin to a temporary folder under the fixed name `plugin`, runs `claude plugin validate --json` with a 60 s timeout, never throws.                                      | clean      | —                           |
| `packages/cli/src/agents/claude-code/project-collector.ts`      | 135   | Collects a project's `.claude/` setup, hook scripts, auto memory and plugins, with the same generated-folder skip.                                                                       | clean      | —                           |
| `packages/cli/src/agents/claude-code/restore-rules.ts`          | 145   | Pure rules for where each bundle entry may be written, or why it is refused (generated plugin folders in either case).                                                                   | minor      | DUP-01                      |
| `packages/cli/src/agents/claude-code/restorer.ts`               | 445   | Writes a pulled setup with merges, backups, line endings and refusals; `reviewRunnable` combines the T44 review with `reviewPlugins`.                                                    | minor      | PERF-01, REF-01             |
| `packages/cli/src/agents/claude-code/settings-commands.ts`      | 177   | Pure readers of a settings file's hooks and commands, their words and their program.                                                                                                     | clean      | —                           |
| `packages/cli/src/agents/claude-code/skills-dir-plugins.ts`     | 399   | Pure text rules for plugins in `skills/`: finds them, reads hooks and MCP sources in every manifest shape, names them for push, reads a validate report, builds the folder-level review. | minor      | SEC-02, UX-01, UX-02, QA-03 |
| `packages/cli/src/env/env-references.ts`                        | 102   | Finds `${VAR}` references in an adapter's MCP and settings files and merges scans.                                                                                                       | minor      | BUG-01, DUP-02              |
| `packages/cli/src/system/json.ts`                               | 32    | The shared JSON-object schema and the never-throwing `parseJsonWith` and `valueOrNull`.                                                                                                  | clean      | —                           |
| `packages/cli/src/index.ts`                                     | 77    | The package's barrel file for tests and the e2e package.                                                                                                                                 | minor      | READ-05                     |

## CLI: commands (`packages/cli/src/cli`, `packages/cli/src/push`, `packages/cli/src/pull`)

The commander program and the two commands, plan step then apply step, reaching agents only through the adapter interfaces.

| File                                    | Lines | What it does                                                                                                                                                                    | Verdict | Findings       |
| --------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------- |
| `packages/cli/src/cli/program.ts`       | 272   | Builds the commander program: every command, flag and help text, handing parsed options to injected handlers.                                                                   | minor   | READ-04        |
| `packages/cli/src/pull/pull-command.ts` | 618   | Pull's plan step (choose, download, review what runs, ask every question) and apply step (write, remember the revision, env values); a declined plugin folder is dropped whole. | minor   | READ-10, QA-04 |
| `packages/cli/src/push/push-command.ts` | 546   | Push's plan step (choose, collect, the adapter's notes, revision checks) and apply step (encrypt, upload).                                                                      | minor   | READ-10        |

## Lint configuration

| File               | Lines | What it does                                                                                         | Verdict | Findings |
| ------------------ | ----- | ---------------------------------------------------------------------------------------------------- | ------- | -------- |
| `eslint.config.js` | 117   | The lint boundaries: the agent boundary and the pure modules kept from `node:*` and the file walker. | clean   | —        |

## CLI tests (`packages/cli/test`)

Vitest tests of the CLI, one file per module, with shared fakes and fixtures.

| File                                                       | Lines | What it does                                                                                                                                                     | Verdict    | Findings                                               |
| ---------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------ |
| `packages/cli/test/agent-boundary.test.ts`                 | 346   | Runs push and pull against a second, hand-built adapter to prove the adapter boundary, and holds the direct table test of `reviewCovers`.                        | minor      | BP-03                                                  |
| `packages/cli/test/claude-code-account-skills.test.ts`     | 245   | Tests reading and saving claude.ai synced skills and pull adding them, with the 2.1.295 no-`creatorType` case.                                                   | minor      | BP-02                                                  |
| `packages/cli/test/claude-code-adapter.test.ts`            | 167   | Tests the adapter's plan step, identity and wiring, and the T96 push note through the real `describeCollected`.                                                  | minor      | READ-07, DUP-05                                        |
| `packages/cli/test/claude-code-global-collector.test.ts`   | 441   | Tests what the global collector takes from a realistic `~/.claude`, including the probe mod minus its generated folder.                                          | minor      | READ-09                                                |
| `packages/cli/test/claude-code-paths-data.test.ts`         | 72    | Checks the data file against the named views and tables `isPluginGenerated` with and without `ignoreCase`.                                                       | clean      | —                                                      |
| `packages/cli/test/claude-code-plugin-fixtures.ts`         | 246   | Shared plugin fixtures: installed plugins, managed-settings fakes, the probe mod, the generated folder, the real 2.1.295 validate report, `scriptedValidator`.   | minor      | READ-06                                                |
| `packages/cli/test/claude-code-plugin-validate.test.ts`    | 152   | Tests `createPluginValidator` with a recording `claude`: not installed, the fixed temporary folder name, every no-report reason, unwritable folder, unsafe path. | minor      | BP-01                                                  |
| `packages/cli/test/claude-code-project-collector.test.ts`  | 198   | Tests what the project collector takes, links and the size limit, including a mod in `.claude/skills/` minus its generated folder.                               | minor      | READ-09                                                |
| `packages/cli/test/claude-code-project-fixtures.ts`        | 170   | Temporary home and project folders, the collectors, the real adapter, and the claude.ai synced folder in the 2.1.283 and 2.1.295 formats.                        | clean      | —                                                      |
| `packages/cli/test/claude-code-restore-rules.test.ts`      | 185   | Table tests of `globalDestination` and `projectDestination`: refusals, home-script rules, the generated-folder refusal in either case.                           | clean      | —                                                      |
| `packages/cli/test/claude-code-restorer.test.ts`           | 913   | Tests the restorer on real files: round trips, refusals, conflicts, the `~/.claude.json` merge, per-OS fixes, and the combined T44 and T96 review.               | clean      | —                                                      |
| `packages/cli/test/claude-code-skills-dir-plugins.test.ts` | 454   | Tests `pluginFolders`, `readPlugin`, `pluginNotes`, `reviewPlugins` and `readValidateReport` on in-memory bundle files with a scripted validator.                | needs work | QA-02, QA-03, REF-02, DUP-05                           |
| `packages/cli/test/fakes.ts`                               | 430   | The shared test fakes (temporary folders, collected files, prompter, reporter, bundle server, secret store, `fakeExecutables`) that load no agent adapter.       | minor      | DUP-03                                                 |
| `packages/cli/test/pull-command.test.ts`                   | 965   | Drives `agentnomad pull` end to end against a fake bundle server with the real adapter, including the T96 block on plugins and mods.                             | needs work | QA-01, QA-04, DEAD-01, DUP-04, DUP-05, REF-03, READ-08 |
| `packages/cli/test/push-command.test.ts`                   | 676   | Drives `agentnomad push` with a fake collecting adapter, including the `describeCollected` info line.                                                            | clean      | —                                                      |
| `packages/cli/test/stub-restorer.ts`                       | 15    | A restorer that reviews nothing, has no conflicts and writes nothing, for tests about other parts.                                                               | clean      | —                                                      |

## End-to-end (`packages/e2e`)

| File                        | Lines | What it does                                                                                                                                   | Verdict | Findings |
| --------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| `packages/e2e/src/steps.ts` | 499   | The three cross-OS end-to-end steps against the local API, with the probe mod, its generated folder, the push note and the review line checks. | clean   | —        |

## Documentation

| File                            | Lines | What it does                                                                                                                                | Verdict | Findings                  |
| ------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------- |
| `README.md`                     | 231   | User-facing overview, features, flags, exit codes and the "What is synced" table.                                                           | minor   | READ-04                   |
| `CONTRIBUTING.md`               | 221   | Setup, conventions, test rules and the shared-helper list (every export of the three helper files is named).                                | minor   | READ-03                   |
| `docs/ADDING-AN-AGENT.md`       | 350   | The guide for writing an adapter, including the async `reviewRunnable`, folder entries and `describeCollected`.                             | minor   | READ-01, READ-10          |
| `docs/ARCHITECTURE.md`          | 887   | How the system works plus the file-by-file reference; every T96 claim checked against the code holds.                                       | minor   | READ-01, READ-02, READ-03 |
| `docs/security/threat-model.md` | 181   | Assets, attackers, the 19-row threat table, the fixed findings and accepted risks; row 18 does not yet cover a plugin inside a saved skill. | minor   | SEC-01                    |
