# Architecture

How agentnomad works, end to end, and what every file is responsible for.

- **Part 1** explains the system: the pieces, the keys, the bundle, what each command does,
  the server, and how it is tested.
- **Part 2** is a file-by-file reference.

New here? Read [The big picture](#1-the-big-picture), then [Push](#push) and [Pull](#pull). To add
an agent, see [ADDING-AN-AGENT.md](ADDING-AN-AGENT.md). Security details are in
[security/threat-model.md](security/threat-model.md).

## Contents

- [Part 1 · How the system works](#part-1--how-the-system-works)
  - [1. The big picture](#1-the-big-picture)
  - [2. Packages and how they depend on each other](#2-packages-and-how-they-depend-on-each-other)
  - [3. Keys and encryption](#3-keys-and-encryption)
  - [4. The bundle](#4-the-bundle)
  - [5. What each command does](#5-what-each-command-does)
  - [6. Agent adapters](#6-agent-adapters)
  - [7. The Claude Code adapter](#7-the-claude-code-adapter)
  - [8. The server](#8-the-server)
  - [9. What the CLI keeps on a PC](#9-what-the-cli-keeps-on-a-pc)
  - [10. Running from scripts and CI](#10-running-from-scripts-and-ci)
  - [11. Tests, CI and deployment](#11-tests-ci-and-deployment)
  - [12. Design rules](#12-design-rules)
- [Part 2 · File reference](#part-2--file-reference)

---

# Part 1 · How the system works

## 1. The big picture

agentnomad copies an AI coding agent's setup (settings, instructions, skills, subagents,
commands, hooks, MCP servers, plugins, optional memory) from one PC to another, through a
server that can never read it.

```mermaid
flowchart LR
  subgraph PCA["PC A (e.g. macOS)"]
    A1["~/.claude and project files"] --> A2["collect"]
    A2 --> A3["make paths portable<br/>({{HOME}})"]
    A3 --> A4["compress + encrypt<br/>(data key)"]
  end
  subgraph Server["agentnomad API (Render + Neon)"]
    S1[("bundles: ciphertext<br/>+ metadata only")]
  end
  subgraph PCB["PC B (e.g. Windows)"]
    B1["decrypt + decompress"] --> B2["check: agent, scope,<br/>revision"]
    B2 --> B3["review commands<br/>that run programs"]
    B3 --> B4["restore with this PC's<br/>paths, merge or overwrite"]
    B4 --> B5["reinstall plugins,<br/>offer programs, env values"]
  end
  A4 -- "HTTPS, ciphertext only" --> S1
  S1 -- "ciphertext" --> B1
```

The rules that shape everything else:

1. **Encryption happens on the PC.** The server stores ciphertext and a little metadata. It
   never sees a file, a project name, a password or a key that could open them.
2. **One password, any PC.** Logging in on a new PC with the same password unlocks
   everything; there is no password recovery, because recovery would mean the server could
   open the data.
3. **One bundle per agent and scope.** A "scope" is the agent's global setup, or one
   project. Each is saved, versioned and restored on its own.
4. **Agents are plug-ins.** Everything agent-specific lives in an adapter. Push, pull,
   encryption and the server do not know what Claude Code is.
5. **Nothing runs without being shown.** Anything restored that runs programs (hooks, the
   status line, MCP servers, the scripts they run, plugins, npm packages) is listed and
   asked about first.

## 2. Packages and how they depend on each other

A pnpm monorepo of five TypeScript packages (strict mode, ES modules, Node 22.13 or newer).

```mermaid
flowchart TD
  contracts["@agentnomad/contracts<br/>Zod schemas and types:<br/>the one source of truth"]
  core["@agentnomad/core<br/>bundles, crypto, merging, paths<br/>(no disk, network or terminal)"]
  cli["@agentnomad/cli<br/>commands, prompts, files,<br/>API client, agent adapters"]
  server["@agentnomad/server<br/>Hono API + Postgres"]
  e2e["@agentnomad/e2e<br/>end-to-end tests (not shipped)"]
  core --> contracts
  cli --> core
  cli --> contracts
  server --> contracts
  e2e --> cli
  e2e --> server
```

| Package     | Responsibility                                                                                                                                                                                                               | Talks to               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `contracts` | Every shape that crosses a boundary: API requests and responses, the bundle format, limits, error codes. Validated at runtime with Zod on both sides.                                                                        | nothing                |
| `core`      | Pure logic: key derivation, encryption envelopes, the bundle codec, project-name hashing, path portability, merge strategies. Takes everything it needs as arguments (OS, home folder), so every OS can be tested on any OS. | nothing (no Node APIs) |
| `cli`       | The `agentnomad` command. Reads and writes files, asks questions, keeps secrets in the OS keychain, calls the API, and holds the agent adapters.                                                                             | the API over HTTPS     |
| `server`    | The API: accounts, sessions, encrypted bundles, rate limits. Knows nothing about agents or files.                                                                                                                            | Postgres (Neon)        |
| `e2e`       | Runs the built CLI as a script against a local copy of the API, across operating systems.                                                                                                                                    | local only             |

The server and the CLI never import each other; they only share `contracts`. So a change to
the API shape is a change in one place, checked on both sides.

**Strict on what is sent, tolerant on what is received (T57).** The server deploys from
`main` within minutes; installed CLIs update when their users choose. So the server parses
requests with strict schemas (an unknown field is refused) and is typed against strict
answer schemas, while the CLI reads answers with `ClientAnswerSchemas` (`api/answers.ts`):
the same field definitions, but an unknown field is dropped instead of refused, and any
error code is accepted. A known code works as before; an unknown one becomes an `ApiError`
with code `unknown` that shows the server's message. A missing or wrongly typed known field
is still refused, and every bound stays (KDF settings, sizes, revisions). This only helps
CLIs released after 1.0.3: 1.0.3 and older still refuse any new field or code, so the server must
not send one until they are gone (`routes/bundles.ts` and `WRONG_PASSWORD_MESSAGE` work
around them today). Every request carries the CLI version in `x-an-client`, which the
server logs, so it can later tell old CLIs to update.

## 3. Keys and encryption

```mermaid
flowchart TD
  P["password (typed, never stored or sent)"] --> KDF["Argon2id<br/>64 MiB, 3 passes, per-user random salt"]
  S["salt (from the server at prelogin)"] --> KDF
  KDF --> M["master key"]
  M --> AK["auth key<br/>(sent at login, proves the password)"]
  M --> PK["password key<br/>(never leaves the PC)"]
  DK["data key<br/>(32 random bytes, made at register)"] --> W["wrapped data key<br/>(XChaCha20-Poly1305 under the password key)"]
  PK --> W
  W --> SRV[("server stores the wrapped data key")]
  DK --> B["every bundle<br/>(XChaCha20-Poly1305)"]
  DK --> SK["scope keys<br/>(keyed BLAKE2b of project names)"]
  DK --> NE["encrypted project names"]
  AK --> H["server stores HMAC-SHA256(SERVER_SECRET, auth key)"]
```

- **Register:** the CLI makes a random salt and a random **data key**, derives the master
  key from the password with Argon2id, splits it into an **auth key** and a **password
  key**, wraps the data key with the password key, and sends the username, salt, Argon2id
  settings, auth key and wrapped data key. The server stores a keyed hash of the auth key.
- **Login on any PC:** prelogin returns the salt and settings; the same password gives the
  same keys; the server checks the auth key and returns the wrapped data key, which only
  the password key can open. The data key and a session token are then kept in the OS
  keychain.
- **Why two keys:** changing the password only re-wraps the small data key; bundles never
  need re-encrypting.
- **Bundles** are sealed with XChaCha20-Poly1305 (a fresh random 24-byte nonce each time).
  The associated data binds the format version, the agent and the scope key, so a bundle
  served under another agent or scope fails to open.
- **Project names** never reach the server readable: the server sees a scope key (a keyed
  hash, the same on every PC) and an encrypted name only the user's PCs can read.
- **Key formats are versioned.** Labels such as `agentnomad/scope-key/v1` and the KDF
  context are part of the stored format and never change in place; a new scheme is added
  next to the old one.

The server has its own secret, `SERVER_SECRET`, which keys the auth-key hashes, the fake
salts returned for unknown usernames, and the pseudonyms in rate-limit rows. It lives only
in the host's settings, never in the database.

## 4. The bundle

A bundle is one agent's setup for one scope, as plain data before encryption:

| Field           | Meaning                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `formatVersion` | `1`. Readers refuse any other version.                                                                          |
| `agent`         | e.g. `claude-code`.                                                                                             |
| `scope`         | `{ kind: 'global' }` or `{ kind: 'project', name }`.                                                            |
| `sourceOs`      | `darwin`, `linux` or `win32`: where it was saved, to flag hooks that only run there.                            |
| `agentVersion`  | e.g. Claude Code `2.1.282`; pull warns when this PC runs an older one.                                          |
| `revision`      | The revision this copy is saved as, sealed inside so a server cannot pass an older copy off as the current one. |
| `files`         | Every file: a relative forward-slash path, `executable`, and content as UTF-8 text or base64.                   |

**Portable paths.** In text files, the user's home folder is replaced by `{{HOME}}` on push
(a `{{HOME}}` already written in a file is stored as `{{HOME\}}` and comes back unchanged)
and by the other PC's home on pull (with backslashes in `.bat` and `.cmd` files on Windows), so `C:\Users\ana\.claude\hooks\check.sh` in a hook
becomes `/Users/ana/.claude/hooks/check.sh` on a Mac. Paths inside the bundle are relative
to the agent's base folder (global) or the project root (project), never absolute and never
with `..`.

**Reserved entries.** Things that are not plain files of the agent's folder live under
`.agentnomad/` in the bundle (`RESERVED_DIR` in `agents/adapter.ts`, one name for every
agent and the generic code):

| Entry                            | What it holds                                                                                   | On pull                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `.agentnomad/claude.json`        | Selected `~/.claude.json` keys: MCP servers and documented preferences                          | Merged in by key; the file's login and project state are never touched                                            |
| `.agentnomad/home/...`           | Scripts the hooks or status line run from elsewhere in the home folder, and known tool settings | Written back to the home folder, only if the setup's own hooks run them                                           |
| `.agentnomad/auto-memory/...`    | The project's auto memory (opt-in)                                                              | Written to this PC's memory folder for the project                                                                |
| `.agentnomad/plugins.json`       | Installed plugins and their marketplaces                                                        | Plugins are reinstalled with `claude plugin`, never copied                                                        |
| `.agentnomad/programs.json`      | Programs hooks start, and how npm installed them                                                | Missing ones are offered for install                                                                              |
| `.agentnomad/env.json`           | Environment variable values the user chose to save                                              | Offered for the shell profile; never written as a file                                                            |
| `.agentnomad/account-skills/...` | A copy of the user's own claude.ai skills (opt-in; never Anthropic's or an organization's)      | Offered as local skills in `~/.claude/skills/<name>/`, only on a PC that does not already get them from claude.ai |

**From bundle to bytes:** JSON → gzip → XChaCha20-Poly1305 → upload. The encrypted size is
capped at 5 MB; decompression stops at 64 MB (a guard against decompression bombs); the
result is schema-checked before anything is written.

## 5. What each command does

### Register and login

```mermaid
sequenceDiagram
  participant U as User
  participant C as CLI
  participant S as Server
  U->>C: agentnomad register
  C->>U: username, "no recovery" warning, password (checked for strength)
  C->>C: salt + data key (random), Argon2id → auth key + password key
  C->>S: POST /auth/register (username, salt, settings, auth key, wrapped data key)
  S-->>C: session token
  C->>C: keychain ← session token + data key
  Note over U,S: Later, on another PC
  U->>C: agentnomad login
  C->>S: POST /auth/prelogin (username)
  S-->>C: salt + Argon2id settings (a stable fake for unknown names)
  C->>C: Argon2id → auth key + password key
  C->>S: POST /auth/login (username, auth key)
  S-->>C: session token + wrapped data key
  C->>C: unwrap data key, keychain ← both
```

`logout` ends the session on the server and always forgets it on the PC, even offline. When
the server answers but does not end it (a rate limit, a server error), the warning gives the
server's reason instead of "Could not reach the server".

A login or register on a PC that already holds a login asks first (`--yes` answers yes), then
keeps the current login until the new one works: only when the new session and data key are
in hand is the old session ended and the new one saved (UX-01). A wrong password, a taken
username, a "no" or Ctrl+C before that leaves the current login as it was.

When login succeeds on the server but the data key does not unwrap with this password, the
new session is never saved on the PC: login sends `POST /auth/logout` once with that session's
own token from the login answer (not the keychain), then shows "Logged in, but your data key
could not be unlocked with this password." Best effort (T66): a failed or timed-out logout is
not retried and never replaces that error; the session then ends by itself on the server.

### Push

1. Detect installed agents; choose agents and scopes (or take `--agent`, `--global`,
   `--project`).
2. A project is named once per folder (remembered in local state). The home folder and the
   agent's own folder (`~/.claude`) are never a project, in push or pull: their `.claude/` is
   the global setup. They are not offered, and `--project` there stops with a message to run
   the command from the project's folder (`cli/project-folder.ts`).
3. Choose whether to include memory (`--memory` / `--no-memory`).
4. Show organization-managed settings and files the adapter does not know yet.
5. The adapter **collects** the files; the user may add saved environment values. Links
   into folders for keys, links out of a project and files over 10 MB are left out, and push
   says so.
6. Compare each setup's revision on the server with the one this PC last knew. If another
   PC saved a newer copy (or deleted it), the user is asked whether to replace it (with
   `--yes`: never). If this PC's last pull of a setup left out commands the user declined,
   pushing it would drop them for every PC: push asks first, and `--yes` skips it with a note.
7. Paths are made portable, the bundle is built, compressed and **encrypted for the exact
   revision it will become** (the one on the server, plus one).
8. Upload with that expected revision, and remember the new revision for this PC. If another
   PC saved in the meantime, the server refuses (`revision_conflict`) and the setup is
   skipped, never replaced unasked.

Push is split in two (T59): a **plan** step does steps 1 to 6 and asks every question, and an
**apply** step does 7 and 8. The apply step is given no prompter at all, so it cannot ask.

### Pull

```mermaid
flowchart TD
  L["list saved setups<br/>(names decrypted on this PC)"] --> C["choose agents and scopes"]
  C --> D["download, decrypt, schema-check"]
  D --> V{"agent, scope and<br/>sealed revision match?"}
  V -- no --> X["refuse: nothing written"]
  V -- yes --> O{"older than what<br/>this PC had?"}
  O -- yes --> Q["warn and ask<br/>(--yes: skip)"]
  O -- no --> R
  Q -- restore anyway --> R["review new or changed<br/>hooks, status line, MCP servers<br/>and the scripts they run"]
  R --> W["restore: identical files untouched,<br/>different ones merge / overwrite (backup) / skip"]
  W --> S["add the chosen env values,<br/>remember revision and project name"]
  S --> A["after restore: plugins,<br/>missing programs, account skills"]
```

Pull is split like push (T59). The **plan** step lists, downloads and checks every chosen
setup and asks every question before anything is written: an older copy, new commands, each
file here that differs (`~/.claude.json` whenever the setup has it) and missing environment
values, then each agent's own questions (T61): for Claude Code, closing Claude Code when
`~/.claude.json` would change, then plugins, programs and claude.ai skills. Without a
terminal, an open question stops pull here, before any file changes. The **apply** step
writes with those answers and has no prompter, nor does the agent's follow-up it runs last
(plugin and program installs, adding the skills); a file only the restorer finds different,
which the plan never asked about, is left as it is and the setup counts as not done.

- Files that only differ in how the home path is written (`C:/` vs `C:\`) are left as they
  are.
- Pull never deletes files.
- `--merge` and `--overwrite` answer every file at once; JSON merges by key (the incoming
  side wins), other text files are kept and the incoming copy is saved next to them. A JSON
  file holding a number JSON cannot keep (past the safe integer range, or too large for a
  double, such as `1e400`) is kept side by side too.
- `--yes` never accepts new commands, plugin reinstalls or npm installs; `--allow-commands`
  does.

### The other commands

| Command          | What it does                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`           | Every saved setup, grouped by agent, with revision, size and age. Project names are decrypted on this PC.                                                                       |
| `status`         | For each saved setup: up to date, newer on the server, never pulled here, or deleted on the server. Uses only the revisions this PC remembers; downloads nothing.               |
| `delete`         | Deletes saved setups from the server after confirming; files on the PC are untouched.                                                                                           |
| `account delete` | Deletes the account and every setup. Always needs the username and the password (the server checks the auth key), so a stolen session cannot do it.                             |
| `agents`         | Supported agents, whether each is installed here, its version and folder, and organization-managed settings.                                                                    |
| `env`            | Which environment variables this PC's setups use and whether each is set here (the home folder and the agent's own folder count as the global setup only). Never shows a value. |

## 6. Agent adapters

Everything agent-specific sits behind one interface, `AgentAdapter`
(`packages/cli/src/agents/adapter.ts`):

| Part                           | Question it answers                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detector`                     | Is the agent installed here? Where is its base folder? Which version?                                                                                                                                                                                                                                                  |
| `collector`                    | Which files make up the global setup, or a project's setup? (Never credentials or machine state.)                                                                                                                                                                                                                      |
| `restorer`                     | Write a pulled setup back: where each file goes, what is refused, per-OS line endings and permissions, conflicts. Also what pull's plan must ask first: what runs programs (`reviewRunnable`), which files differ (`conflicts`), which saved variables redirect requests (`isRedirectVariable`). It never asks itself. |
| `inspector` (optional)         | What should the user be told on push, pull or `agents` (managed settings, files this version does not know yet, a setup saved with a newer version)?                                                                                                                                                                   |
| `optionalParts` (optional)     | What push saves only after a yes, e.g. Claude Code's claude.ai skills; `--<id>` / `--no-<id>` answer it in push and pull, built from the registered adapters with the part's `flagHelp`.                                                                                                                               |
| `envReferences` (optional)     | Which files can use `${VAR}` (MCP servers, settings) and which variables the agent sets itself; push offers the values, `agentnomad env` lists them.                                                                                                                                                                   |
| `memoryDescription` (optional) | What push's memory question names.                                                                                                                                                                                                                                                                                     |
| `planRestore` (optional)       | The agent's own questions in pull's plan step; returns how to write the setup and a follow-up (e.g. plugin reinstalls) that gets no prompter.                                                                                                                                                                          |

Adapters are registered in one place, `createAppRegistry` in `packages/cli/src/app.ts`,
through `createAgentRegistry`. Push, pull, `list`, `status`, `delete` and `agents` only use
the registry and these interfaces, so a new agent is a new folder plus one line there. See
[ADDING-AN-AGENT.md](ADDING-AN-AGENT.md). A lint rule (`no-restricted-imports` in
`eslint.config.js`) keeps every generic folder (`push/`, `pull/`, `cli/`, `env/`, `commands/` and the
folders they build on, such as `api/`, `state/` and `ui/`) from importing any adapter's
folder and an adapter's folder from importing another's (what adapters share is in
`agents/shared/`), and `test/agent-boundary.test.ts` runs a second, made-up agent through push and pull (T61).

Data is stored per agent (`agent` is part of every bundle's key), so adding an agent never
touches anyone's existing saves.

## 7. The Claude Code adapter

Base folder: `~/.claude`, or `CLAUDE_CONFIG_DIR` when set.

**Detection.** Installed when the `claude` command is found (PATH, PATHEXT on Windows,
`~/.local/bin` from the native installer) or the base folder exists. The version comes from
`claude --version` (no shell, 5-second limit).

**What is saved.** Every list lives in one data file,
`claude-code-paths.data.ts`, checked against a schema when loaded, so a new Claude Code
file is a one-line change there:

| Scope               | Saved                                                                                                                                                                           | Never saved                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global `~/.claude/` | `settings.json`, `CLAUDE.md`, `keybindings.json`, `rules/`, `skills/`, `commands/`, `agents/`, `workflows/`, `output-styles/`, `themes/`, scripts hooks and the status line run | `.credentials.json`, history, transcripts, sessions, caches, backups, plugin caches, `settings.local.json`, `skills/synced/` (synced by claude.ai) |
| `~/.claude.json`    | Only `mcpServers` and documented preference keys                                                                                                                                | Login, projects, usage and onboarding state                                                                                                        |
| Project root        | `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.mcp.json`, `.worktreeinclude`, scripts the project's hooks run                                                                   | Everything else, including app code, `.env` and `.git`                                                                                             |
| Project `.claude/`  | `settings.json`, `settings.local.json`, `CLAUDE.md`, and the same folders as global                                                                                             | `agent-memory-local/`, `worktrees/`                                                                                                                |
| Opt-in              | Subagent memory, auto memory                                                                                                                                                    |                                                                                                                                                    |

The scripts hooks and the status line run are found in the words each program gets
(`settings-commands.ts`, one reading for push, pull and the review): a hook in exec form
(`args` set) passes each `args` element as one word, spaces and all; a shell-form command is
split like a shell, and a word that carries a command line (`bash -c "a.sh; true"`,
`pwsh -Command "& 'a.ps1'"`) is split again, at any depth, also on shell operators (`a.sh;`,
`a.sh&&b`). The review shows an exec-form hook with each `args` element quoted and compares
it by its words, so a text moved between one argument and a shell command line is shown as
new. The "will likely not run here" warning for a setup from another OS looks only at a
command's program and the scripts it runs, and shows the command as written.

**Restore rules** (`restore-rules.ts`): a file is written only if a collector could have
produced it. A home-folder file must be a known tool's settings or a script the setup's
own hooks or status line run, and never in a folder whose files run by themselves (Startup,
`.config/autostart`, `Library/LaunchAgents`, fish and PowerShell profile folders), so a
bundle cannot drop a file that runs by itself. The same holds in Claude Code's own folder: a
script outside the synced folders is written only when the setup's hooks or status line run
it, and never in Claude Code's own state (`knownState`: `chrome/`, `local/`, `state/`, …),
which is refused like never-synced entries (T55). Refusals ignore case. On Windows, names with
`:`, device names, trailing dots and 8.3 short names (`PROGRA~1`; a name too long for the
8.3 form, like `release-notes~3.md`, is allowed) are refused. Two entries that differ
only in case or Unicode form are one file on Windows and macOS: only the first is written. An
entry that cannot be written is skipped with a warning; the rest continue. `~/.claude.json`
is only ever merged, with a backup: only `mcpServers` and the preference keys, never
`projects` or account state. It is skipped while Claude Code is running (it rewrites the file
while open): pull's plan step asks to close it ("I closed it, continue" checks again,
"Skip ~/.claude.json this time" leaves it with a warning; `--yes` never waits), and the
restorer checks once more right before writing and leaves the file if it is open again. It is
read again at that point, as Claude Code saves it while closing. Running means a `claude` program
(also under a folder with a space; npm's package now ships it as a native `claude.exe`, checked
with a real install on Windows), an interpreter or launcher such as `node`, `bun`, `sh` or `env`
running Claude Code's script (npm's fallback, as `node /usr/local/bin/claude`; an argument
naming them does not count; command lines on Windows are read through PowerShell, else
`tasklist` names), or the Claude app, whose Code tab runs Claude Code and shares
`~/.claude.json`. Auto memory is Markdown only, and
a folder chosen by the project's `autoMemoryDirectory` is used only inside the home folder
and outside refused folders (`auto-memory.ts`).

**Review of runnable things** (`command-review.ts`): everything Claude Code's docs say it
runs, when new or changed compared with this PC, is listed before anything is written: hooks
(commands, and `http` hooks that send data to an address), the status line, settings that
run a command (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`,
`otelHeadersHelper`, `fileSuggestion`), loader variables in a settings `env` block
(`NODE_OPTIONS`, `LD_PRELOAD`, …) and `env` names that redirect Claude Code
(`ANTHROPIC_BASE_URL` and the other endpoints, proxies, `NODE_EXTRA_CA_CERTS`, its shell
variables, OpenTelemetry endpoints, `PATH`), a `permissions.defaultMode` that lets Claude act
without asking (`bypassPermissions` and `auto` in global settings, where alone Claude Code
takes them; `acceptEdits` from any settings file),
`permissions.allow` rules and `permissions.additionalDirectories` new on this PC, a new or
changed `sandbox` block, `enableAllProjectMcpServers`, MCP servers (the whole definition is
compared, so a new `env` or `headersHelper` shows), files that commands here or in the bundle
run (matched by path, also inside a quoted command line or next to shell punctuation; any
file that can run: a script extension, no extension, the executable bit or a `#!` line) and the scripts next to them, known tool settings (ccstatusline), and skill, command and subagent files with
commands that run by themselves (`runnable-markdown.ts`: a `` !`command` `` placeholder, a
` ```! ` block at any indentation, as in a list item, or inside another open block, since
the docs do not say Claude Code skips it there; frontmatter `hooks`; a fence closes only on
the same character, at least as long). Commands written as instructions are never flagged. Hooks and MCP servers are read
one by one: one that cannot be read is shown as unreadable (its JSON), never left out, and
hides no other.
The keys and names come from `reviewed-settings.ts`, each checked against Claude Code's
settings reference. Declining skips the files that hold them. Saved environment values that make programs load
code, or send programs' requests elsewhere (the redirect names above, such as `HTTPS_PROXY`
and `ANTHROPIC_BASE_URL`), need their own yes, and `--yes` alone never adds them. A saved
value already in agentnomad's block of the shell profile (on Windows: a user variable with
that value) counts as set, even in a terminal opened before it was added, so pulling again
asks nothing; a block that would not change is neither backed up nor written (T56). Everything printed from a bundle
or the server goes through `printable`, so escape sequences are shown, never acted on; the
label and command of each review entry go through `printableLine`, which also shows line
breaks and tabs as `\u{…}`, so a command cannot add lines that look like more entries (SEC-03).

**claude.ai skills (T42, opt-in):** Claude Code downloads the skills of the user's claude.ai
account into `skills/synced/<account>/` and manages that folder; agentnomad never writes
there. `push --account-skills` saves a copy of the user's **own** ones (the folder's
`manifest.json` says `creatorType: user`; Anthropic's and an organization's are never
saved) under `.agentnomad/account-skills/`. On pull they are listed and, after a yes (or
`--account-skills`), written as normal local skills in `~/.claude/skills/<name>/`, skipping
any this PC already gets from claude.ai and never replacing a local skill. A local skill
runs its `!`command`` lines where a synced one does not, so such skills are marked, and a
flag alone adds them only with `--allow-commands`.

**After restore:** plugins are reinstalled with Claude Code's own `claude plugin
marketplace add` and `claude plugin install` (on Windows a `.cmd` launcher runs through
`cmd.exe` with one verbatim line: an argument with a space, like a local marketplace folder,
is quoted; one with `"&|<>^%!`, other white space or control characters is refused); a
plugin built by running a command gets its own question; programs that hooks start and npm installed are offered with
`npm install -g name@version` (the package is the one the launcher runs: its link on macOS
and Linux, its `.cmd` on Windows, so `tsc` from `typescript` and scoped packages count).

**Keeping up with Claude Code:** files Claude Code adds that the data file does not know
are reported on push (a folder holding a script the hooks or status line run is not: push saves
that script); the Claude Code version is stamped in every bundle; and a weekly
drift check (`.github/workflows/drift-check.yml`) compares the data file with the newest
Claude Code. It reads the official
[.claude directory docs](https://code.claude.com/docs/en/claude-directory), runs a fresh
Claude Code in an empty folder to see what it creates, and collects the changelog entries
about files and setup, or naming a settings key the pull review watches
(`reviewed-settings.ts`), since the data file's `reviewedVersion`. Anything new goes into one
open GitHub issue labelled `drift`; the fresh install runs with no write permissions.

## 8. The server

A [Hono](https://hono.dev) app on Node, deployed on Render from `main`, with Neon Postgres
through Drizzle.

| Route                              | Needs              | Does                                                                              |
| ---------------------------------- | ------------------ | --------------------------------------------------------------------------------- |
| `GET /health`                      | –                  | Liveness (also wakes the free host).                                              |
| `POST /auth/prelogin`              | –                  | Salt and Argon2id settings; a stable fake for unknown names.                      |
| `POST /auth/register`              | –                  | Creates the account and a session.                                                |
| `POST /auth/login`                 | –                  | Checks the auth key; returns a session and the wrapped data key.                  |
| `POST /auth/logout`                | session            | Ends this session.                                                                |
| `GET /bundles`                     | session            | This user's saved setups (metadata only), newest first, cursor-paginated.         |
| `GET /bundles/:agent/:scopeKey`    | session            | The encrypted bytes, with revision and SHA-256 in headers.                        |
| `PUT /bundles/:agent/:scopeKey`    | session            | Saves a new revision if `expectedRevision` matches; else `409 revision_conflict`. |
| `DELETE /bundles/:agent/:scopeKey` | session            | Deletes one saved setup.                                                          |
| `DELETE /account`                  | session + auth key | Deletes the account; sessions, setups and files go with it.                       |

**Layers:** routes (validation with the contracts, errors, limits) → services
(`auth-service`, `bundle-service`: the rules, free of HTTP) → repositories and the blob
store (Postgres). `createApi` (`api.ts`) wires them from a database and is the only wiring:
production, the server tests and the e2e local server all use it. `server.ts` reads the
environment settings, opens the Neon pool and calls it; it refuses to start if
`DATABASE_URL` or `SERVER_SECRET` is missing or weak.

**Tables:** `users`, `sessions` (token hashes only), `bundles` (metadata: agent, scope key,
encrypted name, revision, size, hash, pointer to the current file), `bundle_blobs`
(ciphertext, a random id per upload), `rate_limits` (fixed-window counters, keyed by
pseudonyms). Keeping bytes apart from metadata means `list` never reads ciphertext. A new
upload is stored first, then the revision check switches the pointer, then the old file is
deleted, so two PCs saving at once can never overwrite or delete each other's file.

**Limits and logs:** 30 auth requests per minute per IP, 5 registrations per hour per IP
(an IPv6 address counts by its /64), 10 failed logins per account and 10 wrong-password
account deletes per account per 15 minutes (counted before the check, so parallel guesses
cannot slip past), 120 saves and deletes and 600 downloads per account per hour (the list of
setups has no limit); `429` with `Retry-After`.
Each account keeps at most 100 setups and 50 MB of encrypted bytes (checked before storing
anything and again inside the save's transaction, with the user row locked, both with one
rule, `storageLimitPassed`); over it,
`413 payload_too_large` says which limit. The visitor's IP is Cloudflare's
`CF-Connecting-IP` (`True-Client-IP` when that is missing). About one save in 50 also deletes
files no setup points to that are over an hour old, and about one rate-limited request in 100 prunes old counters and every user's expired sessions; a failed sweep or prune is logged and never fails the request. Register writes the account and its first session in one transaction. Logs are one JSON line per request with
a request id and the CLI version from `x-an-client` (`invalid` when it does not look like a
version; absent for 1.0.3 and older), never other headers, bodies or query strings; a failed query logs its SQL text, never
its parameters. There are no CORS headers and no cookies.

## 9. What the CLI keeps on a PC

| What                         | Where                                                                                                                                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session token and data key   | OS keychain: Windows Credential Manager, macOS Keychain, Linux Secret Service. Service `agentnomad`, account `<secret>@<server host>`                             | So later commands work without the password; one entry per server                                                                                                                                                                                                                                                                                                                                                                                                       |
| The same, without a keychain | `%APPDATA%\agentnomad\secrets.json` or `~/.config/agentnomad/secrets.json`, readable only by the user (600 in a 700 folder; on Windows an ACL for this user only) | Servers, WSL, SSH sessions; the CLI says when it is used. A login saved there while the keychain failed is moved into it once it works again, also over an older login still in the keychain, whose session is then ended (BUG-04)                                                                                                                                                                                                                                      |
| Local state                  | `state.json` in the same folder                                                                                                                                   | Which name each project folder was saved under, and the last revision this PC pushed or pulled of each setup (for conflicts, `status` and rollback checks), and the account those revisions belong to: a login or register as another account clears them and keeps the project names (T56). Only a missing file counts as empty; one that cannot be read stops the command. Two commands running at once are not serialized: the last write wins (rare, so not locked) |

`AGENTNOMAD_API_URL` points the CLI at another server (https, or http for localhost).

## 10. Running from scripts and CI

When stdin or stdout is not a terminal, the CLI swaps its prompter for one that never asks:
any question the flags leave open stops the command with exit code 1 and names the flags to
add. Push and pull ask every question in their plan step, before they change anything: pull
downloads and reviews every setup and asks about files that differ and missing environment
values first; push collects every setup and compares revisions with the server first. Every
command can be scripted:

```sh
echo "$PASSWORD" | agentnomad login --username me --password-stdin
agentnomad push --global --project my-app --memory --yes
agentnomad pull --global --yes --allow-commands
```

Exit codes: `0` done, `1` failed or an answer was needed, `130` cancelled. Warnings and
errors go to stderr. Passwords are read only from stdin, never from an argument.

Push and pull also exit with `1` when any setup was **not done**: skipped or refused without
the user answering no themselves. That is a newer copy on the server or one deleted there
(push), a setup whose last pull left out declined commands (push), a setup over the 5 MB limit
(push), an older copy than this PC had (pull), and a file that differs but was never asked
about (pull). Every other setup is still saved or restored first, then one message lists what
was not done. A setup the user skipped by answering a question with no is their choice and
exits with `0`; the same skip made by `--yes` exits with `1`. Parts of a setup that are left
out on purpose (declined commands, `~/.claude.json` while Claude Code runs) do not change the
exit code; they are warned about.

## 11. Tests, CI and deployment

| Layer                | What it covers                                                                                                                                                                                                                                                                                      | Where                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Unit and integration | Every package: schemas, crypto vectors, codec limits, path portability on every OS, merge strategies, adapters against real temp folders, commands with fake servers, the API against PGlite                                                                                                        | `packages/*/test` (Vitest) |
| End to end           | The built CLI, run with no terminal, against the real API code on a local PGlite database: three PCs in sequence (register and push; pull with merge, edit, push; pull with overwrite, stale PC, delete, account delete). Every request is recorded and checked: nothing readable may leave the PC. | `packages/e2e`             |
| Cross-OS             | The same three steps on different machines, the database handed over as an artifact: macOS → Windows → macOS and Linux → Windows → Linux                                                                                                                                                            | `.github/workflows/ci.yml` |

CI runs `pnpm check` (typecheck, lint, format, tests) on macOS, Linux and Windows with
Node 22.13 and 24, the real OS keychain on every OS (the test runs only where
`AGENTNOMAD_TEST_REAL_KEYCHAIN=1`, so `pnpm test` on a developer's PC leaves the keychain
alone), the real Linux keychain (GNOME Keyring), and the two cross-OS chains,
each chain in its own jobs, so a failure in one does not skip the other's later steps.
On every OS and Node version it also builds the npm package, installs it globally, and runs
the e2e steps with the installed `agentnomad` command. One job (Linux, Node 24) also runs
`pnpm audit --prod` (known advisories in the packages users install) and
`pnpm --filter @agentnomad/server db:check` (`drizzle-kit check`: the migrations agree with
each other; offline, no database or secret). `.github/workflows/audit.yml` runs the same
audit every Wednesday, so a new advisory is noticed without a push. The same job runs
`pnpm knip` (unused files, dependencies and exports, set up in `knip.json`;
`includeEntryExports` is on, so an export only re-exported by an `index.ts` and used nowhere
is still reported), and any finding fails the build (T65): a name used only in its own file
is not exported, and the few exports kept for other code to use are tagged `@public` in their
JSDoc (the adapter interface `AgentInspector`, the crypto interfaces `PasswordKdf` and
`RandomSource`, and two wire types in `contracts`). In that job the tests run once, with
coverage, in place of `pnpm check`'s plain run: `pnpm test:coverage` (Vitest with V8
coverage of `packages/*/src`; a summary in the log, the full report as the `coverage`
artifact; a failing test fails the build, there is no coverage threshold yet). `pnpm test`
does not collect coverage. A newer push cancels a branch's older run, except on `main` and
`dev`, where every commit keeps its run for the release gate and Render.
Actions are pinned by commit.

**The npm package.** `packages/cli/scripts/build-release.ts` bundles our own code (cli,
core, contracts) into one readable file with esbuild and writes `packages/cli/release/`:
that file, a `package.json` naming every library as a normal dependency, an
`npm-shrinkwrap.json` fixing every indirect version too (so users install the tree the release
tested), the README and
the license. The build fails if anything but our own source is bundled or a library is
not declared. **Releases:** pushing a tag `vX.Y.Z` on `main` runs
`.github/workflows/release.yml`: build and test on every OS, install and run the packed
package, wait for the owner's approval, publish the tested tarball through npm trusted
publishing with provenance (no npm token exists), then check `npx agentnomad` on every OS. The release starts only for a commit
with a successful CI run (on any branch) that is also on `main`, and verifies on Node 22.13 and 24.

Deployment: Render builds `main` from `render.yaml` after CI, installing and compiling only
the server and `contracts` (`--filter @agentnomad/server...`, `tsc --build packages/server`); database migrations
(`packages/server/drizzle`) are run by hand with the direct connection string, and the API
only gets the pooled one.

## 12. Design rules

- **Single responsibility, injected dependencies.** Services receive repositories, clients,
  clocks and prompters; composition roots (`cli/src/app.ts`, `server/src/api.ts`) build
  the real ones. Everything is testable without a network, a terminal or a keychain.
- **Contracts at every boundary.** API bodies, headers, the bundle, files read back from
  disk (`programs.json`, `plugins.json`, the env section) are all parsed with Zod.
  `programs.json` and `plugins.json` are checked entry by entry with the schemas push also
  checks before saving; pull names an entry it refuses, or a file it cannot read, and still
  offers the rest. `system/json.ts` (`parseJsonWith`) returns why a file could not be read.
- **Open for extension.** New agents, merge strategies, storage (Postgres → R2) or rate
  limiters plug in behind interfaces; nothing existing changes.
- **Formats never change in place.** Bundle format, key labels and hash prefixes carry a
  version; a new scheme is added next to the old one.
- **Nothing runs unseen, nothing secret leaves.** See the
  [threat model](security/threat-model.md).

---

# Part 2 · File reference

Paths are relative to each package's `src/`. Tests mirror these files under each package's
`test/`.

## `packages/contracts/src`

| File             | Responsible for                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`       | Re-exports everything.                                                                                                                                   |
| `encoding.ts`    | Base64, hex and comparing bytes with web-standard APIs; the one copy every package uses (T62).                                                           |
| `primitives.ts`  | Shared building blocks: base64 of an exact length, SHA-256 hex, timestamps, short single-line text.                                                      |
| `bundle.ts`      | The plaintext bundle format: format version, agent id, scope, source OS, agent version, revision, files; safe relative paths; project name rules.        |
| `api/common.ts`  | Crypto byte sizes, the 5 MB bundle cap, route paths, custom header names (`x-an-client` too), the client version format, error codes and the error body. |
| `api/auth.ts`    | Usernames, Argon2id settings (defaults and the minimum a server may ask for), prelogin, register, login, session and account-delete bodies.              |
| `api/bundles.ts` | Scope keys, bundle list query and response (cursor), upload and download headers.                                                                        |
| `api/answers.ts` | `ClientAnswerSchemas`: the tolerant forms of every answer, built from the strict schemas' shapes; what the CLI parses answers with (T57).                |

## `packages/core/src`

| File                   | Responsible for                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`             | Re-exports everything.                                                                                                                                                                                                                                                                                                                       |
| `crypto.ts`            | The crypto interfaces (`PasswordKdf`, `Aead`, `KeyedHash`, `Digest`, `RandomSource`, `CryptoService`) and `DecryptionError`.                                                                                                                                                                                                                 |
| `sodium-crypto.ts`     | The implementation on libsodium: Argon2id (the password bytes are wiped once used), splitting the master key, XChaCha20-Poly1305, keyed BLAKE2b, SHA-256.                                                                                                                                                                                    |
| `envelopes.ts`         | Wrapping the data key; sealing and opening bundles bound to format version, agent and scope key.                                                                                                                                                                                                                                             |
| `project-names.ts`     | Scope keys (keyed hash of a project name) and encrypted project names.                                                                                                                                                                                                                                                                       |
| `bundle-codec.ts`      | The `BundleCodec` interface (bundle ↔ bytes) and `BundleFormatError`.                                                                                                                                                                                                                                                                        |
| `gzip-bundle-codec.ts` | JSON + gzip, with the 64 MB decompression cap and a schema check.                                                                                                                                                                                                                                                                            |
| `paths.ts`             | The `PathResolver` interface, `{{HOME}}`, `PathError`, and `sourceOsOf` (a platform as a bundle source OS).                                                                                                                                                                                                                                  |
| `path-resolver.ts`     | Portable paths: bundle path ↔ native path per OS, home folder ↔ `{{HOME}}` in file contents, Windows name rules.                                                                                                                                                                                                                             |
| `merge.ts`             | The `MergeStrategy` interface: plans writes for one conflicting file, never touches disk.                                                                                                                                                                                                                                                    |
| `merge-strategies.ts`  | JSON merge by key, text "keep yours, add theirs next to it", overwrite with a timestamped backup; `selectMergeStrategy` picks one per file from the `MergeChoices` a restorer passes (the first of its merges that applies, else side by side), so a new format is one more strategy in that list; `backupStamp`, the one backup time stamp. |

## `packages/cli/src`

### Entry and wiring

| File         | Responsible for                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin.ts`     | The `agentnomad` executable: chooses the prompter (terminal or none), runs the CLI with the handlers and the agents' optional parts, sets the exit code.                                                               |
| `app.ts`     | Composition root: `createAppRegistry` (every adapter), `createApp` (the handlers and the adapters' optional parts for the flags), and the API client, secret store, crypto and local state, each only when first used. |
| `index.ts`   | Re-exports the package for tests.                                                                                                                                                                                      |
| `version.ts` | The version `--version` prints (kept equal to package.json).                                                                                                                                                           |

### `cli/`: parsing and outcomes

| File                | Responsible for                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands.ts`       | The option types for every command and the `CommandHandlers` interface.                                                                             |
| `program.ts`        | Every command, flag and help text (commander); parsing only. The optional parts' flags come from the adapters.                                      |
| `project-folder.ts` | The home folder and the agent's own folder are never a project (push, pull and `env`).                                                              |
| `flags.ts`          | Validating `--agent`, `--project` and `--username` values.                                                                                          |
| `run.ts`            | Runs one invocation: exit codes, Ctrl+C, and the "needs an answer" message with the flags per command.                                              |
| `setup-outcomes.ts` | What happened to each setup in push and pull, the one "Not saved / Not restored" error (exit 1), and `setupLabel`, how every message names a setup. |
| `error-messages.ts` | The one line shown when a command fails (rate limits, server errors).                                                                               |
| `stdin.ts`          | `--password-stdin`: the first line of a pipe; refuses a terminal.                                                                                   |

### `ui/`: questions and messages

| File                      | Responsible for                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompter.ts`             | The `Prompter` (questions) and `Reporter` (messages, spinners) interfaces.                                                                                                            |
| `clack-prompter.ts`       | Both on @clack/prompts; warnings and errors to stderr; plain spinners without a terminal.                                                                                             |
| `no-terminal-prompter.ts` | The prompter for scripts: every question fails with `AnswerNeededError`.                                                                                                              |
| `format-size.ts`          | Sizes as `5 KB` or `1.2 MB`, for push and `list`.                                                                                                                                     |
| `printable.ts`            | `printable` and `printableLine`: text from a bundle or the server shown with escape sequences, direction marks and (for review lines) line breaks escaped, never acted on (T44, T71). |

### `api/`: talking to the server

| File                 | Responsible for                                                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-client.ts`      | The `ApiClient` interface (auth and bundle calls); `logout(token)` ends a given session in one attempt (T66).                                                                                                                                                              |
| `http-api-client.ts` | The implementation on `fetch`: timeouts sized to transfer size, the wake-up check, contract validation of every answer (unknown fields and error codes tolerated), the `x-an-client` version header, SHA-256 check of downloads, no retry for register and account delete. |
| `transport.ts`       | One HTTP call with timeout and retries (network errors, timeouts, 502/503/504 only), capped body reads, redirects refused.                                                                                                                                                 |
| `api-errors.ts`      | `ApiError`, `NetworkError`, `OutcomeUnknownError`, `InvalidResponseError`, `NotLoggedInError`.                                                                                                                                                                             |
| `api-url.ts`         | The server address: `AGENTNOMAD_API_URL` or the hosted API; https only (http for localhost).                                                                                                                                                                               |

### `auth/`: accounts

| File                 | Responsible for                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-commands.ts`   | `register`, `login`, `logout`, `account delete`, with the flags for scripts. `withDerivedKeys` wipes both password keys on every path; the data key is wiped the same way. |
| `local-session.ts`   | Saving, reading and clearing the session token and data key; `withSession` turns an expired session into a clear message.                                                  |
| `password-policy.ts` | 12–256 characters and a zxcvbn-ts score of 4, username used as a hint.                                                                                                     |

### `secrets/`, `config/`, `state/`: what stays on the PC

| File                             | Responsible for                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `secrets/secret-store.ts`        | The `SecretStore` interface; `setMany` saves a whole login in one write.                    |
| `secrets/keychain-store.ts`      | The OS keychain through @napi-rs/keyring (Linux pinned to Secret Service).                  |
| `secrets/file-store.ts`          | The user-only file fallback, written with the shared atomic write.                          |
| `secrets/create-secret-store.ts` | Picks the keychain when it works, else the file; moves a login left in the file into it.    |
| `config/config-dir.ts`           | agentnomad's folder: `%APPDATA%\agentnomad` or `$XDG_CONFIG_HOME` / `~/.config/agentnomad`. |
| `state/local-state.ts`           | `state.json`: project names per folder, known revisions and their account, per server.      |

### `system/`: files and programs, one copy each (T62)

| File                    | Responsible for                                                                                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system/files.ts`       | `writeFileAtomically` (temporary file, then rename; mode, folder mode, following a link, a step before the rename), `writeTargetOf`, `isMissing` and `freeSuffix` (the first free `-2`, `-3`, … for a backup name, used by the restorer and the shell profile). |
| `system/paths.ts`       | `samePath` and `pathKey`: folders compared per OS (Windows ignores case).                                                                                                                                                                                       |
| `system/json.ts`        | `parseJsonWith`: JSON text or bytes checked with a schema, the value or why it could not be read.                                                                                                                                                               |
| `system/run-program.ts` | `runProgram`: one `execFile` wrapper (no shell, timeout, never rejects) for every program the CLI starts.                                                                                                                                                       |

### `push/`, `pull/`, `commands/`: the setup commands

| File                         | Responsible for                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `push/push-command.ts`       | `push`: a plan step (choose, collect, every question) and an apply step with no prompter (encrypt, upload).               |
| `push/bundle-files.ts`       | Collected files ↔ bundle entries (UTF-8 with `{{HOME}}` or base64); keeps local files that only differ in slash style.    |
| `pull/pull-command.ts`       | `pull`: a plan step (choose, download, verify, every question, the agents' own ones too), an apply step with no prompter. |
| `pull/saved-setups.ts`       | Listing setups with decrypted names; downloading and checking one (agent, scope, sealed revision).                        |
| `commands/setup-commands.ts` | `list`, `status` and `delete`.                                                                                            |

### `env/`: environment variables in setups

| File                  | Responsible for                                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env-references.ts`   | Finding `${VAR}` references in the files the adapter names (`envReferences`), leaving out the agent's own variables.                                                                                                                                       |
| `env-section.ts`      | The encrypted `.agentnomad/env.json` section and choosing which values to save (opt-in).                                                                                                                                                                   |
| `env-restore.ts`      | On pull: adding saved values that are missing here (not in the environment nor already written); asking (plan) and writing (apply) are separate.                                                                                                           |
| `shell-profile.ts`    | Writing them, and reading back what is there: a marked block in the shell profile (sh, bash, zsh, fish), rewritten only when it changes after a backup that never replaces another, or Windows user variables through one PowerShell call for all of them. |
| `loader-variables.ts` | `LOADER_VARIABLE`: the variables that make a shell or runtime load or run code (`NODE_OPTIONS`, `LD_*`, ...); a saved value for one is treated like a hook (T44, T55).                                                                                     |
| `env-command.ts`      | `agentnomad env`.                                                                                                                                                                                                                                          |

### `agents/`: the plug-in layer

| File                | Responsible for                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter.ts`        | The adapter interfaces: `Detector`, `Collector`, `Restorer`, `AgentInspector`, `AgentAdapter`, `AgentRegistry`, the types they share, and `ChosenAgent` for push and pull. |
| `registry.ts`       | `createAgentRegistry`: the list of adapters, by id.                                                                                                                        |
| `notices.ts`        | What commands say about any agent: comparing versions for pull's warning, files an adapter does not know, and `showNotices` (each notice once).                            |
| `agents-command.ts` | `agentnomad agents`.                                                                                                                                                       |

### `agents/shared/`: helpers for every adapter

| File                 | Responsible for                                                                                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detector-system.ts` | What a detector reads from this PC (`DetectorSystem`, `nodeDetectorSystem`), `pathsOf` (the path rules of a platform) and `findExecutable`, which searches PATH like a shell and takes only `ExecutableLookupSystem` (platform, home, env, `isExecutable`). |
| `file-gathering.ts`  | Reading files and folders into bundle entries: links followed once, never into a folder for keys and logins, the adapter's clutter names, agentnomad's copies and leftover temporary files skipped.                                                         |
| `bundle-paths.ts`    | `underFolder`: whether a bundle path is a folder or inside it, with or without case. No file access.                                                                                                                                                        |

### `agents/claude-code/`: the Claude Code adapter

| File                                  | Responsible for                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code-adapter.ts`              | Assembles the adapter from the parts below.                                                                                                                                                                                                                                                                           |
| `claude-code-paths.data.ts`           | **The data file:** every list of what to sync, skip or refuse, schema-checked.                                                                                                                                                                                                                                        |
| `global-paths.ts`, `project-paths.ts` | Named views of the data file for the global and project collectors.                                                                                                                                                                                                                                                   |
| `detector.ts`                         | Finding `claude` and its version; the base folder (`CLAUDE_CONFIG_DIR`).                                                                                                                                                                                                                                              |
| `env-files.ts`                        | Which files hold `${VAR}` references (MCP servers, settings), the variables Claude Code sets itself, and the `~/.claude.json` label.                                                                                                                                                                                  |
| `settings-commands.ts`                | Parsing settings and command lines: the commands a `settings.json` runs as the words each program gets (hooks read one by one, so a malformed one hides no other; exec form keeps each `args` element whole), the words that can name a script (`pathWords`) and the program. No file access (a lint rule checks it). |
| `global-collector.ts`                 | Collecting the global setup, `~/.claude.json` keys, hook scripts, tool settings, programs, plugins.                                                                                                                                                                                                                   |
| `project-collector.ts`                | Collecting a project's setup and, when chosen, its auto memory.                                                                                                                                                                                                                                                       |
| `hook-scripts.ts`                     | Which scripts the hooks and status line run, for the global setup and for a project: what push collects and pull allows back (one rule for both).                                                                                                                                                                     |
| `account-skills.ts`                   | claude.ai skills (T42): reading `skills/synced/` (only `creatorType: user`), saving a copy, and what pull may add as local skills.                                                                                                                                                                                    |
| `auto-memory.ts`                      | Finding a project's auto memory folder the way Claude Code does.                                                                                                                                                                                                                                                      |
| `restore-rules.ts`                    | Where each bundle entry may go, or why it is refused (including Windows name rules).                                                                                                                                                                                                                                  |
| `restorer.ts`                         | Writing a setup: atomic writes, permissions, line endings, conflicts; what pull asks first.                                                                                                                                                                                                                           |
| `claude-json-merge.ts`                | The `~/.claude.json` merge: only MCP servers and preferences, a backup first, never while Claude Code runs; `ClaudeJsonError`.                                                                                                                                                                                        |
| `command-review.ts`                   | Finding hooks, status line, MCP servers and the scripts they run, and which are new or changed on this PC. An entry that cannot be read is shown as unreadable.                                                                                                                                                       |
| `reviewed-settings.ts`                | The settings keys and `env` names the review watches (command, loosening and redirect settings); the drift watch list.                                                                                                                                                                                                |
| `running-claude.ts`                   | Is Claude Code (or the Claude app) running (command lines)?                                                                                                                                                                                                                                                           |
| `plugins.ts`                          | Reading installed plugins and marketplaces into `.agentnomad/plugins.json`; the entry schemas push and pull both check; the one reader of `installed_plugins.json`.                                                                                                                                                   |
| `plugin-sync.ts`                      | Reinstalling what is missing with `claude plugin` commands: the questions (`askPluginSync`), then the installs (`installPlugins`); `createProgramCli` runs `claude` and `npm`.                                                                                                                                        |
| `programs.ts`                         | Finding the programs hooks start and whether npm installed them; the `programs.json` entry schema push and pull both check.                                                                                                                                                                                           |
| `after-restore.ts`                    | Pull's follow-up: plugins, missing programs and claude.ai skills; asked in the plan step, installed after writing.                                                                                                                                                                                                    |
| `managed-settings.ts`                 | Detecting organization-managed settings per OS (never synced) and explaining what they block.                                                                                                                                                                                                                         |
| `unknown-files.ts`                    | Reporting files in Claude Code's folder that the data file does not know.                                                                                                                                                                                                                                             |

## `packages/server/src`

| File                                                                           | Responsible for                                                                                      |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `main.ts`                                                                      | Starts the Node web server, logs a crash as one line, and shuts down cleanly on Render's signals.    |
| `server.ts`                                                                    | Production start: settings, Neon pool (its errors logged), keys, then `createApi`.                   |
| `api.ts`                                                                       | `createApi`, the composition root: limiter, services and app from a database (all callers use it).   |
| `index.ts`                                                                     | Re-exports for tests and the e2e server.                                                             |
| `port.ts`                                                                      | The port from `PORT`.                                                                                |
| `encoding.ts`                                                                  | Base64url, UTF-8 and SHA-256 for tokens, cursors and uploads; base64 and hex come from contracts.    |
| `db/env.ts`                                                                    | Reading and checking `DATABASE_URL` and `SERVER_SECRET`.                                             |
| `db/schema.ts`                                                                 | The Drizzle tables and their constraints.                                                            |
| `db/database.ts`                                                               | The driver-independent `Database` type (Neon in production, PGlite in tests).                        |
| `db/repositories.ts`                                                           | Repository interfaces, their errors and the storage-limit rule.                                      |
| `db/user-repository.ts`, `db/session-repository.ts`, `db/bundle-repository.ts` | Accounts, sessions (token hashes) and bundle metadata in Postgres, with the revision check.          |
| `db/bundle-cursor.ts`                                                          | Opaque list cursors, format-checked (a real date and time, a UUID); queries stay scoped to the user. |
| `storage/blob-store.ts`                                                        | The `BlobStore` interface: encrypted bytes under random ids (R2 later).                              |
| `storage/postgres-blob-store.ts`                                               | The implementation in `bundle_blobs`.                                                                |
| `auth/server-keys.ts`                                                          | Keys from `SERVER_SECRET`: auth-key hashes (constant-time check), fake salts, pseudonyms.            |
| `auth/session-tokens.ts`                                                       | New 256-bit tokens and their hashes.                                                                 |
| `auth/auth-service.ts`                                                         | Prelogin, register, login, logout, account delete, session checks, lifetimes.                        |
| `bundles/bundle-service.ts`                                                    | Listing, downloading, saving (the safe upload order) and deleting setups.                            |
| `rate-limit/rate-limiter.ts`                                                   | The rules and the `RateLimiter` interface.                                                           |
| `rate-limit/postgres-rate-limiter.ts`                                          | Fixed-window counters in `rate_limits` on the database clock.                                        |
| `http/app.ts`                                                                  | The Hono app: request ids, security headers, the request log (with the CLI version), routes, errors. |
| `http/routes/auth.ts`, `http/routes/bundles.ts`, `http/routes/account.ts`      | The endpoints.                                                                                       |
| `http/session.ts`                                                              | `requireSession`: the bearer token, one identical 401 for every failure.                             |
| `http/validate.ts`                                                             | Parsing bodies, queries, params and headers with the contracts.                                      |
| `http/small-body.ts`                                                           | Size limit for JSON requests.                                                                        |
| `http/rate-limit.ts`                                                           | Per-IP and per-account limits on routes.                                                             |
| `http/errors.ts`                                                               | The standard error body; 500 details only in logs.                                                   |
| `hosting/client-ip.ts`                                                         | The visitor's IP on Render (Cloudflare's header).                                                    |
| `logging/logger.ts`                                                            | JSON log lines with only safe fields.                                                                |
| `logging/crash.ts`                                                             | An uncaught error or unhandled rejection: one log line, then exit 1.                                 |

Also in the server package: `drizzle/` (SQL migrations) and `drizzle.config.ts`.

## `packages/e2e/src`

| File                | Responsible for                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local-server.ts`   | The real API (`createApi`) on PGlite on a free local port, loaded from or dumped to a file; records every request.                                    |
| `pc.ts`             | A simulated PC (its own home, config folder and project) that runs the built CLI with no terminal.                                                    |
| `steps.ts`          | The three end-to-end steps and what each checks.                                                                                                      |
| `plaintext.ts`      | Searching recorded requests for readable secrets (as text and base64 at any alignment).                                                               |
| `push-env-value.ts` | `agentnomad push` with the question of which environment values to save answered, run in a child process of a PC (the e2e PCs have no terminal; T56). |

## Repository root

| Path                                    | Responsible for                                                                                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`              | CI: checks on 3 OSes × 2 Node versions, Linux keychain, the npm package installed and run end to end, the cross-OS chains, the dependency audit, the migration check, the coverage and unused-code reports (one job). |
| `.github/workflows/audit.yml`           | Runs `pnpm audit --prod` every Wednesday; a finding fails the run.                                                                                                                                                    |
| `.github/workflows/release.yml`         | Release: verify on every OS, approval, publish to npm with provenance, check `npx` on every OS.                                                                                                                       |
| `packages/cli/scripts/build-release.ts` | Builds the `agentnomad` npm package (esbuild bundle + manifest).                                                                                                                                                      |
| `packages/cli/scripts/drift/`           | The weekly Claude Code drift check: `drift.ts` (comparison and report), `check-claude-code.ts` (fetches the sources).                                                                                                 |
| `.github/workflows/drift-check.yml`     | Runs the drift check every Monday and files or updates the `drift` issue.                                                                                                                                             |
| `render.yaml`                           | The Render service (build, start, health check).                                                                                                                                                                      |
| `knip.json`                             | The unused-code check (`pnpm knip`): workspace entry points (including the e2e push helper, which runs as a child process).                                                                                           |
| `pnpm-workspace.yaml`                   | Workspace packages and dependency overrides.                                                                                                                                                                          |
| `tsconfig.base.json`, `tsconfig.json`   | Strict TypeScript settings and project references.                                                                                                                                                                    |
| `eslint.config.js`, `vitest.config.ts`  | Lint rules, the test projects and the coverage settings.                                                                                                                                                              |
| `docs/`                                 | This document, the roadmap, the agent guide, decisions and the threat model.                                                                                                                                          |
