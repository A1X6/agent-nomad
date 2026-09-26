# Threat model (T38)

- **Reviewed:** 2026-09-26, at the end of the v1 build (T01–T37), before the first release.
- **Covers:** the `agentnomad` CLI, the API server and its database, and the path in between.
- **Result:** 8 findings, all fixed on the `t38-security-review` branch (see [Findings](#findings)); the
  risks we accept are listed under [Accepted risks](#accepted-risks).

## What is protected

| Asset                                                                                                             | Where it lives                                                                                         | Who may read it         |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------- |
| The setup: settings, skills, agents, commands, rules, hooks and their scripts, MCP servers, memory, project names | Encrypted bundles on the server; files on the user's PCs                                               | Only the user's PCs     |
| Saved environment variable values (API keys)                                                                      | An encrypted section inside a bundle                                                                   | Only the user's PCs     |
| The password                                                                                                      | Typed on the PC, never stored, never sent                                                              | Nobody                  |
| The data key (encrypts every bundle)                                                                              | OS keychain (or a user-only file) on each logged-in PC; on the server only wrapped by the password key | Only the user's PCs     |
| The session token                                                                                                 | OS keychain on the PC; on the server only as a SHA-256 hash                                            | The PC it was issued to |
| `SERVER_SECRET` (keys auth hashes, fake salts, rate-limit pseudonyms)                                             | Render's settings only                                                                                 | The server              |

## Who could attack

1. **Someone who gets the server's database** (a leak, a backup, a bad host employee).
2. **A malicious or compromised server** that answers the CLI with whatever it likes.
3. **Someone on the network** between the CLI and the server.
4. **Someone who steals a session token** (e.g. from a PC's keychain) but not the password.
5. **Another user** of the same service.
6. **One of the user's own PCs, compromised** (malware), trying to spread to the others.
7. **A stranger** probing the API: guessing passwords, finding which usernames exist.

A PC where the attacker already has the password or the data key is out of scope: they can read
everything by design.

## Threats and how they are handled

| #   | Threat                                                                      | Attacker | How it is handled                                                                                                                                                                                                                                                                                                                                                               | Tested in                                      |
| --- | --------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | Read a setup from the database                                              | 1, 2     | Bundles are encrypted on the PC with XChaCha20-Poly1305 under a random data key; the server only stores ciphertext. Project names are encrypted; the server sees a keyed hash.                                                                                                                                                                                                  | core crypto tests; e2e plaintext check (below) |
| 2   | Guess the password from the database                                        | 1        | The server stores HMAC-SHA256(`SERVER_SECRET`, auth key), where the auth key comes from Argon2id (64 MiB default, 19 MiB minimum enforced). Without `SERVER_SECRET` a stolen database cannot test guesses; with it, every guess costs a full Argon2id run. Register requires a zxcvbn score of 4 and 12+ characters.                                                            | server-keys, password-policy tests             |
| 3   | Weaken key derivation by sending low Argon2id settings at prelogin          | 2        | The contract refuses settings below 19 MiB and 2 passes, so the CLI never derives keys with them.                                                                                                                                                                                                                                                                               | contracts tests                                |
| 4   | **Bundle swapping:** serve one scope's, agent's or user's bundle as another | 2        | Encryption binds format version, agent and scope key (associated data); after opening, pull checks the agent and recomputes the scope key from the bundle's own scope. Another user's bundle fails because the data key differs.                                                                                                                                                | core envelope tests; pull tests                |
| 5   | **Rollback:** serve an older copy of the same setup                         | 2        | Since T38 the revision is sealed inside the bundle: a copy labelled with another revision is refused, and a copy older than the one this PC last had is only restored after the user says yes (never with `--yes`).                                                                                                                                                             | pull tests (T38)                               |
| 6   | Read or change traffic                                                      | 3        | HTTPS only (plain HTTP only for `localhost`); redirects are refused; answers are checked against the contracts and downloads against their SHA-256.                                                                                                                                                                                                                             | api-client tests                               |
| 7   | **Account enumeration**                                                     | 7        | Prelogin returns a stable fake salt for unknown names; login does the same hashing work and gives the same error for an unknown name and a wrong password; failures are rate-limited per name, unknown names included. Register does reveal a taken name (see accepted risks).                                                                                                  | auth-routes tests                              |
| 8   | Guess passwords online                                                      | 7        | 10 failed logins or account deletes per account per 15 minutes (a pause, never a lockout), 30 auth requests per minute per IP, 5 registrations per hour per IP.                                                                                                                                                                                                                 | rate-limit tests                               |
| 9   | Use a stolen session token                                                  | 4        | It cannot read setups (no data key) or delete the account (needs the auth key). Tokens are 256 random bits, stored hashed, end after 90 days or 30 days unused. It **can** delete or overwrite setups (see accepted risks).                                                                                                                                                     | session, account tests                         |
| 10  | Reach another user's data                                                   | 5        | Every bundle query filters by the session's user id.                                                                                                                                                                                                                                                                                                                            | repository, bundle-route tests                 |
| 11  | Oversized or decompression-bomb bundles                                     | 2, 5     | Uploads are capped at 5 MB, JSON bodies smaller; the CLI stops decompressing at 64 MB and schema-checks the result.                                                                                                                                                                                                                                                             | codec, route tests                             |
| 12  | Write files outside the setup (`../`, absolute paths)                       | 2, 6     | Bundle paths must be relative, forward-slash and without `.`/`..`; restore writes only what a collector could have produced and refuses keys-and-logins folders. On Windows, names with `:`, device names and trailing dots are refused (T38).                                                                                                                                  | restorer tests                                 |
| 13  | **Restored hooks** run code on another PC                                   | 6        | Pull lists every new or changed hook, status line and MCP command, and every new or changed script those run (T38), and asks before writing them. `--yes` alone skips them; only `--allow-commands` accepts them unasked (T38). A home-folder file is restored only when the setup's own hooks or status line run it, so a bundle cannot drop a file that runs by itself (T38). | pull, restorer tests                           |
| 14  | Installs as a way in                                                        | 6        | Plugin reinstalls and `npm install -g` are listed and asked about; `--yes` alone never installs (T38). Package names, plugin ids and marketplace sources are schema-checked and can never start like a command-line option (T38).                                                                                                                                               | after-restore, plugin tests                    |
| 15  | Break the shell profile with a saved value                                  | 6        | Values are single-quoted for the shell; values with a NUL byte or agentnomad's block markers are refused (T38). On Windows values go through environment variables, never a command line.                                                                                                                                                                                       | env tests                                      |
| 16  | Leak secrets in logs                                                        | 1        | Server logs never contain headers, bodies or query strings; the CLI never prints saved values.                                                                                                                                                                                                                                                                                  | limits-and-logs tests                          |
| 17  | A malicious dependency                                                      | all      | Lockfile frozen in CI; install scripts off by default; CI actions pinned by commit; `pnpm audit` clean (T38).                                                                                                                                                                                                                                                                   | CI                                             |
| 18  | A claude.ai skill gains powers as a local skill                             | 6        | Only the user's own synced skills are ever saved (never Anthropic's or an organization's). Pull adds them only after a yes or `--account-skills`, never over a local skill and never where claude.ai already syncs them. A local skill runs `!`command`` lines (a synced one does not), so those are marked, and a flag alone adds them only with `--allow-commands` (T42).     | account-skills tests                           |

**No plaintext leaves the PC.** The e2e run (T37) records every request the server receives, on
macOS, Windows and Linux, and fails if any URL, header or body contains the password, file
contents, commands, memory, the project name or the login state of `~/.claude.json`, whether as
text or base64 at any alignment. A control check confirms the same search does find the username,
which is sent readable.

## Findings

Found in the T38 review, all fixed:

| #   | Severity    | Finding                                                                                                                                                                                  | Fix                                                                                                                        |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Medium-High | Pull restored any script-type file anywhere in the home folder (e.g. the Windows Startup folder, a PowerShell or fish profile). Those run by themselves and were never shown for review. | Home files are restored only when the setup's own hooks or status line run them, or when they are a known tool's settings. |
| 2   | Medium      | The review showed hook commands, not the scripts they run: a changed `check.sh` behind an unchanged command was not shown.                                                               | New or changed scripts that hooks or the status line run are listed and skipped when declined.                             |
| 3   | Medium      | `pull --yes` accepted new hooks and MCP commands and ran `npm install -g`, so one compromised PC could spread to every PC pulling from a script.                                         | `--yes` skips new or changed runnable things and installs, with a note; the new `--allow-commands` accepts them.           |
| 4   | Low         | Rollback: the revision was not inside the encryption.                                                                                                                                    | The revision is sealed in the bundle; pull refuses a mislabelled copy and asks before restoring an older one.              |
| 5   | Low         | npm package names and plugin ids could start with `-` (read as an option).                                                                                                               | They must start with a letter or digit.                                                                                    |
| 6   | Low         | On Windows, `:` wrote an alternate data stream and device names (`CON`, `NUL`) reached a device.                                                                                         | Such names are refused on Windows with the reason.                                                                         |
| 7   | Low         | A saved value with a NUL byte or a block marker line could corrupt the shell profile block on the next update.                                                                           | Such values are refused.                                                                                                   |
| 8   | Info        | `drizzle-kit` (development only) pulled an esbuild with a known advisory.                                                                                                                | Overridden to the patched esbuild line; `pnpm audit` reports nothing.                                                      |

## Accepted risks

- **Readable to the server:** the username, the device name (the PC's host name) of each session,
  and metadata: which agent, how many setups, their sizes, revisions and save times.
- **Register reveals taken usernames.** Unavoidable with chosen usernames; limited to 5
  registrations per hour per IP.
- **A stolen session token can delete or overwrite setups** (not read them, not delete the
  account). Logging out on that PC or deleting the account ends it; it also ends after 30 days unused.
- **Rollback on a PC that never had the setup** cannot be detected: it has no revision to compare.
- **No password recovery.** A forgotten password means the data is gone; that is what keeps the
  server unable to read it.
- **Restored environment values are plain text** in the shell profile (or Windows user
  variables), like any value set by hand.
- **`--allow-commands` trusts the user's own setup.** It is meant for scripts on PCs whose setups
  come only from PCs the user controls.
- **Code from plugin marketplaces** runs as Claude Code runs it; agentnomad only reinstalls what
  the user had.
