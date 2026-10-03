# File Ledger — Agent Nomad — 2026-10-03 (review 6)

257 files, 37,514 lines, all read in full at `dev` `b8bb510`. Verdicts: 215 clean, 42 minor, 0 needs work, 0 rewrite. Finding IDs refer to `report.md` in this folder.

## CLI: agent adapters (`packages/cli/src/agents`)

The adapter interface every agent implements, the registry, and the Claude Code adapter: what push collects, what pull may write, the review of anything that can run, plugins and programs. Push and pull call it only through `adapter.ts`.

| File                                                            | Lines | What it does                                                                                                                                        | Verdict | Findings              |
| --------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------- |
| `packages/cli/src/agents/adapter.ts`                            | 279   | Defines the adapter contract (detector, collector, restorer, inspector, optional parts, plan step) that push and pull use for any agent.            | clean   | —                     |
| `packages/cli/src/agents/agents-command.ts`                     | 40    | Runs `agentnomad agents`: detects every registered agent and prints one line each, plus the agents' notices.                                        | clean   | —                     |
| `packages/cli/src/agents/claude-code/account-skills.ts`         | 155   | Reads the user's own claude.ai skills from `skills/synced/`, saves a copy, and plans which ones pull may add as local skills.                       | clean   | —                     |
| `packages/cli/src/agents/claude-code/after-restore.ts`          | 270   | Pull's Claude Code follow-up: asks about plugins, missing npm programs and claude.ai skills in the plan step, and installs them after writing.      | clean   | —                     |
| `packages/cli/src/agents/claude-code/auto-memory.ts`            | 152   | Finds a project's auto memory folder the way Claude Code does, and refuses folders a project's settings may not choose.                             | clean   | —                     |
| `packages/cli/src/agents/claude-code/claude-code-adapter.ts`    | 157   | Builds the Claude Code adapter from its parts and asks pull's "close Claude Code" question.                                                         | clean   | —                     |
| `packages/cli/src/agents/claude-code/claude-code-paths.data.ts` | 245   | Data file of every list for sync, skip or refuse, checked against a schema at load.                                                                 | clean   | —                     |
| `packages/cli/src/agents/claude-code/claude-json-merge.ts`      | 198   | Merges only the MCP servers and preference keys into `~/.claude.json`: backs it up first, never writes while Claude Code runs.                      | minor   | SEC-02                |
| `packages/cli/src/agents/claude-code/command-review.ts`         | 326   | Lists what runs programs in an incoming setup (hooks, settings, MCP servers, scripts, `!` Markdown) that is new or changed on this PC.              | minor   | SEC-01                |
| `packages/cli/src/agents/claude-code/detector.ts`               | 91    | Finds the `claude` command, its version and Claude Code's base folder.                                                                              | clean   | —                     |
| `packages/cli/src/agents/claude-code/env-files.ts`              | 25    | Lists which Claude Code files can hold `${VAR}` references, and the variables Claude Code sets itself.                                              | minor   | DUP-01                |
| `packages/cli/src/agents/claude-code/global-collector.ts`       | 193   | Collects the global setup: base-folder files and folders, hook scripts, tool settings, programs, `~/.claude.json` keys, plugins and account skills. | clean   | —                     |
| `packages/cli/src/agents/claude-code/global-paths.ts`           | 94    | Gives names and lookups to the data file's global lists, and defines the reserved bundle paths.                                                     | clean   | —                     |
| `packages/cli/src/agents/claude-code/hook-scripts.ts`           | 108   | Finds the scripts that global and project hooks run: what push collects and what pull allows back.                                                  | clean   | —                     |
| `packages/cli/src/agents/claude-code/managed-settings.ts`       | 222   | Detects organization-managed Claude Code settings per OS and words the notice and plugin-failure reasons.                                           | minor   | UX-03                 |
| `packages/cli/src/agents/claude-code/plugin-sync.ts`            | 326   | Plans and asks about plugin reinstalls, runs `claude plugin` commands, and runs a program safely through `cmd.exe` shims.                           | minor   | UX-03                 |
| `packages/cli/src/agents/claude-code/plugins.ts`                | 269   | Reads installed plugins and marketplaces into `plugins.json`, using the entry schemas that push and pull share.                                     | clean   | —                     |
| `packages/cli/src/agents/claude-code/programs.ts`               | 129   | Finds programs that hooks start and whether npm installed them; holds the `programs.json` entry schema.                                             | clean   | —                     |
| `packages/cli/src/agents/claude-code/project-collector.ts`      | 136   | Collects a project's setup: root files, `.claude/` files and folders, hook scripts, auto memory and plugins.                                        | minor   | DUP-01                |
| `packages/cli/src/agents/claude-code/project-paths.ts`          | 30    | Gives names to the data file's project lists.                                                                                                       | clean   | —                     |
| `packages/cli/src/agents/claude-code/restore-rules.ts`          | 142   | Decides where each bundle entry may be written, or why it is refused (global and project).                                                          | minor   | READ-02               |
| `packages/cli/src/agents/claude-code/restorer.ts`               | 428   | Writes a pulled setup: atomic writes, permissions, line endings, conflicts, case-folding, and warnings about hooks from another OS.                 | minor   | SEC-02, UX-02, DUP-01 |
| `packages/cli/src/agents/claude-code/reviewed-settings.ts`      | 70    | Lists the settings keys and `env` names that the pull review watches, plus the drift watch list.                                                    | clean   | —                     |
| `packages/cli/src/agents/claude-code/runnable-markdown.ts`      | 60    | Finds what a skill, command or subagent Markdown file runs by itself (`!` placeholders, ` ```! ` blocks, frontmatter hooks).                        | clean   | —                     |
| `packages/cli/src/agents/claude-code/running-claude.ts`         | 139   | Checks whether Claude Code or the Claude app is running, from the process list.                                                                     | clean   | —                     |
| `packages/cli/src/agents/claude-code/settings-commands.ts`      | 150   | Parses settings hooks one by one, splits command lines into words and finds the program a command starts.                                           | clean   | —                     |
| `packages/cli/src/agents/claude-code/unknown-files.ts`          | 119   | Reports entries in Claude Code's folder (or a project's `.claude/`) that the data file does not know.                                               | clean   | —                     |
| `packages/cli/src/agents/notices.ts`                            | 67    | Builds what commands say about any agent: the version warning, unknown entries, and notices shown once each.                                        | clean   | —                     |
| `packages/cli/src/agents/registry.ts`                           | 20    | Builds the agent registry by id and refuses an agent that is registered twice.                                                                      | clean   | —                     |
| `packages/cli/src/agents/shared/bundle-paths.ts`                | 18    | The one "is this bundle path under that folder" helper, with the per-OS case rule.                                                                  | clean   | —                     |
| `packages/cli/src/agents/shared/detector-system.ts`             | 134   | What any detector reads from the PC, plus a PATH lookup that works like a shell (PATHEXT on Windows, `~/.local/bin`).                               | clean   | —                     |
| `packages/cli/src/agents/shared/file-gathering.ts`              | 191   | Reads files and folders into bundle entries; follows links safely, skips huge files and clutter.                                                    | clean   | —                     |

## CLI: commands and shared code (`packages/cli/src`, outside `agents`)

The `agentnomad` command: the option parser, push and pull (plan, then apply), login and account commands, the API client, environment values, the secret store, local state, and the terminal output. `app.ts` wires it together.

| File                                              | Lines | What it does                                                                                                                               | Verdict | Findings         |
| ------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ---------------- |
| `packages/cli/src/api/api-client.ts`              | 74    | The `ApiClient` interface (auth and bundle calls) and the upload/download shapes                                                           | clean   | —                |
| `packages/cli/src/api/api-errors.ts`              | 78    | The CLI's error classes for API answers, network failures, unknown outcomes, bad answers and no login                                      | clean   | —                |
| `packages/cli/src/api/api-url.ts`                 | 28    | Picks the server address from `AGENTNOMAD_API_URL` or the hosted API, https only except localhost                                          | clean   | —                |
| `packages/cli/src/api/http-api-client.ts`         | 379   | `ApiClient` over fetch: wake-up check, timeouts by size, tolerant answer parsing, SHA-256 checks, no retry for register and account delete | clean   | —                |
| `packages/cli/src/api/transport.ts`               | 184   | One HTTP call with per-attempt timeout, retries with backoff on network errors and 502/503/504, capped body reads, redirects refused       | clean   | —                |
| `packages/cli/src/app.ts`                         | 218   | Composition root: builds every real service lazily and wires all command handlers                                                          | clean   | —                |
| `packages/cli/src/auth/auth-commands.ts`          | 371   | `register`, `login`, `logout` and `account delete`, with key derivation, wiping and script flags                                           | clean   | —                |
| `packages/cli/src/auth/local-session.ts`          | 62    | Saves, reads and clears the session token and data key; turns a 401 into "session expired"                                                 | clean   | —                |
| `packages/cli/src/auth/password-policy.ts`        | 71    | Password rules (12–256 graphemes, zxcvbn score 4) and the lazily loaded zxcvbn checker                                                     | clean   | —                |
| `packages/cli/src/bin.ts`                         | 28    | The executable: picks the terminal or no-terminal prompter, runs the CLI, sets the exit code                                               | clean   | —                |
| `packages/cli/src/cli/commands.ts`                | 75    | Option types for every command and the `CommandHandlers` interface                                                                         | clean   | —                |
| `packages/cli/src/cli/error-messages.ts`          | 24    | The one-line message for a failed command (rate limits, server errors)                                                                     | clean   | —                |
| `packages/cli/src/cli/flags.ts`                   | 43    | Validates `--agent`, `--project` and `--username` values for commander                                                                     | clean   | —                |
| `packages/cli/src/cli/program.ts`                 | 270   | Every command, flag and help text on commander; maps flags to handler options                                                              | minor   | READ-03, ARCH-02 |
| `packages/cli/src/cli/project-folder.ts`          | 32    | Says why a folder (home, the agent's own folder) cannot be a project                                                                       | clean   | —                |
| `packages/cli/src/cli/run.ts`                     | 89    | Runs one invocation: exit codes, Ctrl+C, the "needs an answer" hint per command                                                            | clean   | —                |
| `packages/cli/src/cli/setup-outcomes.ts`          | 45    | Per-setup outcomes of push and pull, `setupLabel`, and the one "Not saved / Not restored" error                                            | clean   | —                |
| `packages/cli/src/cli/stdin.ts`                   | 31    | Reads the first line of a piped stdin for `--password-stdin`, refusing a terminal                                                          | clean   | —                |
| `packages/cli/src/commands/setup-commands.ts`     | 194   | `list`, `status` and `delete` over the decrypted list of saved setups                                                                      | clean   | —                |
| `packages/cli/src/config/config-dir.ts`           | 24    | agentnomad's config folder per OS (`APPDATA`, `XDG_CONFIG_HOME`, `~/.config`)                                                              | clean   | —                |
| `packages/cli/src/env/env-command.ts`             | 98    | `agentnomad env`: lists the `${VAR}`s the setups here use and whether each is set                                                          | clean   | —                |
| `packages/cli/src/env/env-references.ts`          | 106   | Finds `${VAR}` references in the files an adapter names, and merges scans                                                                  | clean   | —                |
| `packages/cli/src/env/env-restore.ts`             | 145   | Pull's env plan (which saved values to add, gated ones asked apart) and the write step                                                     | clean   | —                |
| `packages/cli/src/env/env-section.ts`             | 75    | The encrypted `.agentnomad/env.json` section: schema, file, parsing, and push's opt-in choice                                              | clean   | —                |
| `packages/cli/src/env/loader-variables.ts`        | 13    | The regex of variable names that make shells and runtimes load or run code                                                                 | clean   | —                |
| `packages/cli/src/env/shell-profile.ts`           | 226   | Reads and writes the marked env block in sh/fish profiles, or Windows user variables through PowerShell                                    | minor   | BUG-01           |
| `packages/cli/src/index.ts`                       | 75    | Re-exports the CLI's modules for tests and the e2e package                                                                                 | clean   | —                |
| `packages/cli/src/pull/pull-command.ts`           | 597   | `pull`: a plan step that downloads, checks and asks everything, and an apply step with no prompter                                         | minor   | SEC-02           |
| `packages/cli/src/pull/saved-setups.ts`           | 148   | Lists every saved setup (all pages, names decrypted) and downloads and checks one                                                          | clean   | —                |
| `packages/cli/src/push/bundle-files.ts`           | 90    | Converts collected files to bundle entries and back (`{{HOME}}`, base64), keeping equivalent local bytes                                   | clean   | —                |
| `packages/cli/src/push/push-command.ts`           | 538   | `push`: a plan step (choose, collect, every question) and an apply step that encrypts and uploads                                          | minor   | UX-01            |
| `packages/cli/src/secrets/create-secret-store.ts` | 64    | Chooses the keychain or the file store, and moves a file login into a recovered keychain                                                   | clean   | —                |
| `packages/cli/src/secrets/file-store.ts`          | 207   | The user-only secrets file, with Windows ACL tightening and atomic writes                                                                  | clean   | —                |
| `packages/cli/src/secrets/keychain-store.ts`      | 50    | `SecretStore` on the OS keychain through @napi-rs/keyring                                                                                  | clean   | —                |
| `packages/cli/src/secrets/secret-store.ts`        | 18    | The `SecretStore` interface and the two secret names                                                                                       | clean   | —                |
| `packages/cli/src/state/local-state.ts`           | 198   | `state.json`: project names per folder, known revisions, the partial-pull note and the account, per server                                 | minor   | UX-01            |
| `packages/cli/src/system/files.ts`                | 70    | `writeFileAtomically`, `writeTargetOf` and `isMissing`                                                                                     | clean   | —                |
| `packages/cli/src/system/json.ts`                 | 29    | `parseJsonWith`: JSON text or bytes checked with a schema, the value or a short problem                                                    | clean   | —                |
| `packages/cli/src/system/paths.ts`                | 12    | `pathKey` and `samePath`: folders compared per OS                                                                                          | clean   | —                |
| `packages/cli/src/system/run-program.ts`          | 49    | `runProgram`: one `execFile` wrapper (no shell, timeout, never rejects)                                                                    | clean   | —                |
| `packages/cli/src/ui/clack-prompter.ts`           | 124   | The `Prompter` and `Reporter` on @clack/prompts, every shown text through `printable`                                                      | clean   | —                |
| `packages/cli/src/ui/format-size.ts`              | 7     | Formats byte counts as B, KB or MB                                                                                                         | clean   | —                |
| `packages/cli/src/ui/no-terminal-prompter.ts`     | 31    | The prompter for scripts: every question fails with `AnswerNeededError`                                                                    | clean   | —                |
| `packages/cli/src/ui/printable.ts`                | 42    | Shows terminal control and bidi characters as `\u{…}`; `printableLine` also escapes line breaks and tabs                                   | clean   | —                |
| `packages/cli/src/ui/prompter.ts`                 | 66    | The `Prompter`, `Reporter` and `Spinner` interfaces and `PromptCancelledError`                                                             | clean   | —                |
| `packages/cli/src/version.ts`                     | 2     | The CLI version string                                                                                                                     | clean   | —                |

## CLI: scripts (`packages/cli/scripts`)

The npm package build and the weekly Claude Code drift check.

| File                                              | Lines | What it does                                                                                                                                             | Verdict | Findings |
| ------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| `packages/cli/scripts/build-release.ts`           | 132   | Bundles cli, core and contracts with esbuild into the npm package, checks nothing foreign is bundled and every import is declared, writes the shrinkwrap | clean   | —        |
| `packages/cli/scripts/drift/check-claude-code.ts` | 87    | Fetches the docs page, changelog and latest version, runs the drift report and writes it for GitHub Actions                                              | clean   | —        |
| `packages/cli/scripts/drift/drift.ts`             | 195   | Pure drift comparison: unknown names in the docs and a fresh install, relevant changelog lines, the issue Markdown                                       | minor   | BUG-02   |

## CLI: tests (`packages/cli/test`)

Unit and command tests for the CLI. They run against temporary folders and fake servers.

| File                                                      | Lines | What it does                                                                                                                                                     | Verdict | Findings        |
| --------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------- |
| `packages/cli/test/agent-boundary.test.ts`                | 357   | Runs push and pull end to end with a made-up second agent built only from the adapter interface.                                                                 | minor   | DUP-02          |
| `packages/cli/test/agent-registry.test.ts`                | 67    | Tests the agent registry, the `agents` command output, and (misfiled) the Claude Code adapter's detect/collect/restore.                                          | clean   | —               |
| `packages/cli/test/api-client.test.ts`                    | 626   | Tests the HTTP API client against a fake fetch: requests, contract checks, retries, no-retry operations, rate limits, wake-up and timeouts, and `resolveApiUrl`. | clean   | —               |
| `packages/cli/test/auth-commands.test.ts`                 | 999   | Tests register, login, logout, account delete, the password policy and key wiping against an in-memory account server.                                           | minor   | READ-02         |
| `packages/cli/test/bin.test.ts`                           | 72    | Runs the real `agentnomad` entry file in a child process with a temp home, plus one clack-prompter check.                                                        | clean   | —               |
| `packages/cli/test/claude-code-account-skills.test.ts`    | 304   | Tests reading, saving and restoring the user's claude.ai-synced skills.                                                                                          | clean   | —               |
| `packages/cli/test/claude-code-adapter.test.ts`           | 179   | Tests the adapter's plan step that asks to close Claude Code before `~/.claude.json` changes.                                                                    | minor   | DUP-02          |
| `packages/cli/test/claude-code-after-restore.test.ts`     | 297   | Tests the post-pull follow-up: npm program installs, plugin reinstalls and warnings for unreadable saved lists.                                                  | minor   | DUP-02          |
| `packages/cli/test/claude-code-claude-json-merge.test.ts` | 85    | Tests the standalone `~/.claude.json` merge.                                                                                                                     | clean   | —               |
| `packages/cli/test/claude-code-command-review.test.ts`    | 536   | Tests what the pull review lists as runnable (hooks, settings, env, MCP servers, Markdown `!` blocks) and `printable`.                                           | minor   | READ-02         |
| `packages/cli/test/claude-code-detector.test.ts`          | 239   | Tests finding Claude Code, its config folder and version on fake and real PCs.                                                                                   | clean   | —               |
| `packages/cli/test/claude-code-drift.test.ts`             | 187   | Tests the weekly drift check: docs names, changelog filtering, report and inert Markdown.                                                                        | clean   | —               |
| `packages/cli/test/claude-code-global-collector.test.ts`  | 608   | Tests what the global collector takes from `~/.claude` and `~/.claude.json`, hook scripts, links and program records.                                            | minor   | READ-02         |
| `packages/cli/test/claude-code-paths-data.test.ts`        | 153   | Tests the paths data file, the unknown-file check and the version-stamp notice.                                                                                  | minor   | READ-02         |
| `packages/cli/test/claude-code-plugins.test.ts`           | 432   | Tests the plugin manifest saved on push, its schema, and plugin reinstall on pull.                                                                               | clean   | —               |
| `packages/cli/test/claude-code-project-collector.test.ts` | 356   | Tests what the project collector takes, link and size rules, auto-memory location and command splitting.                                                         | minor   | READ-02         |
| `packages/cli/test/claude-code-restorer.test.ts`          | 1090  | Tests the Claude Code restorer: refused paths, conflicts, backups, `~/.claude.json` merge, home files, line endings, Windows names                               | minor   | DUP-02, READ-02 |
| `packages/cli/test/claude-code-running.test.ts`           | 71    | Tests which process command lines count as a running Claude Code                                                                                                 | clean   | —               |
| `packages/cli/test/env.test.ts`                           | 738   | Tests `${VAR}` scanning, saving values on push, shell profile and Windows env writers, restoring values on pull, and `agentnomad env`                            | minor   | DUP-02          |
| `packages/cli/test/fakes.ts`                              | 259   | Shared test fakes: partial API client, in-memory secret store, scripted prompter, recording reporter, revision-checking bundle server                            | clean   | —               |
| `packages/cli/test/fakes.test.ts`                         | 49    | Tests the shared test fakes that carry logic (the fake API and prompter).                                                                                        | clean   | —               |
| `packages/cli/test/json.test.ts`                          | 29    | Tests `parseJsonWith` and `valueOrNull`                                                                                                                          | clean   | —               |
| `packages/cli/test/local-state.test.ts`                   | 81    | Tests per-account revisions and unreadable state files in the local state store                                                                                  | clean   | —               |
| `packages/cli/test/managed-settings.test.ts`              | 249   | Tests managed-settings detection per OS, the `reg query` parser, notices and policy-blocked plugin messages                                                      | minor   | DUP-02          |
| `packages/cli/test/no-terminal.test.ts`                   | 48    | Tests the no-terminal prompter and `--password-stdin` line reading                                                                                               | minor   | READ-02         |
| `packages/cli/test/program.test.ts`                       | 407   | Tests the CLI parser: help, version, routing, flag mapping, refusals and exit codes                                                                              | clean   | —               |
| `packages/cli/test/pull-command.test.ts`                  | 875   | End-to-end style tests of pull (push on one fake PC, pull on another), plan/apply split, and bundle listing                                                      | minor   | DUP-02          |
| `packages/cli/test/push-command.test.ts`                  | 644   | Tests push: encryption, project names, revisions, account skills, plan/apply split, data-key wiping                                                              | minor   | DUP-02          |
| `packages/cli/test/secret-store.test.ts`                  | 339   | Tests the config folder, file store, keychain store, store selection and (opt-in) the real OS keychain                                                           | minor   | READ-02         |
| `packages/cli/test/setup-commands.test.ts`                | 266   | Tests `list`, `status`, `delete`, setup labels and time/size formatting                                                                                          | minor   | READ-02         |
| `packages/cli/test/stub-restorer.ts`                      | 15    | A no-op restorer for tests about other parts                                                                                                                     | clean   | —               |
| `packages/cli/test/system.test.ts`                        | 351   | Tests thin OS wrappers: program launching, process listing, icacls parsing, and the real programs on each OS                                                     | clean   | —               |
| `packages/cli/test/ui.test.ts`                            | 37    | Tests the printable-text rules and the reporter output.                                                                                                          | clean   | —               |

## CLI: package config

Manifest and TypeScript settings of the CLI package.

| File                         | Lines | What it does                                                                                                    | Verdict | Findings |
| ---------------------------- | ----- | --------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| `packages/cli/package.json`  | 37    | The CLI package manifest: pinned dependencies, the `agentnomad-source` export condition, build and test scripts | clean   | —        |
| `packages/cli/tsconfig.json` | 17    | TypeScript project for the CLI (src, test, scripts) with references to contracts and core                       | clean   | —        |

## Contracts (`packages/contracts`)

Zod schemas, limits and byte-encoding helpers shared by the CLI and the server. The one description of the API.

| File                                       | Lines | What it does                                                                                                   | Verdict | Findings |
| ------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| `packages/contracts/package.json`          | 22    | Contracts manifest (only Zod) with the source export condition.                                                | clean   | —        |
| `packages/contracts/src/api/answers.ts`    | 51    | Tolerant client forms of every API answer, built from the strict shapes.                                       | clean   | —        |
| `packages/contracts/src/api/auth.ts`       | 95    | Username, Argon2id settings (bounds and defaults) and every auth request/answer schema.                        | clean   | —        |
| `packages/contracts/src/api/bundles.ts`    | 106   | Scope keys, list query and answer, upload/download header schemas.                                             | clean   | —        |
| `packages/contracts/src/api/common.ts`     | 95    | Byte sizes, limits, routes, header names, client version, error codes and error body.                          | clean   | —        |
| `packages/contracts/src/bundle.ts`         | 131   | The plaintext bundle schema: format, agent, scope, OS, version, revision, safe file paths, project-name rules. | clean   | —        |
| `packages/contracts/src/encoding.ts`       | 35    | Base64, hex and byte-compare helpers on web-standard APIs; strict `fromHex`.                                   | clean   | —        |
| `packages/contracts/src/index.ts`          | 7     | Re-exports the contracts package.                                                                              | clean   | —        |
| `packages/contracts/src/primitives.ts`     | 48    | Schema building blocks: sized base64, SHA-256 hex, timestamps, one-line text.                                  | clean   | —        |
| `packages/contracts/test/answers.test.ts`  | 214   | Proves the client schemas drop unknown fields at every level but keep every bound.                             | clean   | —        |
| `packages/contracts/test/api.test.ts`      | 287   | Tests the API schemas: sizes, KDF bounds, usernames, register/login, params, headers, list query.              | clean   | —        |
| `packages/contracts/test/bundle.test.ts`   | 193   | Tests the bundle schema and NFC project-name rules.                                                            | clean   | —        |
| `packages/contracts/test/encoding.test.ts` | 38    | Round trips and invalid-hex cases for the encoding helpers.                                                    | clean   | —        |
| `packages/contracts/tsconfig.json`         | 10    | Build settings for contracts (no Node types).                                                                  | clean   | —        |

## Core (`packages/core`)

Encryption, key derivation, the bundle format, path rules and merge strategies. No Node APIs, so it is easy to test.

| File                                          | Lines | What it does                                                                                                      | Verdict | Findings |
| --------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| `packages/core/package.json`                  | 24    | Core manifest (contracts, fflate, libsodium) with the source export condition.                                    | clean   | —        |
| `packages/core/src/bundle-codec.ts`           | 23    | The `BundleCodec` interface and `BundleFormatError`.                                                              | clean   | —        |
| `packages/core/src/crypto.ts`                 | 70    | The crypto interfaces and `DecryptionError`.                                                                      | clean   | —        |
| `packages/core/src/envelopes.ts`              | 77    | Wraps the data key and seals/opens bundles bound to format version, agent and scope key.                          | clean   | —        |
| `packages/core/src/gzip-bundle-codec.ts`      | 112   | JSON + gzip codec with a declared-size and running-total 64 MB cap and a schema check.                            | clean   | —        |
| `packages/core/src/index.ts`                  | 10    | Re-exports the core package.                                                                                      | clean   | —        |
| `packages/core/src/merge-strategies.ts`       | 153   | JSON merge (unsafe numbers kept side by side), side-by-side copy, overwrite with backup, and the per-file choice. | clean   | —        |
| `packages/core/src/merge.ts`                  | 32    | The `MergeStrategy` interface and its input and output types.                                                     | clean   | —        |
| `packages/core/src/path-resolver.ts`          | 179   | Bundle path ↔ OS path, home folder ↔ `{{HOME}}` in text, Windows name rules.                                      | clean   | —        |
| `packages/core/src/paths.ts`                  | 58    | The `PathResolver` interface, `{{HOME}}`, `PathError`, `sourceOsOf`.                                              | clean   | —        |
| `packages/core/src/project-names.ts`          | 74    | Scope keys (keyed hash of a project name) and encrypted project names.                                            | clean   | —        |
| `packages/core/src/sodium-crypto.ts`          | 128   | The crypto service on libsodium: Argon2id with wiping, key split, XChaCha20-Poly1305, BLAKE2b, SHA-256.           | clean   | —        |
| `packages/core/test/bundle-codec.test.ts`     | 124   | Codec round trip, determinism, rejections and both bomb guards.                                                   | clean   | —        |
| `packages/core/test/crypto.test.ts`           | 234   | Key-derivation vector, NFC, wiping, sealing, tampering, key wrapping and context binding.                         | minor   | QA-01    |
| `packages/core/test/interfaces.test.ts`       | 15    | Type-only checks of the core interfaces (`expectTypeOf`).                                                         | clean   | —        |
| `packages/core/test/merge-strategies.test.ts` | 226   | The three strategies, unsafe numbers, BOM, `__proto__`, and strategy selection.                                   | clean   | —        |
| `packages/core/test/paths.test.ts`            | 265   | Path conversion, Windows names, `{{HOME}}` rewriting on every OS pair, home checks.                               | minor   | READ-02  |
| `packages/core/test/project-names.test.ts`    | 143   | Scope keys, NFC, case, and project-name encryption bound to agent and scope.                                      | minor   | QA-01    |
| `packages/core/tsconfig.json`                 | 15    | Build settings for core (no Node types), referencing contracts.                                                   | clean   | —        |

## End-to-end tests (`packages/e2e`)

Runs the built CLI against a local server (PGlite) as several simulated PCs, also across operating systems in CI.

| File                                  | Lines | What it does                                                                                                                  | Verdict | Findings |
| ------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| `packages/e2e/package.json`           | 18    | e2e manifest (cli, server, PGlite, Hono node server, Drizzle).                                                                | clean   | —        |
| `packages/e2e/src/local-server.ts`    | 100   | The real API (`createApi`) on PGlite on a free port, loaded from / dumped to a file, recording every request.                 | clean   | —        |
| `packages/e2e/src/pc.ts`              | 152   | A simulated PC (own home, config, project) that runs the built CLI with no terminal, optionally without the keychain.         | clean   | —        |
| `packages/e2e/src/plaintext.ts`       | 97    | Searches recorded requests for secrets as text, escaped, URL-encoded, hex, base64 at any alignment, and inflated.             | clean   | —        |
| `packages/e2e/src/push-env-value.ts`  | 43    | Runs push in a child process with the env-value question answered.                                                            | clean   | —        |
| `packages/e2e/src/steps.ts`           | 476   | The three end-to-end steps (push; pull/merge/edit/push; pull/overwrite, stale PC, delete, account delete) and the leak check. | clean   | —        |
| `packages/e2e/test/cross-os.test.ts`  | 44    | Runs one step per machine (CI chains) or all three in a row.                                                                  | clean   | —        |
| `packages/e2e/test/plaintext.test.ts` | 76    | Proves the leak search finds every form it claims to.                                                                         | clean   | —        |
| `packages/e2e/tsconfig.json`          | 10    | Build settings for e2e (references cli and server).                                                                           | clean   | —        |
| `packages/e2e/vitest.config.ts`       | 14    | e2e Vitest settings: source condition, 10-minute timeout.                                                                     | clean   | —        |

## Server: source (`packages/server/src`)

The Hono API: accounts and sessions, encrypted bundle storage, rate limits, logging. It stores only ciphertext. `server.ts` wires it for production.

| File                                                      | Lines | What it does                                                                                              | Verdict | Findings |
| --------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------- | ------- | -------- |
| `packages/server/src/api.ts`                              | 67    | `createApi`: builds repositories, limiter, services and the Hono app from one database.                   | clean   | —        |
| `packages/server/src/auth/auth-service.ts`                | 187   | Prelogin, register, login, logout, account delete and session checks, with the per-account failure limit. | clean   | —        |
| `packages/server/src/auth/server-keys.ts`                 | 84    | Derives per-purpose HMAC keys from SERVER_SECRET: auth hashes, fake salts, rate-limit pseudonyms.         | clean   | —        |
| `packages/server/src/auth/session-tokens.ts`              | 19    | Makes a 256-bit base64url session token and its SHA-256 hex hash.                                         | clean   | —        |
| `packages/server/src/bundles/bundle-service.ts`           | 206   | Saved-setup rules: upload checks, storage limits, safe upload order, quiet cleanup and sweep.             | clean   | —        |
| `packages/server/src/db/bundle-cursor.ts`                 | 66    | Encodes and strictly decodes the list cursor (time text plus id).                                         | clean   | —        |
| `packages/server/src/db/bundle-repository.ts`             | 179   | Bundle metadata in Postgres: keyset list, get, locked save with revision and limit checks, usage, delete. | clean   | —        |
| `packages/server/src/db/database.ts`                      | 18    | The driver-neutral Drizzle type and a helper that reads a Postgres error code.                            | clean   | —        |
| `packages/server/src/db/env.ts`                           | 67    | Zod checks for DATABASE_URL and SERVER_SECRET that never print values.                                    | clean   | —        |
| `packages/server/src/db/repositories.ts`                  | 191   | Repository interfaces, record types and the repository error classes.                                     | clean   | —        |
| `packages/server/src/db/schema.ts`                        | 195   | Drizzle table definitions, the bytea column type and the check constraints.                               | clean   | —        |
| `packages/server/src/db/session-repository.ts`            | 81    | Sessions in Postgres: create, find a live one, touch, delete, prune stale and expired.                    | clean   | —        |
| `packages/server/src/db/user-repository.ts`               | 72    | Users in Postgres: find, create together with the first session in one transaction, delete.               | clean   | —        |
| `packages/server/src/encoding.ts`                         | 18    | Server-only text helpers: base64url and UTF-8 encode.                                                     | clean   | —        |
| `packages/server/src/hosting/client-ip.ts`                | 18    | Reads the visitor IP on Render from CF-Connecting-IP, then True-Client-IP.                                | clean   | —        |
| `packages/server/src/http/app.ts`                         | 74    | The Hono app: request id, no-store and nosniff headers, one log line per request, routes, error handlers. | clean   | —        |
| `packages/server/src/http/errors.ts`                      | 75    | `ApiError` and the handlers that turn every error into the standard error body.                           | clean   | —        |
| `packages/server/src/http/rate-limit.ts`                  | 66    | Per-IP limit middleware; counts an IPv6 address by its /64.                                               | clean   | —        |
| `packages/server/src/http/routes/account.ts`              | 35    | `DELETE /account`: needs a session and the auth key.                                                      | clean   | —        |
| `packages/server/src/http/routes/auth.ts`                 | 119   | Prelogin, register, login and logout routes with per-IP limits.                                           | clean   | —        |
| `packages/server/src/http/routes/bundles.ts`              | 177   | List, download, upload and delete routes; session check; write limit; 5 MB body limit.                    | clean   | —        |
| `packages/server/src/http/session.ts`                     | 28    | `requireSession` middleware: Bearer token check, same 401 for every failure.                              | clean   | —        |
| `packages/server/src/http/small-body.ts`                  | 15    | 16 KB body limit for the JSON routes.                                                                     | clean   | —        |
| `packages/server/src/http/validate.ts`                    | 28    | Hono validators that parse with a contracts schema, or answer 400.                                        | clean   | —        |
| `packages/server/src/index.ts`                            | 21    | Package entry: re-exports 20 source modules.                                                              | clean   | —        |
| `packages/server/src/logging/crash.ts`                    | 27    | Logs an uncaught error or unhandled rejection as one line, then exits 1.                                  | clean   | —        |
| `packages/server/src/logging/logger.ts`                   | 51    | JSON line logger, and `describeError`, which leaves query parameters out of logs.                         | clean   | —        |
| `packages/server/src/main.ts`                             | 40    | Node entry point: reads PORT, builds the server, serves, shuts down cleanly on SIGTERM/SIGINT.            | clean   | —        |
| `packages/server/src/port.ts`                             | 15    | Reads and checks PORT (Render's default is 10000).                                                        | clean   | —        |
| `packages/server/src/rate-limit/postgres-rate-limiter.ts` | 74    | Fixed-window counters in one atomic upsert; a random prune that never fails the request.                  | clean   | —        |
| `packages/server/src/rate-limit/rate-limiter.ts`          | 63    | Rate limiter interface, `RateLimitedError` and the rule table.                                            | clean   | —        |
| `packages/server/src/server.ts`                           | 68    | Production wiring: checks settings, opens the Neon pool with an error listener, calls `createApi`.        | clean   | —        |
| `packages/server/src/storage/blob-store.ts`               | 49    | BlobStore interface, upload-order contract and `BlobInUseError`.                                          | minor   | READ-01  |
| `packages/server/src/storage/postgres-blob-store.ts`      | 57    | Blob bytes in `bundle_blobs`: put, get, delete (refuses the current file), orphan sweep.                  | clean   | —        |

## Server: tests (`packages/server/test`)

Route, service and repository tests on an in-process PGlite database.

| File                                           | Lines | What it does                                                                              | Verdict | Findings        |
| ---------------------------------------------- | ----- | ----------------------------------------------------------------------------------------- | ------- | --------------- |
| `packages/server/test/account-routes.test.ts`  | 138   | `DELETE /account` through the API: cascade, auth key needed, other users untouched, 400s. | minor   | DUP-02          |
| `packages/server/test/auth-routes.test.ts`     | 270   | Health, headers, prelogin, register, login and session lifetime through the API.          | clean   | —               |
| `packages/server/test/bundle-routes.test.ts`   | 358   | Bundle routes through the API: access, revisions, checks, list paging, delete, limits.    | clean   | —               |
| `packages/server/test/bundle-service.test.ts`  | 132   | Bundle service: cleanup failure, parallel reads, over-limit sentences.                    | clean   | —               |
| `packages/server/test/crash-logging.test.ts`   | 58    | Pool error listener and `exitOnCrash`.                                                    | clean   | —               |
| `packages/server/test/env.test.ts`             | 51    | Settings checks, and that values are never printed.                                       | clean   | —               |
| `packages/server/test/hosting.test.ts`         | 70    | Client IP headers, IPv6 /64 subjects and PORT parsing.                                    | minor   | READ-02         |
| `packages/server/test/limits-and-logs.test.ts` | 258   | Per-IP and per-account limits, `describeError`, request logs, `createServerFromEnv`.      | minor   | DUP-02, READ-02 |
| `packages/server/test/rate-limiter.test.ts`    | 114   | Postgres rate limiter: counting, windows, reset, pseudonyms, prune and prune failure.     | clean   | —               |
| `packages/server/test/repositories.test.ts`    | 563   | User, session, blob and bundle repositories against PGlite, including limits and cursors. | clean   | —               |
| `packages/server/test/schema.test.ts`          | 226   | Migrations, indexes, storage mode and table constraints.                                  | clean   | —               |
| `packages/server/test/server-keys.test.ts`     | 44    | Auth-key hash and verify, and fake salts.                                                 | clean   | —               |
| `packages/server/test/support/app.ts`          | 62    | Test API on PGlite through `createApi`, with a movable clock and captured logs.           | clean   | —               |
| `packages/server/test/support/database.ts`     | 23    | Fresh PGlite with all migrations.                                                         | clean   | —               |
| `packages/server/test/support/fixtures.ts`     | 152   | Shared test fixtures: bytes, users, registration, bulk setups.                            | clean   | —               |

## Server: migrations and config

SQL migrations (applied by hand), drizzle-kit settings, the env template and package config.

| File                                                           | Lines          | What it does                                                                                 | Verdict | Findings |
| -------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------- | ------- | -------- |
| `packages/server/.env.example`                                 | 10             | Template for the two server settings, with how to generate the secret.                       | clean   | —        |
| `packages/server/drizzle.config.ts`                            | 22             | drizzle-kit config; loads `.env` and asks for a database URL only for commands that connect. | clean   | —        |
| `packages/server/drizzle/0000_init.sql`                        | 59             | First migration: users, sessions, bundles, bundle_blobs with checks and indexes.             | clean   | —        |
| `packages/server/drizzle/0001_ciphertext_storage_external.sql` | 4              | Sets `bundle_blobs.ciphertext` to STORAGE EXTERNAL (no compression).                         | clean   | —        |
| `packages/server/drizzle/0002_drop_revision_blob_key.sql`      | 6              | Drops the old revision-keyed blob columns; sizes must now be at least 1.                     | clean   | —        |
| `packages/server/drizzle/0003_blob_ids.sql`                    | 6              | Random blob ids, `bundles.blob_id` and the same-user foreign key.                            | clean   | —        |
| `packages/server/drizzle/0004_session_last_used_at.sql`        | 1 (no newline) | Adds `sessions.last_used_at` for the idle timeout.                                           | clean   | —        |
| `packages/server/drizzle/0005_rate_limits.sql`                 | 6              | Creates `rate_limits` with its window index.                                                 | clean   | —        |
| `packages/server/drizzle/0006_sessions_expires_at_idx.sql`     | 1 (no newline) | Index on `sessions.expires_at` for the global expired-session prune.                         | clean   | —        |
| `packages/server/drizzle/meta/_journal.json`                   | 54             | drizzle-kit's list of the 7 migrations in order.                                             | clean   | —        |
| `packages/server/package.json`                                 | 34             | Package manifest: source export condition, db scripts, pinned deps.                          | clean   | —        |
| `packages/server/tsconfig.json`                                | 14             | TypeScript project for src, test and drizzle.config, referencing contracts.                  | clean   | —        |

## CI and automation (`.github`)

CI on every push, the release workflow, the weekly drift check and dependency audit, issue templates.

| File                                         | Lines | What it does                                                                                                                                                      | Verdict | Findings |
| -------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| `.github/ISSUE_TEMPLATE/bug_report.yml`      | 61    | Bug report form; sends security reports to private advisories.                                                                                                    | clean   | —        |
| `.github/ISSUE_TEMPLATE/config.yml`          | 8     | Turns off blank issues; links Discussions and private security reports.                                                                                           | clean   | —        |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | 26    | Feature and new-agent request form.                                                                                                                               | clean   | —        |
| `.github/workflows/audit.yml`                | 45    | Weekly (and on change) `pnpm audit --prod` that fails on any advisory.                                                                                            | clean   | —        |
| `.github/workflows/ci.yml`                   | 239   | CI: checks on 3 OSes × 2 Node versions, audit/db:check/coverage/knip in one job, package install + e2e, Linux keychain, two cross-OS e2e chains as separate jobs. | clean   | —        |
| `.github/workflows/drift-check.yml`          | 141   | Weekly comparison of the Claude Code data file with a fresh Claude Code install; files or updates one `drift` issue.                                              | minor   | BUG-02   |
| `.github/workflows/release.yml`              | 193   | Tag release: CI-passed gate, verify on every OS/Node, approval, npm trusted publishing with provenance, `npx` check.                                              | clean   | —        |

## Docs (`docs`)

Architecture, roadmap, the agent guide, the threat model and earlier review reports.

| File                                         | Lines | What it does                                                                                                                                        | Verdict | Findings                |
| -------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------- |
| `docs/ADDING-AN-AGENT.md`                    | 340   | Step-by-step guide to writing a new agent adapter, with sample code against the real helpers.                                                       | clean   | —                       |
| `docs/ARCHITECTURE.md`                       | 843   | How the system works (keys, bundle, commands, adapters, server, CI) and a file-by-file reference.                                                   | minor   | UX-01, READ-01, READ-02 |
| `docs/decisions/0001-libraries.md`           | 69    | Decision record for the crypto, CLI, prompt and keychain libraries.                                                                                 | clean   | —                       |
| `docs/reviews/review-2026-10-03-2.md`        | 143   | Second review pass (SOLID), all findings ticked. Historical record.                                                                                 | clean   | —                       |
| `docs/reviews/review-2026-10-03-3.md`        | 244   | Third review pass, all findings ticked. Historical record.                                                                                          | clean   | —                       |
| `docs/reviews/review-2026-10-03-4/files.md`  | 372   | Review 4 file ledger, with the "after the fixes" note and the list of added/deleted/renamed files (verified against `git diff -M 4c31cf8 e4ca368`). | clean   | —                       |
| `docs/reviews/review-2026-10-03-5/files.md`  | 371   | Review 5 file ledger.                                                                                                                               | clean   | —                       |
| `docs/reviews/review-2026-10-03-4/report.md` | 726   | Review 4 report: 63 findings, all ticked, with the T69 note on SEC-02.                                                                              | clean   | —                       |
| `docs/reviews/review-2026-10-03-5/report.md` | 691   | Review 5 report, all 57 findings ticked.                                                                                                            | clean   | —                       |
| `docs/reviews/review-2026-10-03.md`          | 361   | First review pass, all findings ticked. Historical record.                                                                                          | clean   | —                       |
| `docs/ROADMAP.md`                            | 159   | Stages: v1, more agents, data-only agents, claude.ai items, v2 conversion, later ideas.                                                             | clean   | —                       |
| `docs/security/threat-model.md`              | 153   | Threats, defences, tests, past security findings and accepted risks.                                                                                | minor   | READ-01                 |

## Portfolio entry (`.a1x6`)

Data for the project page on a1x6.dev. Not part of the product.

| File                 | Lines | What it does                                                      | Verdict | Findings |
| -------------------- | ----- | ----------------------------------------------------------------- | ------- | -------- |
| `.a1x6/project.json` | 44    | Portfolio entry for a1x6.dev: title, description, skills, images. | clean   | —        |

## Repo root

Workspace config, lint, format, test and deploy settings, README, license, security and contributing notes.

| File                  | Lines | What it does                                                                                                                 | Verdict | Findings |
| --------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| `.editorconfig`       | 9     | UTF-8, LF, 2-space indentation, final newline for every file.                                                                | clean   | —        |
| `.gitattributes`      | 2     | Stores text files with LF line endings on every OS.                                                                          | clean   | —        |
| `.gitignore`          | 17    | Ignores builds, coverage, env files, release output and brag output.                                                         | clean   | —        |
| `.prettierignore`     | 5     | Keeps Prettier off builds, coverage, the lockfile and Drizzle snapshots.                                                     | clean   | —        |
| `.prettierrc.json`    | 4     | Prettier style: single quotes, width 100.                                                                                    | clean   | —        |
| `CONTRIBUTING.md`     | 144   | Set-up, scripts, code and test rules, PR flow, drift handling and releases.                                                  | clean   | —        |
| `eslint.config.js`    | 100   | Strict type-checked ESLint, Prettier last, and the import-boundary rules (commands vs agents, agent vs agent, pure modules). | minor   | ARCH-01  |
| `knip.json`           | 16    | Unused-code check: extra entry points per workspace, entry exports included.                                                 | clean   | —        |
| `LICENSE`             | 21    | MIT license text.                                                                                                            | clean   | —        |
| `package.json`        | 42    | Root scripts (build, check, test, coverage, e2e, release, knip) and exact dev tool versions.                                 | clean   | —        |
| `pnpm-workspace.yaml` | 14    | Workspace packages, one-day release age, no esbuild build script, esbuild override for drizzle-kit.                          | clean   | —        |
| `README.md`           | 230   | User-facing overview: install, quick start, commands, flags, what is synced, security, roadmap.                              | clean   | —        |
| `render.yaml`         | 42    | Render service for the API: filtered install and build, start, health check, deploy filter, env names.                       | clean   | —        |
| `SECURITY.md`         | 64    | How to report a vulnerability and how data is protected, incl. what the server sees.                                         | minor   | READ-01  |
| `tsconfig.base.json`  | 31    | Shared strict TypeScript settings.                                                                                           | clean   | —        |
| `tsconfig.json`       | 10    | Root project references to the five packages.                                                                                | clean   | —        |
| `vitest.config.ts`    | 30    | One test project per package (server timeouts), coverage settings.                                                           | clean   | —        |
