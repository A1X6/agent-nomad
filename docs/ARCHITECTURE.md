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

| Entry                                        | What it holds                                                                                                                                                                                                                                                                             | On pull                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.agentnomad/claude-json-project.json`       | A project's part of `~/.claude.json` (T109): `mcpServers`, `enabledMcpjsonServers` and `disabledMcpjsonServers` of the project folder's entry in `projects`                                                                                                                               | Merged into the entry of the folder pull runs in (made when missing); the entry's trust, history and allowed tools are never touched                                                                                                                                                                                                                 |
| `.agentnomad/claude.json`                    | Selected `~/.claude.json` keys: MCP servers and documented preferences                                                                                                                                                                                                                    | Merged in by key; the file's login and project state are never touched                                                                                                                                                                                                                                                                               |
| `.agentnomad/home/...`                       | Scripts the hooks or status line run from elsewhere in the home folder, and known tool settings                                                                                                                                                                                           | Written back to the home folder: scripts only if the setup's own hooks or status line run them, known tool settings always                                                                                                                                                                                                                           |
| `.agentnomad/auto-memory/...`                | The project's auto memory (opt-in). In a global bundle (T110): every project's, under `<project folder name>/`, or the one folder `autoMemoryDirectory` in user settings names, once under `_shared/`                                                                                     | Written to this PC's memory folder for the project; from a global bundle to `<base>/projects/<same name>/memory/`, `_shared/` to the folder `autoMemoryDirectory` names here (else in the pulled user settings), checked as a project's chosen folder                                                                                                |
| `.agentnomad/plugins.json`                   | Installed plugins and their marketplaces                                                                                                                                                                                                                                                  | Plugins are reinstalled with `claude plugin`, never copied                                                                                                                                                                                                                                                                                           |
| `.agentnomad/plugin-versions.json`           | The installed version of each saved plugin (T100); left out when none is known                                                                                                                                                                                                            | Claude Code installs the latest version; pull names each plugin whose version changed (`was X, now Y`). Older CLIs refuse it with one warning and go on                                                                                                                                                                                              |
| `.agentnomad/local-marketplaces/<name>.json` | A marketplace added from a local folder with a plugin installed in the setup's scope (T98): its path from home (`null` outside home), the remote and commit when the commit is on the remote, its plugins, and its files (base64; in a git repository only what git lists, never `.git/`) | Written to the same path from home (outside home: `~/.agentnomad/marketplaces/<name>`), re-cloned first when it can be, the saved files written whatever happens; then added with `claude plugin marketplace add` from the folder pull wrote and its plugins installed. One file per marketplace, so older CLIs refuse it with one warning and go on |
| `.agentnomad/plugin-dirs/<n>.json`           | A plugin folder `env.CLAUDE_CODE_PLUGIN_DIRS` names in the user's `settings.json` (T99), `n` its place in the value: the folder as named there, the separator, its path from home (`null` outside home), the remote and commit, and its files, as a local marketplace's                   | Written to the same path from home (outside home: `~/.agentnomad/plugin-dirs/<name>`), re-cloned first when it can be, after the plugin review; the value in the restored `settings.json` then names the folders pull wrote, with this PC's separator. One file per folder, so older CLIs refuse it with one warning and go on                       |
| `.agentnomad/programs.json`                  | Programs hooks start, and how npm installed them                                                                                                                                                                                                                                          | Missing ones are offered for install                                                                                                                                                                                                                                                                                                                 |
| `.agentnomad/env.json`                       | Environment variable values the user chose to save                                                                                                                                                                                                                                        | Offered for the shell profile; never written as a file                                                                                                                                                                                                                                                                                               |
| `.agentnomad/account-skills/...`             | A copy of the user's own claude.ai skills (saved unless the user says no, T114; never Anthropic's or an organization's)                                                                                                                                                                   | Offered as local skills in `~/.claude/skills/<name>/`, only on a PC that does not already get them from claude.ai                                                                                                                                                                                                                                    |
| `.agentnomad/account-plugins/...`            | A copy of the plugin folders of the user's own claude.ai uploads (T101, saved unless the user says no, T114; never claude.ai's directory, an organization's, or one claude.ai installs by itself)                                                                                         | Offered as plugins in `~/.claude/skills/<name>/` (`<name>@skills-dir`) after the plugin review, only on a PC that does not already get them from claude.ai. Older CLIs refuse them with one warning and go on                                                                                                                                        |
| `.agentnomad/plugin-data/<folder>/...`       | A plugin's `plugins/data/<folder>/` for each plugin the setup restores (opt-in, T102), named from its id; never a removed plugin's                                                                                                                                                        | Written after the plugins are in, only for a plugin installed here with that name (the same id). Older CLIs refuse each file with a warning and go on                                                                                                                                                                                                |
| `.agentnomad/plugin-store/<file>.json`       | A mod's `plugins/store/<file>.json` (its `$.store`), on the same terms                                                                                                                                                                                                                    | The same; the store folder gets mode 700 and its files 600                                                                                                                                                                                                                                                                                           |

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
5. The adapter **collects** the files; the user may add saved environment values
   (`--env-values`; `--yes` alone saves none). Links
   into folders for keys, links out of a project and files over 10 MB are left out, and push
   says so.
6. Compare each setup's revision on the server with the one this PC last knew. If another
   PC saved a newer copy (or deleted it), the user is asked whether to replace it (with
   `--yes`: never). If this PC's last pull of a setup did not restore everything (declined
   commands, or differing files it left as they were), pushing it could drop them for every
   PC: push asks first, and `--yes` skips it with a note.
7. Paths are made portable, the bundle is built, compressed and **encrypted for the exact
   revision it will become** (the one on the server, plus one).
8. Upload with that expected revision, and remember the new revision for this PC. If another
   PC saved in the meantime, the server refuses (`revision_conflict`) and the setup is
   skipped, never replaced unasked.

Push is split in two (T59): a **plan** step does steps 1 to 6 and asks every question, and an
**apply** step does 7 and 8. The apply step is given no prompter at all, so it cannot ask.
When the plan asked anything, push shows what it will save (per setup: its files, what is
always in it and what the user chose, under the headings of `push --help`) and asks once more,
`Upload it now?` (T115); a no saves nothing and exits with `0`. A run whose every answer came
from flags, or with `--yes`, is not asked, so scripts work as before.

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
file here that differs (`~/.claude.json` whenever the setup has it, or a project's part of it,
T109) and missing environment values, then each agent's own questions (T61): for Claude Code, closing Claude Code when
`~/.claude.json` would change, then saved claude.ai plugins and the plugin folders in
`skills/`, then plugins, programs and claude.ai skills. Without a
terminal, an open question stops pull here, before any file changes. The **apply** step
writes with those answers and has no prompter, nor does the agent's follow-up it runs last
(plugin and program installs, adding the skills); a file only the restorer finds different,
which the plan never asked about, is left as it is and the setup counts as not done.

- Files that only differ in how the home path is written (`C:/` vs `C:\`) are left as they
  are.
- Pull never deletes files.
- `--merge`, `--overwrite` and `--skip-existing` answer every file at once (interactively,
  "… all remaining files" does the same from one file on); JSON merges by key (the incoming
  side wins), other text files are kept and the incoming copy is saved next to them. A JSON
  file holding a number JSON cannot keep (past the safe integer range, or too large for a
  double, such as `1e400`) is kept side by side too.
- `--yes` never accepts new commands, plugin reinstalls or npm installs; `--allow-commands`
  does.
- `--env-values` chooses which saved environment values missing here are added (names, `all`
  or `none`); a variable that loads code or redirects requests still needs `--allow-commands`
  or a yes.
- Like push, pull shows its plan and asks `Restore it now?` when it asked anything before
  (T115); a no writes nothing. The plan names the agent's own choices too (UX-01): claude.ai
  plugins, plugin folders left out, plugin data, plugins to reinstall and programs to install.

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
| `inspector` (optional)         | What should the user be told on push, pull or `agents` (managed settings, files this version does not know yet, a setup saved with a newer version)? What push's summary adds about the collected files (`pushNotes`, T97: the plugins in `skills/`)?                                                                  |
| `optionalParts` (optional)     | What push asks about, e.g. Claude Code's claude.ai skills; `defaultYes` is the question's default and what `--yes` does (T114); `available()` may add a `notice` push shows before asking; `--<id>` / `--no-<id>` answer it in push and pull, built from the registered adapters with the part's `flagHelp`.           |
| `envReferences` (optional)     | Which files can use `${VAR}` (MCP servers, settings) and which variables the agent sets itself; push offers the values, `agentnomad env` lists them.                                                                                                                                                                   |
| `memoryDescription` (optional) | What push's memory question names.                                                                                                                                                                                                                                                                                     |
| `planRestore` (optional)       | The agent's own questions in pull's plan step; returns how to write the setup and a follow-up (e.g. plugin reinstalls) that gets no prompter. The plan may say it left part of the setup out (`declined`, T97), so a later push asks first, as after declined commands.                                                |

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

| Scope               | Saved                                                                                                                                                                                                                                                | Never saved                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global `~/.claude/` | `settings.json`, `CLAUDE.md`, `keybindings.json`, `loop.md`, `rules/`, `skills/` (plugins and mods there too, T97), `commands/`, `agents/`, `workflows/`, `output-styles/`, `themes/`, `hooks/` (whole, T112), scripts hooks and the status line run | `.credentials.json`, history, transcripts, sessions, caches, backups, plugin caches, `settings.local.json`, `skills/synced/` (synced by claude.ai), `.claude-plugin/types/` in a plugin in `skills/` (generated) |
| `~/.claude.json`    | Only `mcpServers` and the 12 "Global config" keys of the settings reference; for a project, `mcpServers`, `enabledMcpjsonServers` and `disabledMcpjsonServers` of its entry (T109)                                                                   | Login, projects, usage and onboarding state                                                                                                                                                                      |
| Project root        | `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.mcp.json`, `.worktreeinclude`, scripts the project's hooks run                                                                                                                                        | Everything else, including app code, `.env` and `.git`                                                                                                                                                           |
| Project `.claude/`  | `settings.json`, `settings.local.json`, `CLAUDE.md`, `loop.md`, and the global folders except `themes/`                                                                                                                                              | `agent-memory-local/`, `worktrees/`                                                                                                                                                                              |
| Opt-in              | Subagent memory, auto memory (a global push takes every project's, T110)                                                                                                                                                                             |                                                                                                                                                                                                                  |

The scripts hooks and the status line run are found in the words each program gets
(`settings-commands.ts`, one reading for push, pull and the review): a hook in exec form
(`args` set) passes each `args` element as one word, spaces and all; a shell-form command is
split like a shell, and a word that carries a command line (`bash -c "a.sh; true"`,
`pwsh -Command "& 'a.ps1'"`) is split again, at any depth, also on shell operators (`a.sh;`,
`a.sh&&b`). The review shows an exec-form hook with each `args` element quoted and compares
it by its words, so a text moved between one argument and a shell command line is shown as
new. The "will likely not run here" warning for a setup from another OS looks only at a
command's program and the scripts it runs, and shows the command as written, with line breaks
escaped.

**Imports** (`claude-md-imports.ts`, T111): the `@path` lines of the synced memory files
(global `CLAUDE.md` and `rules/**/*.md`; project `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`,
`.claude/CLAUDE.md` and `.claude/rules/**/*.md`) are read as the 2.1.296 program reads them
(function `UZn`, loader `YU`): the pattern `(?:^|\s)@((?:[^\s\\]|\\ )+)` over the text
outside code spans, fenced code blocks (its Markdown lexer's `code` and `codespan` tokens) and
HTML comments, after the frontmatter; the path cut at `#`, `\ ` read as a space, and taken only
when it starts with `./`, `~/`, `/` (not `/` alone) or a letter, digit, `.`, `_` or `-`, never
a network path. A path resolves from the importing file's folder, `~/` from the home folder,
`/c/x` as `C:\x` on Windows. Imports of imported files are followed depth first, each file
once, four hops deep (`$nr=5` counts the memory file itself). The program loads any text
extension (its `DZn` list); agentnomad takes only Markdown and plain text
(`IMPORT_DOCUMENT_EXTENSIONS`), because pull writes them without a review: never code, scripts,
settings programs read (`~/.claude.json`, which pull only ever merges, or a tool config naming a
command) nor names without an extension (`.bashrc`, `.husky/pre-commit`). Global placement
follows the hook-script rule: in the base folder at its own path (never `.agentnomad/` nor a
refused name), elsewhere in the home under `.agentnomad/home/` (never a folder for keys and
logins nor an autostart folder); project placement keeps the project path, never in a
never-synced entry (`.git`, `.agentnomad`, ...).
Files are read through the gatherer, so its link rules and 10 MB limit apply. Push passes each
existing file it cannot take to `onSkipped` with the importing file, the line and the `@` text;
a missing one is skipped without a word, as the program skips it. Pull follows the same imports
through the bundle and adds what it finds to the restore rules' allowed set, so it writes an
imported file only when the setup's own memory files import it. An imported file never runs
anything: the loader (`LLe`) only reads its text, strips HTML comments and looks for more
imports; the `` !`command` `` forms belong to skills and commands, so imports need no review.
Not modelled: indented code blocks (an import there is still followed) and emphasis around an
import (`**@a.md**` is read with the asterisks and finds no file). The unknown-file check is
quiet for a base-folder folder that holds an imported file, as for hook scripts.

