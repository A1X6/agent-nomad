# File Ledger — Agent Nomad — 2026-10-03 (review 4)

243 files, 33,614 lines, all read in full at `dev` `4c31cf8`. Verdicts: 166 clean, 71 minor, 6 needs work, 0 rewrite. Finding IDs refer to `report.md` in this folder.

## After the fixes (T69 to T74)

All 63 findings are fixed and merged into `dev` (`e4ca368`). The 77 files that had a `minor` or `needs work` verdict now read `fixed`; their finding IDs stay in the last column as the record. Rows, line counts and descriptions are as reviewed at `4c31cf8`. Files the fixes added, deleted or renamed since then:

- added: `packages/cli/src/agents/claude-code/env-files.ts`
- added: `packages/cli/src/agents/shared/detector-system.ts`
- renamed: `packages/cli/src/agents/claude-code/file-gathering.ts` → `packages/cli/src/agents/shared/file-gathering.ts`
- added: `packages/cli/src/system/json.ts`
- added: `packages/cli/test/claude-code-adapter.test.ts`
- added: `packages/cli/test/claude-code-running.test.ts`
- renamed: `packages/cli/test/env-secrets.test.ts` → `packages/cli/test/env.test.ts`
- added: `packages/cli/test/fakes.ts`
- deleted: `packages/cli/test/interfaces.test.ts`
- added: `packages/cli/test/json.test.ts`
- added: `packages/cli/test/local-state.test.ts`
- added: `packages/contracts/test/encoding.test.ts`
- added: `packages/server/src/api.ts`
- deleted: `packages/server/test/contracts.test.ts`
- deleted: `packages/server/test/interfaces.test.ts`
- added: `packages/server/test/support/fixtures.ts`

## CLI: agent adapters (`packages/cli/src/agents`)

The adapter interface every agent implements, the registry, and the Claude Code adapter: what push collects, what pull may write, the review of anything that can run, plugins and programs. Push and pull call it only through `adapter.ts`.

| File                                                            | Lines | What it does                                                                                                                         | Verdict | Findings                |
| --------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ------- | ----------------------- |
| `packages/cli/src/agents/adapter.ts`                            | 248   | The adapter interfaces every agent implements (detector, collector, restorer, inspector, plan step) and `chosenAgent`.               | clean   | —                       |
| `packages/cli/src/agents/agents-command.ts`                     | 40    | `agentnomad agents`: one line per supported agent plus each agent's notices.                                                         | clean   | —                       |
| `packages/cli/src/agents/claude-code/account-skills.ts`         | 166   | Reads the user's own claude.ai skills from `skills/synced/`, saves a copy, and plans which pull may add as local skills.             | fixed   | DUP-04                  |
| `packages/cli/src/agents/claude-code/after-restore.ts`          | 278   | Pull's Claude Code follow-up: asks about plugins, missing programs and claude.ai skills in the plan step, installs them afterwards.  | fixed   | BUG-01, DUP-04, READ-01 |
| `packages/cli/src/agents/claude-code/auto-memory.ts`            | 154   | Finds a project's auto memory folder the way Claude Code does, and refuses unsafe `autoMemoryDirectory` folders.                     | clean   | —                       |
| `packages/cli/src/agents/claude-code/claude-code-adapter.ts`    | 144   | Builds the Claude Code adapter from its parts and asks the "Claude Code is running" question in the plan step.                       | clean   | —                       |
| `packages/cli/src/agents/claude-code/claude-code-paths.data.ts` | 259   | The schema-checked data file: every list of what to sync, skip or refuse.                                                            | clean   | —                       |
| `packages/cli/src/agents/claude-code/claude-json-merge.ts`      | 191   | Merges only MCP servers and preference keys into `~/.claude.json`, with a backup, never while Claude Code runs.                      | fixed   | ARCH-03                 |
| `packages/cli/src/agents/claude-code/command-review.ts`         | 314   | Finds everything in a pulled setup that runs programs or loosens permissions, and which of it is new or changed on this PC.          | fixed   | SEC-01, DUP-04          |
| `packages/cli/src/agents/claude-code/detector.ts`               | 207   | Finds the `claude` command, its version and the base folder; `findExecutable` for any command.                                       | clean   | —                       |
| `packages/cli/src/agents/claude-code/file-gathering.ts`         | 163   | Reads files and folders into bundle entries, with link and size limits.                                                              | clean   | —                       |
| `packages/cli/src/agents/claude-code/global-collector.ts`       | 180   | Collects the global setup: base-folder files, hook scripts, tool settings, programs, `~/.claude.json` keys, plugins, account skills. | fixed   | BUG-01, ARCH-03         |
| `packages/cli/src/agents/claude-code/global-paths.ts`           | 107   | Named views and lookups over the data file for the global scope, plus the home-folder refusal rules.                                 | clean   | —                       |
| `packages/cli/src/agents/claude-code/hook-scripts.ts`           | 72    | Which scripts the global hooks and status line run: what push collects and pull allows back.                                         | fixed   | DUP-03, READ-01         |
| `packages/cli/src/agents/claude-code/managed-settings.ts`       | 218   | Detects organization-managed settings per OS and explains what they block.                                                           | fixed   | DUP-04                  |
| `packages/cli/src/agents/claude-code/plugin-sync.ts`            | 329   | Plans, asks about and runs `claude plugin` reinstalls; the safe `.cmd` launcher.                                                     | fixed   | BUG-03, DEAD-01         |
| `packages/cli/src/agents/claude-code/plugins.ts`                | 205   | Reads installed plugins and marketplaces into `.agentnomad/plugins.json` and defines its schema.                                     | fixed   | BUG-01, BUG-03, DUP-04  |
| `packages/cli/src/agents/claude-code/programs.ts`               | 62    | Finds a program a hook runs and whether npm installed it globally (package and version).                                             | clean   | —                       |
| `packages/cli/src/agents/claude-code/project-collector.ts`      | 132   | Collects a project's setup, the scripts its hooks run and, when chosen, its auto memory.                                             | fixed   | DUP-03, READ-01         |
| `packages/cli/src/agents/claude-code/project-paths.ts`          | 30    | Named views of the data file for the project scope.                                                                                  | clean   | —                       |
| `packages/cli/src/agents/claude-code/restore-rules.ts`          | 163   | Decides where each pulled bundle entry may be written, or why it is refused.                                                         | fixed   | DUP-03, READ-01         |
| `packages/cli/src/agents/claude-code/restorer.ts`               | 423   | Writes a pulled setup: destinations, line endings, permissions, conflicts, backups, case collisions.                                 | clean   | —                       |
| `packages/cli/src/agents/claude-code/reviewed-settings.ts`      | 70    | The command settings and redirect `env` names the pull review watches; the drift watch list.                                         | clean   | —                       |
| `packages/cli/src/agents/claude-code/runnable-markdown.ts`      | 40    | Finds `` !`cmd` `` placeholders, ` ```! ` blocks and frontmatter hooks in skill, command and subagent files.                         | fixed   | SEC-02                  |
| `packages/cli/src/agents/claude-code/running-claude.ts`         | 92    | Lists processes per OS and decides whether Claude Code or the Claude app is running.                                                 | clean   | —                       |
| `packages/cli/src/agents/claude-code/settings-commands.ts`      | 75    | Parses settings JSON, the commands hooks and the status line run, command words and the program a command starts.                    | fixed   | SEC-01, BUG-01, DUP-04  |
| `packages/cli/src/agents/claude-code/unknown-files.ts`          | 118   | Lists entries in Claude Code's folder that the data file does not know, for push's notice.                                           | fixed   | READ-01                 |
| `packages/cli/src/agents/notices.ts`                            | 67    | Generic notices: version comparison, unknown entries, and `showNotices` (each once).                                                 | clean   | —                       |
| `packages/cli/src/agents/registry.ts`                           | 20    | `createAgentRegistry`: the adapters by id, refusing duplicates.                                                                      | clean   | —                       |

## CLI: commands and shared code (`packages/cli/src`, outside `agents`)

The `agentnomad` command: the option parser, push and pull (plan, then apply), login and account commands, the API client, environment values, the secret store, local state, and the terminal output. `app.ts` wires it together.

| File                                              | Lines | What it does                                                                                                            | Verdict | Findings        |
| ------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- | ------- | --------------- |
| `packages/cli/src/api/api-client.ts`              | 74    | The `ApiClient` interface and the upload/download shapes.                                                               | clean   | —               |
| `packages/cli/src/api/api-errors.ts`              | 78    | Typed errors for API answers, network failures, unknown outcomes, bad answers and no login.                             | clean   | —               |
| `packages/cli/src/api/api-url.ts`                 | 28    | Resolves the server address from `AGENTNOMAD_API_URL` with https and bare-origin checks.                                | clean   | —               |
| `packages/cli/src/api/http-api-client.ts`         | 378   | `ApiClient` over fetch: wake-up check, per-call timeouts, tolerant answer parsing, SHA-256 checks, no-retry operations. | clean   | —               |
| `packages/cli/src/api/transport.ts`               | 184   | One HTTP call with timeout, retries with backoff on network errors and 502/503/504, capped body reads, no redirects.    | clean   | —               |
| `packages/cli/src/app.ts`                         | 180   | Composition root that builds every service lazily and wires all command handlers.                                       | clean   | —               |
| `packages/cli/src/auth/auth-commands.ts`          | 334   | `register`, `login`, `logout` and `account delete`, with key derivation and wiping.                                     | fixed   | UX-01, UX-02    |
| `packages/cli/src/auth/local-session.ts`          | 62    | Saves, reads and clears the session token and data key; maps an expired session to a clear error.                       | clean   | —               |
| `packages/cli/src/auth/password-policy.ts`        | 71    | Password length and zxcvbn strength rules, with the word lists loaded only when needed.                                 | clean   | —               |
| `packages/cli/src/bin.ts`                         | 29    | The executable: picks the prompter by terminal, runs the CLI, sets the exit code.                                       | clean   | —               |
| `packages/cli/src/cli/commands.ts`                | 75    | Option types for every command and the `CommandHandlers` interface.                                                     | clean   | —               |
| `packages/cli/src/cli/error-messages.ts`          | 24    | The one-line message for a failed command (rate limit, server error, else the error's message).                         | clean   | —               |
| `packages/cli/src/cli/flags.ts`                   | 43    | Validates `--agent`, `--project` and `--username` values with the contracts.                                            | clean   | —               |
| `packages/cli/src/cli/program.ts`                 | 255   | Declares every command, flag and help text with commander; parsing only.                                                | clean   | —               |
| `packages/cli/src/cli/project-folder.ts`          | 32    | Refuses the home folder and the agent's own folder as a project.                                                        | clean   | —               |
| `packages/cli/src/cli/run.ts`                     | 74    | Runs one invocation and maps errors to exit codes and the "needs an answer" hint.                                       | clean   | —               |
| `packages/cli/src/cli/setup-outcomes.ts`          | 36    | Per-setup outcomes of push and pull and the single "Not saved / Not restored" error.                                    | clean   | —               |
| `packages/cli/src/cli/stdin.ts`                   | 31    | Reads the first line of piped stdin for `--password-stdin`, capped, refusing a terminal.                                | clean   | —               |
| `packages/cli/src/commands/setup-commands.ts`     | 196   | `list`, `status` and `delete` of saved setups.                                                                          | fixed   | UX-04, DUP-05   |
| `packages/cli/src/config/config-dir.ts`           | 24    | agentnomad's config folder per OS (APPDATA, XDG_CONFIG_HOME, ~/.config).                                                | clean   | —               |
| `packages/cli/src/env/env-command.ts`             | 75    | `agentnomad env`: which `${VAR}` names the setups use and whether each is set.                                          | fixed   | UX-03, ARCH-01  |
| `packages/cli/src/env/env-references.ts`          | 119   | Finds `${VAR}` references in MCP and settings files of a collected setup.                                               | fixed   | ARCH-01         |
| `packages/cli/src/env/env-restore.ts`             | 155   | Pull's plan (ask) and apply (write) for saved environment values, with the gated loader and redirect names.             | fixed   | DEAD-02         |
| `packages/cli/src/env/env-section.ts`             | 79    | The encrypted `.agentnomad/env.json` section: schema, file entry, parse, and push's opt-in choice.                      | clean   | —               |
| `packages/cli/src/env/loader-variables.ts`        | 13    | The regex of variable names that make shells or runtimes load code.                                                     | clean   | —               |
| `packages/cli/src/env/shell-profile.ts`           | 226   | Reads and writes the marked env block in a shell profile, or Windows user variables via PowerShell.                     | clean   | —               |
| `packages/cli/src/index.ts`                       | 72    | Barrel re-export of the whole package for tests and e2e.                                                                | clean   | —               |
| `packages/cli/src/pull/pull-command.ts`           | 589   | `pull`: plan step (choose, download, verify, review, conflicts, env, agent questions) and apply step with no prompter.  | fixed   | SEC-03, DUP-05  |
| `packages/cli/src/pull/saved-setups.ts`           | 147   | Lists all saved setups (paged, bounded) with decrypted names; downloads and verifies one.                               | fixed   | READ-02, DUP-05 |
| `packages/cli/src/push/bundle-files.ts`           | 90    | Converts collected files to bundle entries and back, keeping local bytes that only differ in slash style.               | clean   | —               |
| `packages/cli/src/push/push-command.ts`           | 530   | `push`: plan step (choose, collect, every question, revision checks) and apply step (seal, upload).                     | fixed   | ARCH-01, DUP-05 |
| `packages/cli/src/secrets/create-secret-store.ts` | 57    | Picks the keychain when it answers, else the file store; moves a file login into a working keychain.                    | clean   | —               |
| `packages/cli/src/secrets/file-store.ts`          | 212   | User-only JSON secrets file with atomic writes, POSIX modes and a Windows ACL lock-down.                                | clean   | —               |
| `packages/cli/src/secrets/keychain-store.ts`      | 53    | `SecretStore` on @napi-rs/keyring, one entry per secret and server.                                                     | clean   | —               |
| `packages/cli/src/secrets/secret-store.ts`        | 19    | The `SecretStore` interface and the secret names.                                                                       | clean   | —               |
| `packages/cli/src/state/local-state.ts`           | 198   | `state.json`: project names per folder, known revisions, partial-pull notes and the account, per server.                | clean   | —               |
| `packages/cli/src/system/files.ts`                | 68    | Atomic write (temp file + rename), link-following write target and the "missing file" test.                             | clean   | —               |
| `packages/cli/src/system/paths.ts`                | 12    | Folder keys and comparison per OS (Windows ignores case).                                                               | clean   | —               |
| `packages/cli/src/system/run-program.ts`          | 49    | The one `execFile` wrapper: no shell, timeout, never rejects.                                                           | clean   | —               |
| `packages/cli/src/ui/clack-prompter.ts`           | 124   | `Prompter` and `Reporter` on @clack/prompts, with printable text and plain spinners without a terminal.                 | clean   | —               |
| `packages/cli/src/ui/format-size.ts`              | 7     | Formats a byte count as B, KB or MB.                                                                                    | clean   | —               |
| `packages/cli/src/ui/no-terminal-prompter.ts`     | 31    | The scripts prompter: every question fails with `AnswerNeededError`.                                                    | clean   | —               |
| `packages/cli/src/ui/printable.ts`                | 29    | Shows terminal control and bidi characters as `\u{…}` so they are never acted on.                                       | fixed   | SEC-03          |
| `packages/cli/src/ui/prompter.ts`                 | 66    | The `Prompter`, `Reporter` and `Spinner` interfaces and `PromptCancelledError`.                                         | clean   | —               |
| `packages/cli/src/version.ts`                     | 2     | The version `--version` prints.                                                                                         | clean   | —               |

## CLI: scripts (`packages/cli/scripts`)

The npm package build and the weekly Claude Code drift check.

| File                                              | Lines | What it does                                                                                                                      | Verdict | Findings |
| ------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| `packages/cli/scripts/build-release.ts`           | 132   | Builds the npm package with esbuild, refuses foreign bundled code or undeclared libraries, writes manifest and shrinkwrap.        | clean   | —        |
| `packages/cli/scripts/drift/check-claude-code.ts` | 87    | Fetches the docs page, changelog and latest version, runs the drift comparison and writes the report and CI outputs.              | clean   | —        |
| `packages/cli/scripts/drift/drift.ts`             | 191   | Pure drift comparison of the Claude Code paths data file against docs, a fresh install and the changelog, and the issue Markdown. | clean   | —        |

## CLI: tests (`packages/cli/test`)

Unit and command tests for the CLI. They run against temporary folders and fake servers.

| File                                                      | Lines | What it does                                                                                                                                                                         | Verdict | Findings                            |
| --------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ----------------------------------- |
| `packages/cli/test/agent-boundary.test.ts`                | 394   | Runs a made-up "Example CLI" adapter through the real push and pull commands to show the agent boundary holds (T61).                                                                 | fixed   | DUP-01                              |
| `packages/cli/test/agent-registry.test.ts`                | 138   | Tests the agent registry, the `agents` command output and the Claude Code adapter wiring against a temp home.                                                                        | clean   | —                                   |
| `packages/cli/test/api-client.test.ts`                    | 612   | Tests the HTTP API client (requests, contract checks, retries, timeouts, wake-up, URL rules) against a fake fetch.                                                                   | fixed   | QA-04                               |
| `packages/cli/test/auth-commands.test.ts`                 | 841   | Tests register, login, logout, account delete, password policy and wiping of secret arrays against an in-memory server.                                                              | fixed   | QA-04, DUP-01                       |
| `packages/cli/test/bin.test.ts`                           | 56    | Starts the real `src/bin.ts` with Node to check `--help`, a usage error, `agents` and clack's cancel handling.                                                                       | fixed   | QA-01                               |
| `packages/cli/test/claude-code-account-skills.test.ts`    | 310   | Tests reading, saving and re-adding claude.ai synced skills (T42).                                                                                                                   | fixed   | DUP-01                              |
| `packages/cli/test/claude-code-after-restore.test.ts`     | 261   | Tests the after-pull follow-up: npm program installs and plugin reinstalls, asked in the plan step and run later.                                                                    | clean   | —                                   |
| `packages/cli/test/claude-code-command-review.test.ts`    | 385   | Tests the pull review that finds settings, hooks, skills and variables that run commands or redirect Claude Code.                                                                    | clean   | —                                   |
| `packages/cli/test/claude-code-detector.test.ts`          | 238   | Tests Claude Code detection (PATH, PATHEXT, version, CLAUDE_CONFIG_DIR) on a fake system plus one real-OS run.                                                                       | clean   | —                                   |
| `packages/cli/test/claude-code-drift.test.ts`             | 181   | Tests the weekly drift check script: docs names, changelog filtering, report and inert text.                                                                                         | clean   | —                                   |
| `packages/cli/test/claude-code-global-collector.test.ts`  | 483   | Tests what the global collector takes from `~/.claude`, `~/.claude.json`, hook scripts, links and programs.                                                                          | clean   | —                                   |
| `packages/cli/test/claude-code-modules.test.ts`           | 128   | Checks module boundaries by reading source imports, and tests the standalone `~/.claude.json` merge.                                                                                 | fixed   | ARCH-04                             |
| `packages/cli/test/claude-code-paths-data.test.ts`        | 140   | Tests the paths data file, the unknown-file check and version comparisons.                                                                                                           | clean   | —                                   |
| `packages/cli/test/claude-code-plugins.test.ts`           | 345   | Tests the plugin manifest on push and the plugin reinstall on pull.                                                                                                                  | fixed   | DEAD-01                             |
| `packages/cli/test/claude-code-project-collector.test.ts` | 334   | Tests what the project collector takes, link and size limits, and where auto memory is found.                                                                                        | fixed   | QA-06                               |
| `packages/cli/test/claude-code-restorer.test.ts`          | 1191  | Tests the restorer (destinations, conflicts, `~/.claude.json`, per-OS fixes), the running-Claude check, Windows names and the pull plan step.                                        | fixed   | QA-05, READ-03                      |
| `packages/cli/test/contracts.test.ts`                     | 23    | Checks that headers built the CLI's way pass the shared PUT header schema, and that the bundle route builds the right URL.                                                           | clean   | —                                   |
| `packages/cli/test/env-secrets.test.ts`                   | 668   | Tests finding `${VAR}` references, the opt-in env section, shell-profile and Windows variable writers, restoring values on pull, and `agentnomad env`.                               | fixed   | READ-05                             |
| `packages/cli/test/interfaces.test.ts`                    | 84    | Builds an in-memory SecretStore, a fake adapter and a registry, and checks those fakes against themselves.                                                                           | fixed   | QA-10, DUP-01                       |
| `packages/cli/test/managed-settings.test.ts`              | 222   | Tests finding organization-managed Claude Code settings on each OS, the push/pull/agents notices, and the clearer reason for a plugin blocked by policy.                             | clean   | —                                   |
| `packages/cli/test/no-terminal.test.ts`                   | 48    | Tests that the no-terminal prompter refuses every question, and that `--password-stdin` reads only the first line of a pipe.                                                         | clean   | —                                   |
| `packages/cli/test/program.test.ts`                       | 284   | Runs the commander program with recording handlers to test help, version, routing, flag parsing and exit codes.                                                                      | fixed   | QA-02, QA-09, READ-05               |
| `packages/cli/test/pull-command.test.ts`                  | 911   | Runs push on one fake PC and pull on another against an in-memory server, covering command review, conflicts, older copies, the plan/apply split, env values and the account switch. | fixed   | QA-03, QA-11, DUP-01, DUP-07, BP-01 |
| `packages/cli/test/push-command.test.ts`                  | 727   | Tests push against an in-memory server that enforces revisions: encryption, project names, flags, claude.ai skills, newer copies, size limit, plan/apply, and wiping the data key.   | fixed   | QA-08, QA-11, DUP-01, BP-01         |
| `packages/cli/test/secret-store.test.ts`                  | 307   | Tests the config folder, the user-only secrets file, the keychain store, the keychain-or-file choice with the T46 move, and the real OS keychain.                                    | fixed   | BP-02, READ-05                      |
| `packages/cli/test/setup-commands.test.ts`                | 476   | Tests `list`, `status`, `delete`, `account delete`, the per-account revisions in local state, and time and size formatting.                                                          | fixed   | DUP-01, BP-01, READ-05              |
| `packages/cli/test/stub-restorer.ts`                      | 15    | Shared test helper: a Restorer that runs nothing and writes nothing unless the test passes its own `restore`.                                                                        | clean   | —                                   |
| `packages/cli/test/system.test.ts`                        | 348   | Tests the thin wrappers that start real programs (cmd.exe quoting, process listing, PowerShell, icacls, registry), with fakes on every OS and for real on the OS running the test.   | fixed   | QA-07, READ-04, READ-05             |

## CLI: package config

Manifest and TypeScript settings of the CLI package.

| File                         | Lines | What it does                                                                                            | Verdict | Findings |
| ---------------------------- | ----- | ------------------------------------------------------------------------------------------------------- | ------- | -------- |
| `packages/cli/package.json`  | 37    | Manifest of the private CLI workspace package: exact dependency versions, source export condition, bin. | clean   | —        |
| `packages/cli/tsconfig.json` | 17    | TypeScript project for src, test and scripts, referencing contracts and core.                           | clean   | —        |

## Contracts (`packages/contracts`)

Zod schemas, limits and byte-encoding helpers shared by the CLI and the server. The one description of the API.

| File                                      | Lines | What it does                                                                      | Verdict | Findings |
| ----------------------------------------- | ----- | --------------------------------------------------------------------------------- | ------- | -------- |
| `packages/contracts/package.json`         | 22    | Contracts package manifest (only Zod), with the source export condition.          | clean   | —        |
| `packages/contracts/src/api/answers.ts`   | 51    | Tolerant forms of every API answer, built from the strict shapes, for the CLI.    | clean   | —        |
| `packages/contracts/src/api/auth.ts`      | 95    | Username, Argon2id settings and every auth request and answer schema.             | clean   | —        |
| `packages/contracts/src/api/bundles.ts`   | 106   | Scope keys, list query and answer, upload and download header schemas.            | clean   | —        |
| `packages/contracts/src/api/common.ts`    | 95    | Shared sizes, limits, routes, header names, error codes and error body.           | clean   | —        |
| `packages/contracts/src/bundle.ts`        | 129   | The plaintext bundle schema: format, agent, scope, OS, revision, safe file paths. | fixed   | READ-09  |
| `packages/contracts/src/encoding.ts`      | 33    | Base64, hex and byte-compare helpers on web-standard APIs.                        | fixed   | BP-03    |
| `packages/contracts/src/index.ts`         | 7     | Re-exports the contracts package.                                                 | clean   | —        |
| `packages/contracts/src/primitives.ts`    | 48    | Schema building blocks: sized base64, SHA-256 hex, timestamps, one-line text.     | clean   | —        |
| `packages/contracts/test/answers.test.ts` | 214   | Proves the client answer schemas drop unknown fields but keep every bound.        | clean   | —        |
| `packages/contracts/test/api.test.ts`     | 287   | Tests the API schemas: sizes, KDF bounds, usernames, headers, list query.         | clean   | —        |
| `packages/contracts/test/bundle.test.ts`  | 193   | Tests the bundle schema and the project-name rules.                               | fixed   | READ-09  |
| `packages/contracts/tsconfig.json`        | 10    | Build settings for contracts (no Node types).                                     | clean   | —        |

## Core (`packages/core`)

Encryption, key derivation, the bundle format, path rules and merge strategies. No Node APIs, so it is easy to test.

| File                                          | Lines | What it does                                                                                | Verdict | Findings        |
| --------------------------------------------- | ----- | ------------------------------------------------------------------------------------------- | ------- | --------------- |
| `packages/core/package.json`                  | 24    | Core package manifest (contracts, fflate, libsodium).                                       | clean   | —               |
| `packages/core/src/bundle-codec.ts`           | 23    | The `BundleCodec` interface and `BundleFormatError`.                                        | clean   | —               |
| `packages/core/src/crypto.ts`                 | 70    | The crypto interfaces and `DecryptionError`.                                                | clean   | —               |
| `packages/core/src/envelopes.ts`              | 77    | Wraps the data key and seals/opens bundles bound to version, agent and scope.               | clean   | —               |
| `packages/core/src/gzip-bundle-codec.ts`      | 112   | JSON + gzip codec with a 64 MB decompression cap and a schema check.                        | clean   | —               |
| `packages/core/src/index.ts`                  | 10    | Re-exports the core package.                                                                | clean   | —               |
| `packages/core/src/merge-strategies.ts`       | 148   | JSON merge, side-by-side copy, overwrite with backup, and picking one per file.             | fixed   | BUG-04          |
| `packages/core/src/merge.ts`                  | 32    | The `MergeStrategy` interface and its input and output types.                               | fixed   | READ-13         |
| `packages/core/src/path-resolver.ts`          | 175   | Bundle path ↔ OS path, home folder ↔ `{{HOME}}`, Windows name rules.                        | clean   | —               |
| `packages/core/src/paths.ts`                  | 58    | The `PathResolver` interface, `{{HOME}}`, `PathError`, `sourceOsOf`.                        | clean   | —               |
| `packages/core/src/project-names.ts`          | 77    | Scope keys (keyed hash of a project name) and encrypted project names.                      | clean   | —               |
| `packages/core/src/sodium-crypto.ts`          | 122   | The crypto service on libsodium: Argon2id, key split, XChaCha20-Poly1305, BLAKE2b, SHA-256. | clean   | —               |
| `packages/core/test/bundle-codec.test.ts`     | 124   | Tests the codec round trip, rejections and bomb protection.                                 | clean   | —               |
| `packages/core/test/crypto.test.ts`           | 235   | Tests key derivation vectors, sealing, tampering, key wrapping and binding.                 | fixed   | DUP-08          |
| `packages/core/test/interfaces.test.ts`       | 59    | Checks interface shapes using fakes defined in the test itself.                             | fixed   | QA-14           |
| `packages/core/test/merge-strategies.test.ts` | 217   | Tests the three strategies and strategy selection.                                          | clean   | —               |
| `packages/core/test/paths.test.ts`            | 253   | Tests path conversion and `{{HOME}}` rewriting on every OS pair.                            | clean   | —               |
| `packages/core/test/project-names.test.ts`    | 146   | Tests scope keys and project-name encryption.                                               | fixed   | READ-09, DUP-08 |
| `packages/core/tsconfig.json`                 | 15    | Build settings for core (no Node types).                                                    | clean   | —               |

## End-to-end tests (`packages/e2e`)

Runs the built CLI against a local server (PGlite) as several simulated PCs, also across operating systems in CI.

| File                                  | Lines | What it does                                                                         | Verdict | Findings |
| ------------------------------------- | ----- | ------------------------------------------------------------------------------------ | ------- | -------- |
| `packages/e2e/package.json`           | 18    | e2e package manifest (cli, server, PGlite, Hono node server, Drizzle).               | clean   | —        |
| `packages/e2e/src/local-server.ts`    | 120   | Starts the real API on PGlite on a free port and records every request.              | clean   | —        |
| `packages/e2e/src/pc.ts`              | 152   | A simulated PC (own home, config, project) that runs the built CLI with no terminal. | clean   | —        |
| `packages/e2e/src/plaintext.ts`       | 97    | Searches recorded requests for secrets in plain, encoded and compressed forms.       | clean   | —        |
| `packages/e2e/src/push-env-value.ts`  | 43    | Runs push with the env-value question answered, as a child process of a PC.          | clean   | —        |
| `packages/e2e/src/steps.ts`           | 472   | The three end-to-end steps and everything each one checks.                           | clean   | —        |
| `packages/e2e/test/cross-os.test.ts`  | 44    | Runs one step per machine (CI chains) or all three in a row.                         | clean   | —        |
| `packages/e2e/test/plaintext.test.ts` | 77    | Proves the leak search finds every form it claims to.                                | fixed   | READ-14  |
| `packages/e2e/tsconfig.json`          | 10    | Build settings for e2e (references cli and server).                                  | clean   | —        |
| `packages/e2e/vitest.config.ts`       | 14    | e2e Vitest settings: source condition, 10-minute timeout.                            | clean   | —        |

## Server: source (`packages/server/src`)

The Hono API: accounts and sessions, encrypted bundle storage, rate limits, logging. It stores only ciphertext. `server.ts` wires it for production.

| File                                                      | Lines | What it does                                                                           | Verdict | Findings                |
| --------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------- | ------- | ----------------------- |
| `packages/server/src/auth/auth-service.ts`                | 189   | Prelogin, register, login, logout, account delete and session checks, free of HTTP.    | clean   | —                       |
| `packages/server/src/auth/server-keys.ts`                 | 79    | HMAC subkeys from SERVER_SECRET: auth-key hashes, fake salts, rate-limit pseudonyms.   | clean   | —                       |
| `packages/server/src/auth/session-tokens.ts`              | 19    | Makes 256-bit session tokens and their SHA-256 hashes.                                 | clean   | —                       |
| `packages/server/src/bundles/bundle-service.ts`           | 213   | List, download, upload (safe order, limits, cleanup) and delete of saved setups.       | clean   | —                       |
| `packages/server/src/db/bundle-cursor.ts`                 | 65    | Encodes and format-checks the list cursor (time and id).                               | fixed   | READ-06                 |
| `packages/server/src/db/bundle-repository.ts`             | 196   | Bundle metadata in Postgres: paged list, revision check and limits in one transaction. | clean   | —                       |
| `packages/server/src/db/database.ts`                      | 18    | Driver-independent Database type and a Postgres error-code helper.                     | clean   | —                       |
| `packages/server/src/db/env.ts`                           | 66    | Validates DATABASE_URL and SERVER_SECRET without printing them.                        | fixed   | READ-08                 |
| `packages/server/src/db/repositories.ts`                  | 164   | Repository interfaces, records and their errors.                                       | fixed   | READ-06, DEAD-03        |
| `packages/server/src/db/schema.ts`                        | 191   | Drizzle table definitions with checks, indexes and foreign keys.                       | fixed   | DEAD-03                 |
| `packages/server/src/db/session-repository.ts`            | 81    | Sessions in Postgres: create, find live by hash, touch, delete, prune.                 | clean   | —                       |
| `packages/server/src/db/user-repository.ts`               | 74    | Accounts in Postgres, including user plus first session in one transaction.            | fixed   | DEAD-03                 |
| `packages/server/src/encoding.ts`                         | 8     | Base64url and UTF-8 helpers for tokens.                                                | clean   | —                       |
| `packages/server/src/hosting/client-ip.ts`                | 18    | Reads the visitor IP from Cloudflare's headers on Render.                              | clean   | —                       |
| `packages/server/src/http/app.ts`                         | 74    | Builds the Hono app: request id, security headers, request log, routes, errors.        | clean   | —                       |
| `packages/server/src/http/errors.ts`                      | 75    | ApiError and the handler that turns every error into the standard body.                | clean   | —                       |
| `packages/server/src/http/rate-limit.ts`                  | 56    | Per-IP limit middleware; IPv6 counted by its /64.                                      | clean   | —                       |
| `packages/server/src/http/routes/account.ts`              | 35    | DELETE /account with session and auth key.                                             | clean   | —                       |
| `packages/server/src/http/routes/auth.ts`                 | 119   | Prelogin, register, login and logout endpoints with their limits.                      | clean   | —                       |
| `packages/server/src/http/routes/bundles.ts`              | 176   | List, get, put and delete setup endpoints, mapping service errors to API errors.       | fixed   | DB-01, PERF-01, READ-07 |
| `packages/server/src/http/session.ts`                     | 28    | requireSession: bearer token check with one identical 401.                             | clean   | —                       |
| `packages/server/src/http/small-body.ts`                  | 15    | 16 KB body limit for JSON routes.                                                      | clean   | —                       |
| `packages/server/src/http/validate.ts`                    | 28    | Hono validators that parse with contract schemas and answer 400.                       | clean   | —                       |
| `packages/server/src/index.ts`                            | 20    | Package entry: re-exports for tests and the e2e server.                                | clean   | —                       |
| `packages/server/src/logging/crash.ts`                    | 27    | Logs an uncaught error or rejection as one line, then exits 1.                         | clean   | —                       |
| `packages/server/src/logging/logger.ts`                   | 51    | JSON line logger and an error describer that never logs query parameters.              | clean   | —                       |
| `packages/server/src/main.ts`                             | 40    | Process entry on Render: starts the server, shuts down on signals.                     | clean   | —                       |
| `packages/server/src/port.ts`                             | 15    | Reads and checks PORT.                                                                 | clean   | —                       |
| `packages/server/src/rate-limit/postgres-rate-limiter.ts` | 65    | Fixed-window counters in Postgres with an occasional prune.                            | fixed   | BUG-02                  |
| `packages/server/src/rate-limit/rate-limiter.ts`          | 58    | RateLimiter interface, the 429 error and the limit rules.                              | clean   | —                       |
| `packages/server/src/server.ts`                           | 94    | Composition root: settings, Neon pool, keys, limiter, services, app.                   | fixed   | DUP-02                  |
| `packages/server/src/storage/blob-store.ts`               | 46    | BlobStore interface and its in-use error.                                              | clean   | —                       |
| `packages/server/src/storage/postgres-blob-store.ts`      | 57    | Encrypted bytes in `bundle_blobs`, including the orphan sweep.                         | clean   | —                       |

## Server: tests (`packages/server/test`)

Route, service and repository tests on an in-process PGlite database.

| File                                           | Lines | What it does                                                                        | Verdict | Findings        |
| ---------------------------------------------- | ----- | ----------------------------------------------------------------------------------- | ------- | --------------- |
| `packages/server/test/account-routes.test.ts`  | 167   | Account delete: cascade, auth key, other users, bad bodies.                         | fixed   | DUP-06          |
| `packages/server/test/auth-routes.test.ts`     | 285   | Headers, prelogin, register, login and session lifetime through the API.            | fixed   | DUP-06          |
| `packages/server/test/bundle-routes.test.ts`   | 331   | Setup endpoints: access, revisions, checks, paging, delete, account limits.         | fixed   | QA-12, DUP-06   |
| `packages/server/test/bundle-service.test.ts`  | 163   | Service cleanup on failure, parallel reads, over-limit wording.                     | fixed   | DUP-06          |
| `packages/server/test/contracts.test.ts`       | 20    | Parses two contract schemas (nothing server-specific).                              | fixed   | QA-13           |
| `packages/server/test/crash-logging.test.ts`   | 58    | Pool error listener and crash-to-exit handler.                                      | clean   | —               |
| `packages/server/test/env.test.ts`             | 51    | Settings validation and never printing values.                                      | clean   | —               |
| `packages/server/test/hosting.test.ts`         | 70    | Client IP headers, IPv6 /64 subjects and PORT parsing.                              | clean   | —               |
| `packages/server/test/interfaces.test.ts`      | 53    | Tests a fake BlobStore and a status switch defined in the test itself.              | fixed   | QA-13           |
| `packages/server/test/limits-and-logs.test.ts` | 285   | Rate limits, log content and createServerFromEnv.                                   | fixed   | QA-13, DUP-06   |
| `packages/server/test/rate-limiter.test.ts`    | 103   | Postgres rate limiter windows, reset, pseudonyms and prune.                         | fixed   | QA-13           |
| `packages/server/test/repositories.test.ts`    | 558   | Users, sessions, blob store, putMeta, limits, sweep, list paging, delete on PGlite. | fixed   | QA-12, DUP-06   |
| `packages/server/test/schema.test.ts`          | 256   | Migrations, indexes and table constraints on a fresh PGlite.                        | fixed   | DUP-06, READ-07 |
| `packages/server/test/server-keys.test.ts`     | 41    | Auth-key hash check and fake salts.                                                 | clean   | —               |
| `packages/server/test/support/app.ts`          | 77    | Builds the full API on PGlite with a movable clock for route tests.                 | fixed   | DUP-02          |
| `packages/server/test/support/database.ts`     | 23    | Fresh in-memory PGlite with all migrations.                                         | fixed   | QA-12           |

## Server: migrations and config

SQL migrations (applied by hand), drizzle-kit settings, the env template and package config.

| File                                                           | Lines | What it does                                                                     | Verdict | Findings |
| -------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------- | ------- | -------- |
| `packages/server/.env.example`                                 | 10    | Template for the two server settings, DATABASE_URL and SERVER_SECRET.            | fixed   | READ-08  |
| `packages/server/drizzle.config.ts`                            | 22    | drizzle-kit settings; reads the database URL only for commands that connect.     | clean   | —        |
| `packages/server/drizzle/0000_init.sql`                        | 59    | First migration: users, sessions, bundles, bundle_blobs with checks and indexes. | clean   | —        |
| `packages/server/drizzle/0001_ciphertext_storage_external.sql` | 4     | Hand-written migration: store ciphertext uncompressed out of the row.            | clean   | —        |
| `packages/server/drizzle/0002_drop_revision_blob_key.sql`      | 6     | Drops the old revision-based blob key; a bundle size must be at least 1 byte.    | clean   | —        |
| `packages/server/drizzle/0003_blob_ids.sql`                    | 6     | Random blob ids and the same-user foreign key from bundles to their file.        | clean   | —        |
| `packages/server/drizzle/0004_session_last_used_at.sql`        | 0     | Adds `sessions.last_used_at` for the idle timeout.                               | clean   | —        |
| `packages/server/drizzle/0005_rate_limits.sql`                 | 6     | The `rate_limits` counter table and its window index.                            | clean   | —        |
| `packages/server/drizzle/0006_sessions_expires_at_idx.sql`     | 0     | Index for deleting every user's expired sessions.                                | clean   | —        |
| `packages/server/drizzle/meta/_journal.json`                   | 54    | Drizzle's ordered list of the seven migrations.                                  | clean   | —        |
| `packages/server/package.json`                                 | 34    | Server package manifest: exports, scripts, pinned dependencies.                  | clean   | —        |
| `packages/server/tsconfig.json`                                | 14    | TypeScript project for src, test and the drizzle config.                         | clean   | —        |

## CI and automation (`.github`)

CI on every push, the release workflow, the weekly drift check and dependency audit, issue templates.

| File                                         | Lines | What it does                                                                                            | Verdict | Findings              |
| -------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------- | ------- | --------------------- |
| `.github/ISSUE_TEMPLATE/bug_report.yml`      | 61    | GitHub form for bug reports, points security reports to private advisories.                             | clean   | —                     |
| `.github/ISSUE_TEMPLATE/config.yml`          | 8     | Turns off blank issues; links to Discussions and private security reports.                              | clean   | —                     |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | 26    | GitHub form for feature and new-agent requests.                                                         | clean   | —                     |
| `.github/workflows/audit.yml`                | 45    | Weekly `pnpm audit --prod` that fails on any advisory.                                                  | clean   | —                     |
| `.github/workflows/ci.yml`                   | 214   | CI: checks on 3 OSes × 2 Node versions, the npm package installed and run e2e, the two cross-OS chains. | fixed   | PERF-02, QA-15, BP-04 |
| `.github/workflows/drift-check.yml`          | 141   | Weekly check of the Claude Code data file against the newest Claude Code; files one `drift` issue.      | clean   | —                     |
| `.github/workflows/release.yml`              | 189   | Tag release: CI-passed gate, verify on every OS, approval, npm trusted publishing, `npx` check.         | clean   | —                     |

## Docs (`docs`)

Architecture, roadmap, the agent guide, the threat model and earlier review reports.

| File                                  | Lines | What it does                                                        | Verdict | Findings |
| ------------------------------------- | ----- | ------------------------------------------------------------------- | ------- | -------- |
| `docs/ADDING-AN-AGENT.md`             | 326   | Step-by-step guide to writing a new agent adapter.                  | fixed   | ARCH-02  |
| `docs/ARCHITECTURE.md`                | 786   | How the system works and what every file does.                      | fixed   | READ-10  |
| `docs/decisions/0001-libraries.md`    | 69    | Decision record for the crypto, CLI, prompt and keychain libraries. | clean   | —        |
| `docs/reviews/review-2026-10-03-2.md` | 143   | Second review pass (SOLID), all findings ticked.                    | clean   | —        |
| `docs/reviews/review-2026-10-03-3.md` | 244   | Third review pass, all findings ticked.                             | clean   | —        |
| `docs/reviews/review-2026-10-03.md`   | 361   | First review pass, all findings ticked.                             | clean   | —        |
| `docs/ROADMAP.md`                     | 160   | Planned stages: more agents, data-only agents, v2 conversion.       | fixed   | READ-12  |
| `docs/security/threat-model.md`       | 142   | Threats, defences, tests, past findings and accepted risks.         | fixed   | READ-11  |

## Portfolio entry (`.a1x6`)

Data for the project page on a1x6.dev. Not part of the product.

| File                 | Lines | What it does                                                       | Verdict | Findings |
| -------------------- | ----- | ------------------------------------------------------------------ | ------- | -------- |
| `.a1x6/project.json` | 44    | Portfolio entry for a1x6.dev (title, description, skills, images). | clean   | —        |

## Repo root

Workspace config, lint, format, test and deploy settings, README, license, security and contributing notes.

| File                  | Lines | What it does                                                                       | Verdict | Findings |
| --------------------- | ----- | ---------------------------------------------------------------------------------- | ------- | -------- |
| `.editorconfig`       | 9     | UTF-8, LF, 2-space indentation for every file.                                     | clean   | —        |
| `.gitattributes`      | 2     | Stores text files with LF line endings on every OS.                                | clean   | —        |
| `.gitignore`          | 17    | Ignores builds, coverage, env files, release output and brag output.               | clean   | —        |
| `.prettierignore`     | 5     | Keeps Prettier off builds, the lockfile and Drizzle snapshots.                     | clean   | —        |
| `.prettierrc.json`    | 4     | Prettier style: single quotes, width 100.                                          | clean   | —        |
| `CONTRIBUTING.md`     | 139   | How to set up, test, write code for and release the project.                       | clean   | —        |
| `eslint.config.js`    | 45    | ESLint strict type-checked rules plus the agent-boundary import rule.              | clean   | —        |
| `knip.json`           | 16    | Unused-code check settings and extra entry points per workspace.                   | clean   | —        |
| `LICENSE`             | 21    | MIT license text.                                                                  | clean   | —        |
| `package.json`        | 42    | Root scripts (build, check, test, e2e, release, knip) and exact dev tool versions. | clean   | —        |
| `pnpm-workspace.yaml` | 14    | Workspace packages, one-day release age, no install scripts, esbuild override.     | clean   | —        |
| `README.md`           | 229   | User-facing overview: install, commands, flags, what is synced, security.          | clean   | —        |
| `render.yaml`         | 40    | Render service for the API: build, start, health check, deploy filter, env names.  | fixed   | PERF-03  |
| `SECURITY.md`         | 63    | How to report a vulnerability and how data is protected.                           | fixed   | READ-11  |
| `tsconfig.base.json`  | 31    | Shared strict TypeScript settings.                                                 | clean   | —        |
| `tsconfig.json`       | 10    | Root project references to the five packages.                                      | clean   | —        |
| `vitest.config.ts`    | 27    | One test project per package and the coverage settings.                            | clean   | —        |