**Restore rules** (`restore-rules.ts`): a file is written only if a collector could have
produced it. A home-folder file must be a known tool's settings or a script the setup's
own hooks or status line run, and never in a folder whose files run by themselves (Startup,
`.config/autostart`, `Library/LaunchAgents`, fish and PowerShell profile folders), so a
bundle cannot drop a file that runs by itself. The same holds in Claude Code's own folder: a
script outside the synced folders is written only when the setup's hooks or status line run
it, and never in Claude Code's own state (`knownState`: `chrome/`, `local/`, `state/`, …),
which is refused like never-synced entries (T55). `hooks/` is a synced folder (T112), in the
base folder and in a project's `.claude/`: any file there is written, since a script there
runs only when a settings file names it and pull reviews every such setting first; scripts
elsewhere in the home folder still go through `.agentnomad/home/`. What Claude Code
generates inside a plugin in `skills/` (`.claude-plugin/types/`, from
`plugins.generatedInPlugin`) is never pushed and
refused on pull (T97). Refusals ignore case. On Windows, names with
`:`, device names, trailing dots and 8.3 short names (`PROGRA~1`; a name too long for the
8.3 form, like `release-notes~3.md`, is allowed) are refused. Two entries that differ
only in case or Unicode form are one file on Windows and macOS: only the first is written. An
entry that cannot be written is skipped with a warning; the rest continue. `~/.claude.json`
is only ever merged, with a backup: only `mcpServers` and the preference keys, never
`projects` or account state. A project setup's part (T109) goes into the entry of the folder
pull runs in, made when missing, and changes nothing else of the entry: servers by name and
each `.mcp.json` approval or rejection by server name, the pulled one winning. It is skipped
while Claude Code is running (it rewrites the file while open): pull's plan step asks to close it ("I closed it, continue" checks again,
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
and outside refused folders (`auto-memory.ts`). A global bundle's auto memory (T110) goes to
`<base>/projects/<name>/memory/` under the name it was saved with (the name comes from the
project's path, so it matches when the project is at the same path here), and its `_shared/`
notes to the folder `autoMemoryDirectory` in user settings names, here or else in the pulled
settings, with the same folder checks. When one pull restores the global and a project setup
that both hold a note, the project's copy wins: the global setup is written first, and the
project's note then replaces the one it wrote without another question.

**Review of runnable things** (`command-review.ts`): everything Claude Code's docs say it
runs, when new or changed compared with this PC, is listed before anything is written: hooks
(commands, and `http` hooks that send data to an address), the status line, settings that
run a command (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`,
`otelHeadersHelper`, `fileSuggestion`, `subagentStatusLine`), loader variables in a settings
`env` block (`NODE_OPTIONS`, `LD_PRELOAD`, …) and `env` names that redirect Claude Code
(`ANTHROPIC_BASE_URL` and the other endpoints, proxies, `NODE_EXTRA_CA_CERTS`, its shell
variables, OpenTelemetry endpoints, `PATH`), the Claude apps gateway `/login` signs in to
(`forceLoginGatewayUrl` in global settings, which Claude Code 2.1.296 reads only there and only
with `forceLoginMethod: "gateway"`; the entry says which, T107), a `permissions.defaultMode`
that lets Claude act without asking (`bypassPermissions` and `auto` in global settings, where
alone Claude Code takes them; `acceptEdits` from any settings file),
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

**Plugins and mods in `skills/` (T97):** a folder in `~/.claude/skills/` with
`.claude-plugin/plugin.json` is a plugin Claude Code loads as `<name>@skills-dir`; with
`hooks/hooks.json` (a mod's `modules`, or classic command hooks) it runs code inside Claude
Code. Push takes it with `skills/`, minus `.claude-plugin/types/`, and its summary names it
(`Plugins in skills/: probe-mod@skills-dir (runs code)`). Pull's plan step reviews each one
that is new or changed here before anything is written (`plugin-review.ts`, global setup
only): it writes the folder's files into a new temporary folder of its own (never a path
read from the bundle) and runs `claude plugin validate --json` there, with an empty
`CLAUDE_CONFIG_DIR` of its own, since Claude Code rewrites settings when it starts. It shows
each module's `hooks:` and `calls:` lines, flags `$.process`, `$.fs` writes, `$.model` and
network calls (and offers the module's source), and lists classic command hooks with the
same hook reader as settings. A folder with code needs a yes or `--allow-commands`; `--yes`
alone never writes it. A folder validate fails (exit 1) shows its errors and is written only
after a person's yes, never by a flag. Without Claude Code or without `claude plugin
validate`, pull says so and treats the folder as unreviewed code. A declined folder is left
out whole and the setup is noted as partial, so a later push asks first. T98, T99 and T101
use the same review.

**claude.ai skills (T42):** Claude Code downloads the skills of the user's claude.ai account
into `skills/synced/<account>/` and manages that folder; agentnomad never writes there. Push
saves a copy of the user's **own** ones under `.agentnomad/account-skills/` unless the user
says no or `--no-account-skills` (T114: the question defaults to yes, and `--yes` saves
them). The folder's `manifest.json` tells them apart: before Claude Code 2.1.295 by
`creatorType: user`; from 2.1.295, which writes no `creatorType`, by `source` `custom` or
`plugin`. A `plugin` skill is the user's only when its backing plugin
(`backingPluginId`, found in `plugins/synced/<account>/manifest.json`) comes from a
marketplace of scope `account` in `.marketplaces.json`; `org` and `default` (an
organization's, claude.ai's directory) are left out and named. Without `.marketplaces.json`
an organization's skill cannot be told apart, and push says so; with it, a skill whose
marketplace cannot be found, or with a `source` agentnomad does not know, is left out and
named. Anthropic's (`anthropic`, `anthropic-example`) and `session-refs` are never saved.
On pull they are listed and, unless the user says no or `--no-account-skills` (`--yes` adds
them, T114), written as normal local skills in `~/.claude/skills/<name>/`, skipping any this
PC already gets from claude.ai and never replacing a local skill. A local skill runs its
`!`command`` lines where a synced one does not, so such skills are marked, and a flag or
`--yes` (no person answering) adds them only with `--allow-commands`.

**claude.ai plugins (T101):** the same rules for the plugins Claude Code syncs into
`plugins/synced/<account>/`, which agentnomad never writes either. Push, unless the user says
no or `--no-account-plugins` (T114, as for skills), saves a copy of the user's **own** ones
under `.agentnomad/account-plugins/<name>/`: only a plugin whose marketplace has scope
`account` in `.marketplaces.json` (My Uploads), never
`default` (claude.ai's directory, e.g. Anthropic's knowledge-work plugins) or `org`, and never
one with `installationPreference` `required` or `auto_install` (claude.ai installs those by
itself). A manifest or marketplaces list in an unknown shape saves nothing for that account,
and push says why; without `.marketplaces.json` nothing is saved and push says so; a plugin
whose marketplace is not listed, or whose folder has no `.claude-plugin/plugin.json`, is left
out and named. "The plugin's files" are the plugin's folder next to the manifest,
`plugins/synced/<account>/<name>/`, or `<name>~g<N>/` when its manifest entry has a
`generation` N of 2 or more (`syncedPluginFolder`, T106), taken whole minus the skipped names
and what Claude Code generates in a plugin (`.claude-plugin/types/`); the bundle keeps the
plain `<name>`. The `<folder>.meta.json` beside it only repeats manifest fields and stays.
On pull they are listed and, unless the user says no or `--no-account-plugins` (`--yes` adds
them, T114), added to the setup as `skills/<name>/`, where Claude Code loads them as
`<name>@skills-dir`, skipping one this PC already gets from
claude.ai (a synced plugin or skill of that name) and any name a local skill or plugin uses.
They then go through the plugin review above like any plugin folder. If the PC later signs in
to the account they came from, Claude Code prefers the local copy.

**Plugin data (T102, opt-in):** `push --plugin-data` saves `plugins/data/<folder>/` and
`plugins/store/<file>.json` of each plugin the setup restores: the user-scope plugins in
`plugins.json`, the plugins of saved local marketplaces (T98), plugin folders in `skills/`
(T97) and, when saved too, the user's claude.ai plugins (T101) under the id pull gives them
(`<name>@skills-dir`). The folder and file names come from the plugin id by the two rules in
`plugins.data` and `plugins.store` of the data file; `plugins/data` and `plugins/store` are
never listed, so a removed plugin's leftovers are never saved. The skipped names apply, and a
plugin over 5 MB in all is left out and named. Pull lists the saved names, asks (or
`--plugin-data`; `--yes` alone never), asks about each file here that differs (T34), and
after the plugin installs writes only the names of plugins installed here then
(`installed_plugins.json`, any scope, and plugin folders in `skills/`), so under the same id;
`plugins/store/` gets mode 700 and its files 600 on macOS and Linux.

**After restore:** plugins are reinstalled with Claude Code's own `claude plugin
marketplace add` and `claude plugin install` (on Windows a `.cmd` launcher runs through
`cmd.exe` with one verbatim line: an argument with a space, like a local marketplace folder,
is quoted; one with `"&|<>^%!`, other white space or control characters is refused); a
plugin built by running a command gets its own question; programs that hooks start and npm installed are offered with
`npm install -g name@version` (the package is the one the launcher runs: its link on macOS
and Linux, its `.cmd` on Windows, so `tsc` from `typescript` and scoped packages count).

**Claude Code plugin facts (2.1.296)** (T96, each checked again on the 2.1.296 program in
T107), seen on a real Claude Code for the plugin and mod sync tasks; the test fixtures in
`claude-code-plugin-fixtures.ts` hold each one:

- A mod (`hooks/hooks.json` naming modules) in `~/.claude/skills/<name>/` loads as
  `<name>@skills-dir`, scope user.
- A plugin's data folder is `plugins/data/<id>` with every character other than letters,
  digits, `_` and `-` turned into `-` (`Odd.Name_v2@my-local.mkt` →
  `Odd-Name_v2-my-local-mkt`; T96 also kept `*`, which the 2.1.296 program turns, T107). A
  mod's `$.store` is not there but in
  `plugins/store/<safe id>-<first 12 hex of sha256(id)>.json`, the safe id (`_` for any other
  character) cut to 64 characters, the folder mode 700 and the file 600
  (`probe-mod@skills-dir` → `probe-mod_skills-dir-e89169932969.json`). The program names a
  `<package>@npm` plugin's data folder another way, which agentnomad does not follow: it
  restores no npm plugin.
- `skills/synced/<account>/manifest.json` entries have no `creatorType` any more; `source` is
  `anthropic`, `anthropic-example`, `plugin` (the user's uploads, with a `backingPluginId`),
  `custom` or `session-refs`. `plugins/synced/<account>/manifest.json` entries carry an
  `installationPreference` (`available`, `required`, `auto_install`, `not_available`) and
  `.marketplaces.json` rows a `scope` (`org`, `default`, `account` for My Uploads).
- `claude plugin validate` prints one `hooks:` and one `calls:` line per module (`calls:` names
  only `$` methods; classic command hooks are not listed), exits 0 on a pass, also with
  warnings, and 1 on an error (a syntax error, a missing module, a broken manifest);
  `--strict` makes a warning fail. `--json` has the same lines in each entry's `notes`
  (checked again on 2.1.296).
- `policy-limits.json.stamp.json` is state and never synced; so is `seed-admin/`, the scratch
  copies an `/ultrareview` upload makes (changelog for 2.1.295, T107).
- The 2.1.296 program keeps two lists of the state in its folder: 49 folder names it skips when
  it walks a `.claude` folder, and 72 names a self-hosted runner leaves out when it copies the
  folder (T108; both in the test fixture `claude-code-state-names.ts`). Every name is in the
  data file, so push's unknown-files warning stays quiet for them: logins
  (`.session_ingress_token`, `hfi-auth.json`), account state and session content are never
  synced; caches, profiles, traces, locks and markers are known state.
- Seven names that might be the user's own, checked on the 2.1.296 program and its docs (T113).
  `loop.md` is synced as a plain file, global and project (`.claude/loop.md`): the prompt a
  bare `/loop` runs, read from the project's `.claude/` first and then the base folder, taken
  as text (cut at 25,000 bytes) into the prompt of each tick; the program runs nothing from it
  (no `!` commands, no hooks), so pull restores it as `CLAUDE.md`, with the same merge,
  overwrite and backup rules and no review. The other six stay never synced: `shares/` holds
  zips the program's clean-up deletes when they get old; `scratch/` is the session storage's
  per-session scratch (keyed by session); `agent-memory-local/`, `agent-memory-project/`,
  `local-settings/` and `project-settings/` are per-project folders of the session storage
  (keys `agentMemory` and `settings` with the layers `local` and `project`), laid out in
  bytecode and written by no command that runs without an account, so what is inside cannot be
  read. The user's own copies live in the project (`.claude/agent-memory/` opt-in,
  `.claude/settings*.json`), which project push takes; the sub-agents docs keep
  `agent-memory-local/` out of version control ("project-specific but shouldn't be checked
  into version control"), so it stays personal.
- Claude Code never loads a `hooks/` folder by itself (T112): the 2.1.296 program names
  `.claude/hooks` only in its sandbox's list of protected paths, next to `skills/`,
  `commands/`, `agents/` and the settings files, and reads `hooks/hooks.json` only inside a
  plugin folder. A script in `~/.claude/hooks/` or a project's `.claude/hooks/` runs only
  when a settings file names it, so agentnomad syncs both folders whole.
- `~/.claude.json` keeps a project's local-scope MCP servers (`claude mcp add`'s default) in
  `projects[<key>].mcpServers` (T109, checked with `claude mcp add` in an empty config folder
  and in the 2.1.296 program). The key is the git root of the folder Claude Code runs in, or
  the folder itself, as given: on Windows with `/` for `\` and the case unchanged
  (`C:/Users/me/app`). Push looks up the folder it runs in; pull writes to that key, or to an
  entry with the same path in another case on Windows. An entry holding only `mcpServers` is
  read as is. 2.1.296 moves non-empty `enabledMcpjsonServers`, `disabledMcpjsonServers` and
  `enableAllProjectMcpServers` of an entry into the project's `.claude/settings.local.json` when
  it starts ("legacy approvals"), and its approval dialog writes them there; pull still restores
  the two lists into the entry, which that move then carries into the settings file.
- Read from the Claude Code 2.1.296 program (T106): each account folder in `plugins/synced/`
  is `<org-uuid>_<account-uuid>` (`unbound` without an account; `.staging` and `.trash` are
  not accounts). Its `manifest.json` is `{lastUpdated, plugins?, staleDirs?}`, an entry with
  `pluginId`, `name`, `description`, `version`, `updatedAt`, `marketplaceName`,
  `installationPreference`, and optional `requestedVersion`, `presentsAs` and `generation`
  (a whole number of 2 or more; a wrong type counts as absent). `.marketplaces.json` beside
  it is an object `{etag?, parserVersion?, rows}` (a bare list of rows still reads), a row
  with `name`, `display_name`, `scope?` (`org`, `default`, `account`; absent means
  agentnomad cannot tell), `source`, `id?` and `updated_at`; the `.marketplace-<id>.json`
  files there are not read. A plugin's folder is `<name>`, or `<name>~g<N>` from
  `generation` 2, with the sidecar `<folder>.meta.json`. Claude Code loads it as
  `<name>@synced`. A manifest or list in any other shape makes push save nothing for that
  account and say why.
- A mod's `hooks/hooks.json` is `{"modules": ["./register.ts"]}`; module paths are read from
  the `hooks/` folder (`hooks/register.ts`). A module exports `register(on, options)` and each
  hook takes `$` first (`on("session.start", async ($, e) => …)`); a module that calls no `$`
  method is listed as `calls: nothing on $`. A module error is an entry error named
  `modules../register.ts` (checked on 2.1.296, T97).
- Running `claude` rewrites the settings of the config folder it uses (2.1.296 turned
  `"model": "opus"` into `"opus[1m]"`), so pull runs validate with an empty
  `CLAUDE_CONFIG_DIR` of its own (T97).
- Claude Code 2.1.296 cannot install a chosen version of a plugin (T100): `claude plugin
install` has no version option, and `name@marketplace@1.0.0` installs the marketplace's
  current version all the same (the `@1.0.0` is ignored, exit 0). A marketplace `#ref`
  (saved in `plugins.json` when the user added it so) fixes the whole catalog, not one
  plugin, and a version or sha in a marketplace entry is the marketplace author's choice.
  `installed_plugins.json` records each install's `version`: the manifest's, else the
  entry's, else a 12-character commit or digest, `unknown` for npm and local folders. So
  push saves the versions in `plugin-versions.json`, and pull installs the latest and names
  each change.
- `claude plugin marketplace add <folder>` (2.1.296, checked with an empty
  `CLAUDE_CONFIG_DIR`, T98) names the marketplace from its `.claude-plugin/marketplace.json`,
  records it in `known_marketplaces.json` as `{"source": {"source": "directory", "path":
<absolute folder>}, "installLocation": <the same folder>}`, and also writes it into
  `settings.json` `extraKnownMarketplaces` with the same absolute path. Adding the same name
  from another folder repoints both ("was already added from dir:… and now points at
  dir:…"), so pull's `marketplace add` with the folder it wrote corrects a path the synced
  `settings.json` brought from the other PC. Push saves the folder's files (T98), as nothing
  else on the other PC has them.
- `env.CLAUDE_CODE_PLUGIN_DIRS` (read from the 2.1.296 program, T99) is split with Node's
  `path.delimiter` (`;` on Windows, `:` elsewhere); each part is trimmed, `~`, `~/` and `~\`
  are read from home, and a part that is not a full path is skipped with a warning. Each
  folder loads as `<name>@inline`, as `--plugin-dir` does. Push reads it from the user
  `settings.json` only, saves each folder with T98's rules (`.agentnomad/plugin-dirs/<n>.json`),
  and pull rewrites the value in the `settings.json` it writes to the folders it wrote, with
  this PC's separator; a folder declined in the review is taken out of it. A settings file
  pull did not ask about was the same here, so it is then written with a backup, unasked.
  `--plugin-dir` and SDK plugins are given to one run and written nowhere, so they cannot be
  seen and are not handled.
- Claude Code loads mods from 2.1.287 (its changelog: "Added Claude Mods: plugins may now
  modify deeper behavior"), `plugins.modsSince` in the data file; pull warns, naming the mods,
  when this PC's Claude Code is older (T103), also those in saved local marketplaces and
  plugin folders (T104).
- While a session develops a mod, Claude Code keeps it in `dev-mods/<session-id>/<mod-name>/`
  in the base folder and its cleanup deletes it after `cleanupPeriodDays` (seen in the 2.1.296
  program, T103). The folder is known state, never pushed; push names each mod in it.
- Every plugin source and what push and pull do with it, as one list, is in the README
  ("Where plugins come from"); the cross-OS e2e steps run a local marketplace with a mod,
  a mod in `skills/` and two `CLAUDE_CODE_PLUGIN_DIRS` folders through each chain (T104).

**Keeping up with Claude Code:** files Claude Code adds that the data file does not know
are reported on push (a folder holding a script the hooks or status line run is not: push saves
that script; `hooks/` is synced whole, T112), and a script the hooks or status line run that
push cannot take (outside the home folder, or for a project outside it; in a never-synced or
known-state folder; in a folder for keys and logins or one whose files run by themselves) is
named in push's left-out list, never skipped in silence (T112); the Claude Code version is
stamped in every bundle; and a weekly
drift check (`.github/workflows/drift-check.yml`) compares the data file with the newest
Claude Code. It reads the official
[.claude directory docs](https://code.claude.com/docs/en/claude-directory) and the
[settings reference](https://code.claude.com/docs/en/settings-reference), whose "Global
config" keys must equal `claudeJsonPreferenceKeys` (T109; a missing or extra key is a
finding, a page without the table fails the run), runs a fresh
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

### Choices and flags

Every decision a command can ask, the flags that answer it and what `--yes` does (T115). Keep
this list when adding a question: a new choice gets a flag (an opt-in part gets its pair for
free from `OptionalPart`), its words come from `cli/help-text.ts` or the part, and
`program.test.ts` fails when a flag is missing from the README Flags table, the hint `run.ts`
gives without a terminal, or `cli/commands.ts`.

| Command        | Question                                                                | Flags that answer it                                                    | `--yes`                                                |
| -------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| push           | Which agents?                                                           | `--agent`                                                               | every installed agent                                  |
| push           | What to save? (global, this project, both)                              | `--global`, `--project`                                                 | the global setup                                       |
| push           | Name this project                                                       | `--project <name>`                                                      | (a project is only chosen by `--project`)              |
| push           | Include memory?                                                         | `--memory` / `--no-memory`                                              | no                                                     |
| push           | Each optional part (claude.ai skills and plugins, plugin data)          | `--<part>` / `--no-<part>`                                              | the part's default                                     |
| push           | Which environment values to save                                        | `--env-values <names\|all\|none>`                                       | none                                                   |
| push           | The last pull here did not restore everything: push anyway?             | none (\*)                                                               | skipped, exit 1                                        |
| push           | The saved copy was deleted, or a newer one saved elsewhere: replace it? | none (\*)                                                               | skipped, exit 1                                        |
| push           | Upload it now? (after the summary)                                      | asked only after another question                                       | not asked                                              |
| pull           | Which agents?                                                           | `--agent`                                                               | every agent with a saved setup                         |
| pull           | What to restore? / Which project?                                       | `--global`, `--project <name>`                                          | the global setup                                       |
| pull           | An older copy than this PC had: restore anyway?                         | none (\*)                                                               | skipped, exit 1                                        |
| pull           | New hooks, MCP servers, scripts: allow them?                            | `--allow-commands`                                                      | no                                                     |
| pull           | A file here differs: merge, overwrite, skip (or all remaining)          | `--merge` / `--overwrite` / `--skip-existing`                           | merge                                                  |
| pull           | Add the missing environment values?                                     | `--env-values <names\|all\|none>`                                       | every plain one                                        |
| pull           | Values that load code or redirect requests: add them too?               | `--allow-commands`                                                      | no                                                     |
| pull           | Claude Code is running: closed it, or skip `~/.claude.json`?            | none (\*\*)                                                             | `~/.claude.json` left, with a warning                  |
| pull           | Saved claude.ai skills and plugins, plugin data: add them?              | `--account-skills`, `--account-plugins`, `--plugin-data` (and `--no-…`) | the part's default                                     |
| pull           | A plugin with code: write it? / Reinstall plugins? / Install a program? | `--allow-commands`                                                      | no                                                     |
| pull           | A plugin `claude plugin validate` finds broken: write it anyway?        | none (\*\*\*)                                                           | skipped                                                |
| pull           | Show the source of a module?                                            | none (it only shows)                                                    | not asked                                              |
| pull           | Restore it now? (after the summary)                                     | asked only after another question                                       | not asked                                              |
| delete         | Which saved setups?                                                     | `--agent`, `--global`, `--project`                                      | still asked: `--yes` never deletes every setup unnamed |
| delete         | Delete them? (cannot be undone)                                         | `--yes`                                                                 | yes                                                    |
| register       | No password recovery: continue? Replace the login here?                 | `--yes`; `--username`, `--password-stdin` for the answers typed         | yes                                                    |
| login          | Replace the login here?                                                 | `--yes`; `--username`, `--password-stdin`                               | yes                                                    |
| account delete | Delete the account?                                                     | `--yes` with `--username` and `--password-stdin`                        | yes                                                    |

(\*) No flag on purpose: saying yes replaces what another PC saved, or restores a copy older
than this PC had, so only a person answers it; the way out for a script is `agentnomad pull`
first. (\*\*) A wait for the user to close a program, not a choice of content. (\*\*\*) Only a
person's yes writes a plugin that validate finds broken. `status`, `list`, `agents`, `env` and
`logout` ask nothing. Every flag's help, `--help`'s "What is saved" and "What is restored"
sections, the questions' reasons and the README Commands table come from `cli/help-text.ts`
and the agent's `contents` (Claude Code: `claude-code-contents.data.ts`), and the tests read
the README to keep them the same.

### When a setup is not done

Push and pull also exit with `1` when any setup was **not done**: skipped or refused without
the user answering no themselves. That is a newer copy on the server or one deleted there
(push), a setup whose last pull did not restore everything (push), a setup over the 5 MB limit
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
publishing with provenance (no npm token exists), then check `npx agentnomad` on every OS and make the GitHub release (marked Latest) from `.github/release-notes/vX.Y.Z.md`, which must exist before anything is published. The release starts only for a commit
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

Paths are relative to each package's `src/`. A module's tests are in each package's `test/`,
in the file named after the module (with `claude-code-` in front for the Claude Code adapter's
files, e.g. `agents/claude-code/restore-rules.ts` → `claude-code-restore-rules.test.ts`;
`claude-code-adapter.test.ts` and `claude-code-paths-data.test.ts` for the adapter and its data
file, `claude-code-drift.test.ts` for `scripts/drift/drift.ts`). Every other test file is one
of these:

- **A folder of small modules:** `ui.test.ts` (`ui/`: the clack answers, `printable`,
  `formatSize`), `secret-store.test.ts` (`secrets/`), `env.test.ts` (`env/`, except
  `loader-variables.test.ts`), `system.test.ts` (the real programs the CLI runs: the process
  list, `icacls`, PowerShell, and starting `claude plugin` through a stand-in `.cmd` launcher;
  `system/json.ts` has `json.test.ts`), the
  server's `repositories.test.ts` (the `db/repositories.ts` contracts, run against the user,
  session and bundle repositories) and `schema.test.ts` (`db/schema.ts` and the migrations),
  contracts' `api.test.ts` (`api/`) and core's `interfaces.test.ts` (the interface types).
- **A whole command, the program or the API through several modules,** named after what it
  runs: `pull-command.test.ts`, `push-command.test.ts`, `setup-commands.test.ts`,
  `auth-commands.test.ts`, `program.test.ts` (parsing, routing and exit codes),
  `bin.test.ts` (the built executable), `agent-boundary.test.ts`, the server's
  `account-routes.test.ts`, `auth-routes.test.ts`, `bundle-routes.test.ts` and
  `limits-and-logs.test.ts`, and e2e's `cross-os.test.ts` (the steps of `steps.ts` against
  `local-server.ts`).
- **Tested through the code that uses them,** with no test file of their own:
  `push/bundle-files.ts` and `cli/project-folder.ts` (`push-command.test.ts`,
  `pull-command.test.ts`), `cli/flags.ts` (`program.test.ts`), `api/api-errors.ts`
  (`http-api-client.test.ts`, `error-messages.test.ts`), `agents/shared/file-gathering.ts`,
  `bundle-paths.ts` and the adapter's `global-paths.ts` and `project-paths.ts` (the collector
  and restore-rules tests), `agents/shared/detector-system.ts` (`claude-code-detector.test.ts`,
  `claude-code-programs.test.ts`), `env-files.ts` (`env.test.ts`) and `reviewed-settings.ts`
  (`claude-code-command-review.test.ts`, `claude-code-restorer.test.ts`).
- **Shared set-up, not tests:** `fakes.ts` (tested by `fakes.test.ts`; it also holds the CLI
  tests' one temporary-folder hook and their crypto service and data key), `stub-restorer.ts`,
  `claude-code-project-fixtures.ts`, `claude-code-plugin-fixtures.ts` (its plugin source
  fixtures, T96, are tested by `claude-code-plugin-fixtures.test.ts`),
  `claude-code-state-names.ts` (T108), `claude-code-settings-reference.ts` (T109), `readme.ts`
  (the README tables the CLI's words are checked against, T115), core's and contracts'
  `fixtures.ts`, and the server's `support/` (`app.ts`, `database.ts`, `fixtures.ts`).

## `packages/contracts/src`

| File             | Responsible for                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`       | Re-exports everything.                                                                                                                                                                                                                                                    |
| `encoding.ts`    | Base64, hex and comparing bytes with web-standard APIs; the one copy every package uses (T62).                                                                                                                                                                            |
| `primitives.ts`  | Shared building blocks: the control-character check, base64 of an exact length or of at most a size, SHA-256 hex, timestamps, short single-line text.                                                                                                                     |
| `bundle.ts`      | The plaintext bundle format: format version, agent id, scope, source OS, agent version, revision, files (at most 10,000, no path twice); safe relative paths; project name rules.                                                                                         |
| `api/common.ts`  | Crypto byte sizes, the 5 MB bundle cap, what one account may keep (100 setups, 50 MB), route paths, custom header names (`x-an-client` too), the bearer scheme, the client version format, error codes, the error body, the wrong-password message and the health answer. |
| `api/auth.ts`    | Usernames, Argon2id settings (defaults and the minimum a server may ask for), prelogin, register, login, session and account-delete bodies.                                                                                                                               |
| `api/bundles.ts` | Scope keys (`global` or a project's keyed hash), the path params, the bundle list query and response (cursor, at most 100 a page), upload headers and answer, download headers.                                                                                           |
| `api/answers.ts` | `ClientAnswerSchemas`: the tolerant forms of every answer, built from the strict schemas' shapes; what the CLI parses answers with (T57).                                                                                                                                 |

## `packages/core/src`

| File                   | Responsible for                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`             | Re-exports everything.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `crypto.ts`            | The crypto interfaces (`PasswordKdf` and the `DerivedKeys` it returns, `Aead`, `KeyedHash`, `Digest`, `RandomSource`, `CryptoService`), `AEAD_KEY_BYTES` (the size of every key `Aead` takes) and `DecryptionError`.                                                                                                                                                                                                                                              |
| `sodium-crypto.ts`     | The implementation on libsodium: Argon2id (the password bytes are wiped once used), splitting the master key, XChaCha20-Poly1305, keyed BLAKE2b, SHA-256.                                                                                                                                                                                                                                                                                                         |
| `envelopes.ts`         | Wrapping the data key; sealing and opening bundles bound to format version, agent and scope key.                                                                                                                                                                                                                                                                                                                                                                  |
| `project-names.ts`     | Scope keys (keyed hash of a project name; `scopeKeyFor` gives `global` for the global setup) and encrypted project names.                                                                                                                                                                                                                                                                                                                                         |
| `bundle-codec.ts`      | The `BundleCodec` interface (bundle ↔ bytes) and `BundleFormatError`.                                                                                                                                                                                                                                                                                                                                                                                             |
| `gzip-bundle-codec.ts` | JSON + gzip, with the 64 MB decompression cap and a schema check.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `paths.ts`             | The `PathResolver` interface, `{{HOME}}`, `PathError`, and `sourceOsOf` (a platform as a bundle source OS).                                                                                                                                                                                                                                                                                                                                                       |
| `path-resolver.ts`     | Portable paths: bundle path ↔ native path per OS, home folder ↔ `{{HOME}}` in file contents, Windows name rules.                                                                                                                                                                                                                                                                                                                                                  |
| `merge.ts`             | The `MergeStrategy` interface: plans writes for one conflicting file, never touches disk.                                                                                                                                                                                                                                                                                                                                                                         |
| `merge-strategies.ts`  | JSON merge by key (a file a merge would change a number in is kept side by side), text "keep yours, add theirs next to it", overwrite with a timestamped backup; `selectMergeStrategy` picks one per file from the `MergeChoices` a restorer passes (the first of its merges that applies, else side by side), so a new format is one more strategy in that list; `backupStamp`, the one backup time stamp; the backup and incoming name markers collectors skip. |

## `packages/cli/src`

### Entry and wiring

| File         | Responsible for                                                                                                                                                                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin.ts`     | The `agentnomad` executable: chooses the prompter (terminal or none), runs the CLI with the handlers, the agents' optional parts and what their setups hold (T115), sets the exit code.                                                                                                                                                            |
| `app.ts`     | Composition root: `createAppRegistry` (every adapter), `createApp` (the handlers, the adapters' optional parts for the flags and `agents`, what each adapter's setups hold for `--help`, T115), and the API client, secret store, crypto and local state, each only when first used; `deviceNameOf`, the device name in the server's session list. |
| `index.ts`   | Re-exports the package for tests.                                                                                                                                                                                                                                                                                                                  |
| `version.ts` | The version `--version` prints (kept equal to package.json).                                                                                                                                                                                                                                                                                       |

### `cli/`: parsing and outcomes

| File                | Responsible for                                                                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands.ts`       | The option types for every command and the `CommandHandlers` interface; `EnvValuesChoice`, what `--env-values` gives (T115).                                                                                                                                           |
| `program.ts`        | Every command, flag and help text (commander); parsing only. The optional parts' flags come from the adapters; push's and pull's "What is saved" and "What is restored" help sections from `help-text.ts` and the adapters' `contents` (T115).                         |
| `help-text.ts`      | One source for the CLI's words (T115): `COMMAND_HELP` (what each command does, also the README Commands table), `FLAG_HELP`, `QUESTION_REASON` (why push and pull ask), `CONTENT_GROUPS` and `contentsHelp` (the help sections), `ENV_VALUES_ALL` / `ENV_VALUES_NONE`. |
| `project-folder.ts` | The home folder and the agent's own folder are never a project (push, pull and `env`); `checkProjectFolder` is the check push and pull share.                                                                                                                          |
| `flags.ts`          | Validating `--agent`, `--project`, `--username` and `--env-values` (`parseEnvValues`, T115) values.                                                                                                                                                                    |
| `run.ts`            | Runs one invocation: exit codes, Ctrl+C, and the "needs an answer" message with the flags per command.                                                                                                                                                                 |
| `setup-outcomes.ts` | What happened to each setup in push and pull, the one "Not saved / Not restored" error (exit 1), and `setupLabel`, how every message names a setup.                                                                                                                    |
| `error-messages.ts` | The one line shown when a command fails (rate limits, server errors).                                                                                                                                                                                                  |
| `stdin.ts`          | `--password-stdin`: the first line of a pipe; refuses a terminal.                                                                                                                                                                                                      |

### `ui/`: questions and messages

| File                      | Responsible for                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompter.ts`             | The `Prompter` (questions) and `Reporter` (messages, spinners) interfaces.                                                                                                            |
| `clack-prompter.ts`       | Both on @clack/prompts; warnings and errors to stderr; plain spinners without a terminal.                                                                                             |
| `no-terminal-prompter.ts` | The prompter for scripts: every question fails with `AnswerNeededError`.                                                                                                              |
| `counting-prompter.ts`    | `countingPrompter`: a prompter that counts the questions asked, so push and pull ask their summary question only after asking something (T115).                                       |
| `format-size.ts`          | Sizes as `5 KB` or `1.2 MB`, for push and `list`; `formatSizeOver`, a size over a limit never shown equal to it (UX-06).                                                              |
| `printable.ts`            | `printable` and `printableLine`: text from a bundle or the server shown with escape sequences, direction marks and (for review lines) line breaks escaped, never acted on (T44, T71). |

### `api/`: talking to the server

| File                 | Responsible for                                                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-client.ts`      | The `ApiClient` interface (auth and bundle calls); `logout(token)` ends a given session in one attempt (T66).                                                                                                                                                              |
| `http-api-client.ts` | The implementation on `fetch`: timeouts sized to transfer size, the wake-up check, contract validation of every answer (unknown fields and error codes tolerated), the `x-an-client` version header, SHA-256 check of downloads, no retry for register and account delete. |
| `transport.ts`       | One HTTP call with timeout and retries (network errors, timeouts, 502/503/504 only, with growing waits plus jitter), `Retry-After` read as whole seconds, capped body reads, redirects refused.                                                                            |
| `api-errors.ts`      | `ApiError`, `NetworkError`, `OutcomeUnknownError`, `InvalidResponseError`, `NotLoggedInError`.                                                                                                                                                                             |
| `api-url.ts`         | The server address: `AGENTNOMAD_API_URL` or the hosted API; https only (http for localhost).                                                                                                                                                                               |

### `auth/`: accounts

| File                 | Responsible for                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-commands.ts`   | `register`, `login`, `logout`, `account delete`, with the flags for scripts. `withDerivedKeys` wipes both password keys on every path; the data key is wiped the same way. |
| `local-session.ts`   | Saving, reading and clearing the session token and data key; `withSession` turns an expired session into a clear message.                                                  |
| `password-policy.ts` | 12–256 characters and a zxcvbn-ts score of 4, username used as a hint.                                                                                                     |

### `secrets/`, `config/`, `state/`: what stays on the PC

| File                             | Responsible for                                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secrets/secret-store.ts`        | The `SecretStore` interface; `setMany` saves a whole login in one write.                                                                                                |
| `secrets/keychain-store.ts`      | The OS keychain through @napi-rs/keyring (Linux pinned to Secret Service).                                                                                              |
| `secrets/file-store.ts`          | The user-only file fallback, written with the shared atomic write; on Windows `icacls` leaves only the current user any access (file modes there only control writing). |
| `secrets/create-secret-store.ts` | Picks the keychain when it works, else the file; moves a login left in the file into it.                                                                                |
| `config/config-dir.ts`           | agentnomad's folder: `%APPDATA%\agentnomad` or `$XDG_CONFIG_HOME` / `~/.config/agentnomad`.                                                                             |
| `state/local-state.ts`           | `state.json`: project names per folder, known revisions and their account, which pulls did not restore everything (`#partial`), per server.                             |

### `system/`: files and programs, one copy each (T62)

| File                    | Responsible for                                                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system/files.ts`       | `writeFileAtomically` (temporary file, then rename; mode, folder mode, following a link, a step before the rename), `TEMP_MARKER` (its temporary files, which collectors skip), `writeTargetOf`, `isMissing`, `isFile`, `isDirectory`, `exists` and `freeSuffix` (the first free `-2`, `-3`, … of backups). |
| `system/paths.ts`       | `samePath` and `pathKey`: folders compared per OS (Windows ignores case).                                                                                                                                                                                                                                   |
| `system/json.ts`        | `parseJsonWith`: JSON text or bytes checked with a schema, the value or why it could not be read; `valueOrNull` when the reason does not matter. `JsonObjectSchema`: any JSON object, values unchecked; `isJsonObject` and `strings` (DUP-02).                                                              |
| `system/run-program.ts` | `runProgram`: one `execFile` wrapper (no shell, timeout, never rejects) for every program the CLI starts.                                                                                                                                                                                                   |

### `push/`, `pull/`, `commands/`: the setup commands

| File                         | Responsible for                                                                                                                                                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `push/push-command.ts`       | `push`: a plan step (choose, collect, every question; `--env-values` answers which values) and an apply step with no prompter (encrypt, upload). When the plan asked anything, the summary and `Upload it now?` come between them (T115). The saved summary adds the adapter's notes on the saved files (T97). |
| `push/push-summary.ts`       | `pushSummary` and `uploadQuestion`: what push shows and asks before uploading, per setup under `push --help`'s headings; `ChosenContent`, one choice in it (T115).                                                                                                                                             |
| `push/bundle-files.ts`       | Collected files ↔ bundle entries (UTF-8 with `{{HOME}}` or base64); keeps local files that only differ in slash style; `localPathResolver`, the path rules both use on this PC.                                                                                                                                |
| `pull/pull-command.ts`       | `pull`: a plan step (choose, download, verify, every question, the agents' own ones too; `--skip-existing` and "Skip all remaining files" leave files as they are), an apply step with no prompter. When the plan asked anything, the summary and `Restore it now?` come between them (T115).                  |
| `pull/pull-summary.ts`       | `pullSummary` and `restoreQuestion`: what pull shows and asks before writing, per setup: files, what happens to the ones that differ, the values it adds (T115), and the agent plan's file count and choices (`AgentRestorePlan.summary`, UX-01).                                                              |
| `pull/saved-setups.ts`       | Listing setups with decrypted names, every page (stopping at a repeated cursor or a page limit); the revisions push checks against; downloading and checking one (agent, scope, sealed revision).                                                                                                              |
| `commands/setup-commands.ts` | `list`, `status` and `delete`; `timeAgo`, how long ago a setup was saved.                                                                                                                                                                                                                                      |

### `env/`: environment variables in setups

| File                  | Responsible for                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env-references.ts`   | `scanEnvReferences`: the `${VAR}` references in the files the adapter names (its `envReferences`) and where each is used, leaving out the agent's own variables and never reading a value; `mergeEnvScans` joins scans.                                                                                                                                                         |
| `env-section.ts`      | The encrypted `.agentnomad/env.json` section and choosing which values to save (opt-in; `--env-values` answers instead, `--yes` alone saves none, T115); `ENV_NAME`, the variable names it accepts.                                                                                                                                                                             |
| `env-restore.ts`      | On pull: adding saved values that are missing here (not in the environment nor already written); asking (plan) and writing (apply) are separate; `--env-values` answers which to add, never past the gate for values that load code or redirect requests (T115). `warnNotSaved`: names `--env-values` gives that the setup does not hold, also when it saved no values (UX-05). |
| `shell-profile.ts`    | Writing them, and reading back what is there: a marked block in the shell profile (sh, bash, zsh, fish), rewritten only when it changes after a backup that never replaces another, or Windows user variables through one PowerShell call for all of them.                                                                                                                      |
| `loader-variables.ts` | `LOADER_VARIABLE`: the variables that make a shell or runtime load or run code (`NODE_OPTIONS`, `LD_*`, ...); a saved value for one is treated like a hook (T44, T55). Names are matched upper-cased: Windows reads `node_options` as `NODE_OPTIONS` (SEC-05).                                                                                                                  |
| `env-command.ts`      | `agentnomad env`.                                                                                                                                                                                                                                                                                                                                                               |

### `agents/`: the plug-in layer

| File                | Responsible for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter.ts`        | The adapter interfaces: `Detector`, `Collector`, `Restorer`, `AgentInspector`, `AgentAdapter`, `AgentRegistry`, the types they share, `ChosenAgent` for push and pull, and `RESERVED_DIR` (`.agentnomad`, the bundle folder for entries that are not the agent's own files). `AgentInspector.pushNotes` and `AgentRestorePlan.declined` (T97); `RestorePlanContext.askConflict`, pull's conflict question for files an agent writes outside its folders (T98). `AgentInspector.versionNotice` gets the setup's files too (T103: mods on an older Claude Code). `AgentContents` and `AgentAdapter.contents`: what a setup always and never holds, for `--help` (T115). `AgentRestorePlan.summary`: the files a plan writes and its questions' choices, for pull's summary (UX-01). |
| `registry.ts`       | `createAgentRegistry`: the list of adapters, by id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `notices.ts`        | What commands say about any agent: comparing versions for pull's warning, files an adapter does not know, and `showNotices` (each notice once).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `agents-command.ts` | `agentnomad agents`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### `agents/shared/`: helpers for every adapter

| File                 | Responsible for                                                                                                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detector-system.ts` | What a detector reads from this PC (`DetectorSystem`, `nodeDetectorSystem`), `pathsOf` (the path rules of a platform) and `findExecutable`, which searches PATH like a shell and takes only `ExecutableLookupSystem` (platform, home, env, `isExecutable`).                                         |
| `file-gathering.ts`  | Reading files and folders into bundle entries: links followed once, never into a folder for keys and logins (and for a project, never out of it), files over 10 MB left out and reported, the adapter's clutter names, agentnomad's copies and leftover temporary files skipped.                    |
| `bundle-paths.ts`    | `underFolder`: whether a bundle path is a folder or inside it, with or without case, and `underAnyFolder` for a list of folders; `inHomeFolder` and `isSensitiveHomePath`: whether a path from the home folder is in a given folder, or in a folder for keys and logins (any case). No file access. |

### `agents/claude-code/`: the Claude Code adapter

| File                                  | Responsible for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code-adapter.ts`              | Assembles the adapter from the parts below, with its optional parts `account-skills` (T42), `account-plugins` (T101) and `plugin-data` (T102, written after the follow-up). Its plan step adds the saved claude.ai plugins and skills the user agreed to as `skills/<name>/` (SEC-03), then reviews plugin folders in `skills/` before anything is written (T97; `pluginValidator` replaces `claude plugin validate` in tests), then plans the saved local marketplaces (T98) and plugin folders (T99), written before the setup, with `CLAUDE_CODE_PLUGIN_DIRS` in the `settings.json` it writes naming the plugin folders pull wrote. `versionNotice` adds the mods warning; its push notices name the mods in `dev-mods/` (T103); `pushNotes` and the plan step name a project's part of `~/.claude.json` (T109), which also asks to close Claude Code. The plan it returns carries a `summary` for pull: the files it writes and one line per choice, e.g. `--account-plugins yes (notes)` (UX-01). |
| `claude-code-paths.data.ts`           | **The data file:** every list of what to sync, skip or refuse, schema-checked; `settingsFilesIn` picks the settings files out of a list. `plugins.generatedInPlugin`: what Claude Code generates in a plugin (T97); `plugins.runsCode`: the plugin parts it starts programs from (SEC-02). `plugins.modsSince`: the first Claude Code that loads mods, `plugins.devMods`: mods in development, known state too (T103). `plugins.store.maxNameLength`: where a store file's name is cut (T107). `global.neverSynced` and `global.knownState` hold every state name the Claude Code 2.1.296 program lists for its folder (T108). `claudeJsonPreferenceKeys`: the 12 "Global config" keys of the settings reference; `claudeJsonProjectKeys`: what a project's entry in `~/.claude.json` gives (T109). `global.files` and `project.claudeFiles` hold `loop.md` (T113).                                                                                                                                     |
| `claude-code-contents.data.ts`        | `CLAUDE_CODE_CONTENTS`: what a Claude Code setup always and never holds, in the words of `push --help`, `pull --help` and the README "What is synced" table, item for item (T115; a test reads the README).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `global-paths.ts`, `project-paths.ts` | Named views of the data file for the global and project collectors, including each scope's settings files (`globalSettingsFiles` picks them out of a list of global files); the reserved bundle paths (`claude.json`, `claude-json-project.json` with `CLAUDE_JSON_PROJECT_KEYS`, T109, `plugins.json`, `programs.json`, home scripts, saved claude.ai skills and plugins, auto memory, `LOCAL_MARKETPLACES_PREFIX`, T98, `PLUGIN_DIRS_PREFIX`, T99), which extensions are scripts, the tool settings files' bundle paths (`TOOL_SETTINGS_BUNDLE_PATHS`), and `homePathProblem` (home folders never read or written: keys and logins, or files that run by themselves). `global-paths.ts` has no file access (a lint rule checks it).                                                                                                                                                                                                                                                                   |
| `detector.ts`                         | Finding `claude` and its version; the base folder (`CLAUDE_CONFIG_DIR`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `env-files.ts`                        | Which files hold `${VAR}` references (MCP servers, settings, a project's part of `~/.claude.json`, T109), the variables Claude Code sets itself, and the `~/.claude.json` labels.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `settings-commands.ts`                | Parsing settings and command lines: the commands a `settings.json` runs as the words each program gets (hooks read one by one, so a malformed one hides no other; exec form keeps each `args` element whole), the words that can name a script (`pathWords`: also inside a command line a word carries, such as `bash -c "a.sh; b"`, at any depth, and split on shell operators) and the program. No file access (a lint rule checks it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `global-collector.ts`                 | Collecting the global setup, `~/.claude.json` keys (read with `readClaudeJsonFile`), hook scripts, tool settings, programs, plugins, local marketplaces (`findGit`, T98), plugin folders the user settings load (T99), with memory the auto memory of every project (T110), and on request the user's claude.ai skills and plugins and the data of the plugins it restores (T102). Names each hook script it cannot take (T112).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `project-collector.ts`                | Collecting a project's setup, its part of `~/.claude.json` (T109; keyed by the main repository's root, BUG-02; `customConfigDir` says where that file is) and, when chosen, its auto memory and local marketplaces (`findGit`, T98); names each hook script it cannot take (T112); `collectMemoryFolder`, the Markdown notes of one auto memory folder, shared with the global collector (T110).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `hook-scripts.ts`                     | Which scripts the hooks and status line run, for the global setup and for a project: what push collects and pull allows back (one rule for both). Each script they cannot take goes to an optional `SkippedScript` with why (T112); `onceEachScript` tells each script once per push.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `account-skills.ts`                   | claude.ai skills (T42): reading `skills/synced/` (the user's own: `creatorType: user`, or from Claude Code 2.1.295 (checked on 2.1.296) `source` `custom` or `plugin` from an `account` marketplace, T105, read through `synced-plugins.ts`), with a `notice` of those left out (also an unusable name or a missing folder, UX-03), saving a copy, `planAccountSkills` and `askAccountSkills` (what pull may add as local skills, asked in the plan step with the saved plugins, SEC-03), `reportAccountSkills` (what it added); `isUsableSkillName` (a safe folder name in `skills/`, not a reserved one).                                                                                                                                                                                                                                                                                                                                                                                             |
| `account-plugins.ts`                  | claude.ai plugins (T101): `readSyncedPlugins` (the user's own in `plugins/synced/`: an `account` marketplace, not `required` or `auto_install`, with a plugin manifest in its `syncedPluginFolder`; a `notice` of those left out), `collectAccountPlugins` (one `.agentnomad/account-plugins/<name>.json` each, UX-02), `planAccountPlugins` and `askAccountPlugins` (what pull may add as `skills/<name>/`, asked in the plan step; the folder layout of older bundles is read too), `namesHere` and `localSkillNames` (names a saved skill or plugin must not take).                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `account-copies.ts`                   | What saved claude.ai skills and plugins share on pull (DUP-01): `savedCopiesIn`, `planSavedCopies` (never one this PC syncs, never over a local folder), `askSavedCopies` (the list and the question, yes by default, T114), `filesInSkills`, `NamesHere`, `NAME_NOT_A_FOLDER`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `synced-plugins.ts`                   | `plugins/synced/<account>/manifest.json` and `.marketplaces.json` (`readSyncedPluginsOf`: each plugin with its marketplace's scope, `installationPreference`, `presentsAs` and `generation`, or `no list` / `unreadable`; the 2.1.296 shapes, T106), `syncedPluginFolder` (`<name>` or `<name>~g<N>`), `NOT_OWN_SCOPES`; one reader for account skills (T105) and account plugins (T101).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `auto-memory.ts`                      | Finding a project's auto memory folder the way Claude Code does; for a global push every project's (`allAutoMemoryFolders`, T110), the shared folder `autoMemoryDirectory` in user settings names (`findSharedAutoMemory`, also from the pulled settings), and push's note when it saves that one (`sharedMemoryNote`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `restore-rules.ts`                    | Where each bundle entry may go, or why it is refused (a project's part of `~/.claude.json` is merged like the global one, T109; a global bundle's auto memory as `global-auto-memory`, T110); `isPullMetadata`, an entry pull reads and never writes as it is (a saved local marketplace, T98, or plugin folder, global only, T99). No file access (a lint rule checks it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `restorer.ts`                         | Writing a setup: atomic writes, permissions, line endings (`lineEndingsFor`, and `sameForRestore` leaves a script that differs only in them alone), conflicts; names Windows cannot hold refused with core's `windowsNameProblem`; what pull asks first; `claudeJsonChange(files, target)`, what a part of `~/.claude.json` would change (a project's, T109); `hooksForOtherOs`, the hooks that will likely not run on this OS; `restoreFolder`, a folder of its own with the same answers and backups, never into `.git` (T98). A project's auto memory note replaces, without asking, the one the global setup wrote in the same pull (T110).                                                                                                                                                                                                                                                                                                                                                         |
| `claude-json-merge.ts`                | The `~/.claude.json` merge: only MCP servers and preferences, or a project's servers and `.mcp.json` choices into its entry (T109; its main repository's root, BUG-02), a backup first, never while Claude Code runs; `ClaudeJsonError`. Shared with the collectors (T109): `claudeJsonFileOf` (where the file is), `readClaudeJsonFile`, `projectKeyOf` (a folder's key, as Claude Code writes it), `projectClaudeJson` (an entry's part), `claudeJsonProjectNote` (what push and pull say about it, each name on one line, SEC-06), `isClaudeJsonPath`, `claudeJsonQuestion` and `claudeJsonProjectQuestion` (names what it adds, why it asks and the default).                                                                                                                                                                                                                                                                                                                                       |
| `command-review.ts`                   | Finding what runs programs (hooks and the addresses they send to, the status line, command settings, loader variables in `env`, permission and redirect settings, the login gateway, MCP servers, also a project's in `~/.claude.json`, and its `.mcp.json` servers approved there, T109, the scripts they run, and skills, commands and subagents with commands that run by themselves) and which are new or changed on this PC. An entry that cannot be read is shown as unreadable. `describeServer` (an MCP or LSP server or a monitor as shown, also by the plugin review, SEC-02). No file access (a lint rule checks it).                                                                                                                                                                                                                                                                                                                                                                        |
| `runnable-markdown.ts`                | What in a skill, command or subagent file runs by itself (a `` !`command` `` placeholder, a ` ```! ` block, `hooks` in the frontmatter); used by the review and by `account-skills.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `reviewed-settings.ts`                | The settings keys and `env` names the review watches (command, loosening and redirect settings; `LOGIN_GATEWAY_SETTING`, the gateway `/login` signs in to, T107); the drift watch list. The `$` calls of a mod's module the plugin review flags (`riskOfCall`, T97; the calls that run tools, commands, subagents or MCP servers, change settings or the environment, or send prompts, SEC-04, checked against the 2.1.296 program's list, test fixture `MOD_CALLS`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `running-claude.ts`                   | Is Claude Code (or the Claude app) running (command lines)?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `plugins.ts`                          | Reading installed plugins and marketplaces into `.agentnomad/plugins.json`, and their installed versions into `.agentnomad/plugin-versions.json` (`pluginFiles` builds both for the two collectors; `readPluginVersions` also reads the versions back after a pull installs; `readSavedPluginVersions` checks a saved one; T100); the entry schemas push and pull both check; the one reader of `installed_plugins.json`; `marketplaceAddArgument` (a GitHub repository or a git or https URL; never a local folder); `readKnownMarketplaces`, `readLocalMarketplaces` (marketplaces added from a folder with a plugin installed in scope, T98), `MarketplaceNameSchema` and `PluginEntrySchema`.                                                                                                                                                                                                                                                                                                       |
| `skills-dir-plugins.ts`               | Plugins and mods in `skills/` (T97), on bundle paths with no file access (a lint rule checks it): `isGeneratedInSkillsPlugin` (never pushed, never written) and `isGeneratedInPlugin` (the same rule on a path inside a plugin, for saved claude.ai plugins), `PLUGIN_MANIFEST`, `skillsPluginFolders` (`<name>@skills-dir`, a mod when it has `hooks/hooks.json`), `skillsPluginsNote` (push's summary). `modsVersionNotice` (pull's warning when this PC's Claude Code is older than mods, T103; also given the mods of saved folders, T104).                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `dev-mods.ts`                         | Mods in development in `dev-mods/<session>/<mod>/` (T103): `readDevMods` (two levels down, each once) and `devModsNotice` (push's notice naming each, to move it to `skills/` or a marketplace).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `plugin-review.ts`                    | The pull review of a plugin folder, one implementation for T97, T98, T99 and T101: `findPluginValidator` (`claude plugin validate --json` on a copy in a temporary folder of its own, with an empty `CLAUDE_CONFIG_DIR`), `reviewPluginFolder` (modules with their `hooks:`, `calls:` and `env`/`state writes:`, risky calls, command hooks of `hooks/hooks.json` and `plugin.json`, and what Claude Code starts by itself: MCP and LSP servers and monitors, SEC-02), `askPluginFolders` (the gate) and `pluginFolderChange`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `plugin-data.ts`                      | Plugin data (T102): `pluginDataFolder` and `pluginStoreFile` (the names from a plugin id), `restoredPluginIds` (the plugins a global setup restores), `idsWithPluginData`, `collectPluginData` (push: by name only, a size limit), `planPluginData` (pull: the question, the conflicts, then writing for plugins installed here; the answer also goes to pull's summary, UX-01), `PLUGIN_DATA_PART`; its bundle folders are `PLUGIN_DATA_PREFIX` and `PLUGIN_STORE_PREFIX` in `global-paths.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `local-marketplaces.ts`               | Marketplaces added from a local folder (T98): `localMarketplaceFiles` (push: one `.agentnomad/local-marketplaces/<name>.json` each, only what git lists in a repository, the remote and commit when the commit is on the remote, a size limit), `planLocalMarketplaces` (pull: where each folder goes, the T97 review, the conflict questions, then the re-clone and the writes), `readSavedLocalMarketplace`, `savedMarketplaceMods` (their mods, T104) and `findGit` (`git` that never waits for an answer). Shared with T99: `saveFolder` (push) with `SAVED_FOLDER_SHAPE` and `savedFilesOf`, and for pull `homeFolderFor` (checks every file from home, SEC-01), `savedFolderFiles`, `askFolderConflicts` and `writeFolders` (re-clone, then the files).                                                                                                                                                                                                                                           |
| `plugin-dirs.ts`                      | Plugin folders `env.CLAUDE_CODE_PLUGIN_DIRS` names in the user settings (T99): `pluginDirFiles` (push: one `.agentnomad/plugin-dirs/<n>.json` each with `saveFolder`), `planPluginDirs` (pull: where each folder goes, the T97 review, the conflict questions, the writes, and `withPluginDirs`, the settings with the value rewritten), `readSavedPluginDir`, `savedPluginDirMods` (the saved folders that are mods, T104), `splitPluginDirs` and `pluginDirsSeparator`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `plugin-sync.ts`                      | Reinstalling what is missing with `claude plugin` commands: the questions (`askPluginSync`), then the installs (`installPlugins`, which names each plugin installed in another version than the saved one when given a `SavedVersionCheck`, T100); `createProgramCli` runs `claude` and `npm`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `programs.ts`                         | Finding the programs hooks start and whether npm installed them; the `programs.json` entry schema push and pull both check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `after-restore.ts`                    | Pull's follow-up: plugins (with their saved versions, T100, and those of saved local marketplaces, T98) and missing programs; asked in the plan step, installed after writing. The plugin and program choices also go to pull's summary (UX-01). Saved claude.ai skills are planned with the adapter's plan step (SEC-03).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `managed-settings.ts`                 | Detecting organization-managed settings per OS (never synced) and explaining what they block.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `unknown-files.ts`                    | Reporting files in Claude Code's folder that the data file does not know; quiet for every state name of the Claude Code 2.1.296 program (T108, test fixture `claude-code-state-names.ts`), and for folders holding a script a hook runs or a file a memory file imports, global or project (T49, T111, UX-04).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `claude-md-imports.ts`                | `@path` imports in memory files (T111): `importsIn` (fences on CRLF lines too, BUG-01), `resolveImport`, `globalImportPlace` and `projectImportPlace` (where push saves an imported document, or why not), `followImports` (depth first, `MAX_IMPORT_HOPS` deep, push and pull), `isGlobalMemoryFile`, `isProjectMemoryFile` and `PROJECT_MEMORY_FILES`, `shownImportPath` and `skippedImportReason` (push's warning).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## `packages/server/src`

| File                                                                           | Responsible for                                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`                                                                      | Starts the Node web server, logs a crash as one line, and shuts down cleanly on Render's signals.                                                                                                    |
| `server.ts`                                                                    | Production start: settings, Neon pool (its errors logged), keys, then `createApi`.                                                                                                                   |
| `api.ts`                                                                       | `createApi`, the composition root: limiter, services and app from a database (all callers use it), and the housekeeping that runs now and then (expired counters and sessions, unused bundle files). |
| `index.ts`                                                                     | Re-exports for tests and the e2e server.                                                                                                                                                             |
| `port.ts`                                                                      | The port from `PORT` (10000, Render's default, when it is not set).                                                                                                                                  |
| `encoding.ts`                                                                  | Base64url, UTF-8 and SHA-256 for tokens, cursors and uploads; base64 and hex come from contracts.                                                                                                    |
| `db/env.ts`                                                                    | Reading and checking `DATABASE_URL` and `SERVER_SECRET`.                                                                                                                                             |
| `db/schema.ts`                                                                 | The Drizzle tables and their constraints.                                                                                                                                                            |
| `db/database.ts`                                                               | The driver-independent `Database` type (Neon in production, PGlite in tests) and `postgresErrorCode` for both drivers' errors.                                                                       |
| `db/repositories.ts`                                                           | Repository interfaces, their errors and the storage-limit rule.                                                                                                                                      |
| `db/user-repository.ts`, `db/session-repository.ts`, `db/bundle-repository.ts` | Accounts, sessions (token hashes) and bundle metadata in Postgres, with the revision check and the storage limits (one save at a time per account).                                                  |
| `db/bundle-cursor.ts`                                                          | Opaque list cursors, format-checked (a real date and time, a UUID); queries stay scoped to the user.                                                                                                 |
| `storage/blob-store.ts`                                                        | The `BlobStore` interface: encrypted bytes under random ids (R2 later).                                                                                                                              |
| `storage/postgres-blob-store.ts`                                               | The implementation in `bundle_blobs`; sweeps files no setup points to.                                                                                                                               |
| `auth/server-keys.ts`                                                          | Keys from `SERVER_SECRET`: auth-key hashes (constant-time check), fake salts, pseudonyms.                                                                                                            |
| `auth/session-tokens.ts`                                                       | New 256-bit tokens and their hashes.                                                                                                                                                                 |
| `auth/auth-service.ts`                                                         | Prelogin, register, login, logout, account delete, session checks, lifetimes.                                                                                                                        |
| `bundles/bundle-service.ts`                                                    | Listing, downloading, saving (the safe upload order, the upload checks and the storage limits) and deleting setups.                                                                                  |
| `rate-limit/rate-limiter.ts`                                                   | The rules and the `RateLimiter` interface.                                                                                                                                                           |
| `rate-limit/postgres-rate-limiter.ts`                                          | Fixed-window counters in `rate_limits` on the database clock; now and then prunes expired counters (and, through `api.ts`, sessions).                                                                |
| `http/app.ts`                                                                  | The Hono app: request ids, security headers, the request log (with the CLI version), routes, errors.                                                                                                 |
| `http/routes/auth.ts`, `http/routes/bundles.ts`, `http/routes/account.ts`      | The endpoints.                                                                                                                                                                                       |
| `http/session.ts`                                                              | `requireSession`: the bearer token, one identical 401 for every failure.                                                                                                                             |
| `http/validate.ts`                                                             | Parsing bodies, queries, params and headers with the contracts.                                                                                                                                      |
| `http/small-body.ts`                                                           | Size limit for JSON requests.                                                                                                                                                                        |
| `http/rate-limit.ts`                                                           | Per-IP and per-account limits on routes; an IPv6 address counts by its /64.                                                                                                                          |
| `http/errors.ts`                                                               | The standard error body; 500 details only in logs.                                                                                                                                                   |
| `hosting/client-ip.ts`                                                         | The visitor's IP on Render: Cloudflare's `CF-Connecting-IP`, else `True-Client-IP`; never `X-Forwarded-For`.                                                                                         |
| `logging/logger.ts`                                                            | JSON log lines with only safe fields.                                                                                                                                                                |
| `logging/crash.ts`                                                             | An uncaught error or unhandled rejection: one log line, then exit 1.                                                                                                                                 |

Also in the server package: `drizzle/` (SQL migrations) and `drizzle.config.ts`.

## `packages/e2e/src`

| File              | Responsible for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local-server.ts` | The real API (`createApi`) on PGlite on a free local port, loaded from or dumped to a file; records every request.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pc.ts`           | A simulated PC (its own home, config folder and project) that runs the built CLI (or `E2E_CLI`, e.g. the installed npm package) with no terminal; small file helpers.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `steps.ts`        | The three end-to-end steps and what each checks; with them, a gate account's plugins in steps 1 and 2 (T104).                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `fixtures.ts`     | What the steps and the one-OS tests set up alike: the path of the built `fake-claude.ts`, a mod (`writeMod`, its module `MOD_MODULE`) and a marketplace in a folder with that mod (`writeLocalMarketplace`).                                                                                                                                                                                                                                                                                                                                                                 |
| `leaks.ts`        | The check that nothing readable left the PC (T38, T48), for the steps and every one-OS test: `secretsOf` gathers what the logged-in PCs know, `expectNoLeaks` searches every request (`plaintext.ts`) for it, the password, the home folders and the test's own readable strings.                                                                                                                                                                                                                                                                                            |
| `plaintext.ts`    | `plaintextLeaks`: searching every recorded URL, header and body for readable secrets, as text, JSON-escaped, URL-encoded, hex, and base64 or base64url at any alignment, in the body and in what it or a base64 value inside it inflates to (gzip, zlib, raw deflate); `looksCompressedOnly`, an upload compressed but never encrypted.                                                                                                                                                                                                                                      |
| `fake-claude.ts`  | The `claude` command of the PCs that pull (`newPc` option `claude`, first on their PATH): answers `--version`, `plugin marketplace add` (a GitHub repository, or a folder known by its catalog's name, T98), `plugin validate --json` (a report on the folder it is given: its manifest, each module's hooks and `$` calls, exit 1 for a manifest that does not parse, T104) and `plugin install` as Claude Code 2.1.296 does, installing every plugin at 9.9.0, so pull's plugin reinstall and its changed-version line run end to end without the real Claude Code (T100). |

## Repository root

| Path                                    | Responsible for                                                                                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`              | CI: checks on 3 OSes × 2 Node versions, Linux keychain, the npm package installed and run end to end, the cross-OS chains, the dependency audit, the migration check, the coverage and unused-code reports (one job). |
| `.github/workflows/audit.yml`           | Runs `pnpm audit --prod` every Wednesday; a finding fails the run.                                                                                                                                                    |
| `.github/workflows/release.yml`         | Release: verify on every OS, approval, publish to npm with provenance, check `npx` on every OS, GitHub release.                                                                                                       |
| `packages/cli/scripts/build-release.ts` | Builds the `agentnomad` npm package (esbuild bundle + manifest).                                                                                                                                                      |
| `packages/cli/scripts/drift/`           | The weekly Claude Code drift check: `drift.ts` (comparison and report; `docsGlobalConfigKeys`, T109; it watches `plugins.runsCode` too, SEC-02), `check-claude-code.ts` (fetches the sources).                        |
| `.github/workflows/drift-check.yml`     | Runs the drift check every Monday and files or updates the `drift` issue.                                                                                                                                             |
| `render.yaml`                           | The Render service (build, start, health check).                                                                                                                                                                      |
| `knip.json`                             | The unused-code check (`pnpm knip`): workspace entry points (including the e2e fake `claude`, which runs as a child process through the launcher pc.ts writes).                                                       |
| `pnpm-workspace.yaml`                   | Workspace packages and dependency overrides.                                                                                                                                                                          |
| `tsconfig.base.json`, `tsconfig.json`   | Strict TypeScript settings and project references.                                                                                                                                                                    |
| `eslint.config.js`, `vitest.config.ts`  | Lint rules, the test projects and the coverage settings.                                                                                                                                                              |
| `docs/`                                 | This document, the roadmap, the agent guide, decisions and the threat model.                                                                                                                                          |
