# 0001 · Libraries for crypto, CLI, prompts and keychain (T04)

- **Status:** accepted (confirmed by the project owner on 2026-09-24): libsodium-wrappers-sumo, commander + extra-typings, @clack/prompts, @napi-rs/keyring
- **Date:** 2026-09-24
- **Constraints:** Node >= 22.13 (package.json `engines`), macOS / Linux / Windows, no native compile step for users, fewest dependencies for a security tool, TypeScript types included.

Data below was collected on 2026-09-24 from the npm registry, the npm downloads API and GitHub.

## 1. Crypto (Argon2id, authenticated encryption, keyed hash)

Needs: Argon2id for password to master key, splitting the master key into auth key and password key, AEAD for bundles and the wrapped data key, a keyed hash for `scope_key`.

Argon2id benchmark (64 MiB, 3 passes, 1 lane, 32-byte key, Node 24.16, Windows x64). All four produced the **same key** for the same input, so the choice can change later without locking users out, as long as we keep parallelism at 1.

| Option                               | Argon2id time | Encryption                                      | Deps               | Install size | Node 22 | Notes                                                                                                                                                                            |
| ------------------------------------ | ------------- | ----------------------------------------------- | ------------------ | ------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **libsodium-wrappers-sumo 0.8.4**    | 137 ms        | XChaCha20-Poly1305 (192-bit random nonce)       | 1 (libsodium-sumo) | 2.1 MB       | yes     | One library for everything (Argon2id, AEAD, KDF, keyed BLAKE2b). WASM, no native build. Ships its own types. Repo active (2026-09-22).                                           |
| Node built-in `node:crypto`          | 98 ms         | AES-256-GCM or ChaCha20-Poly1305 (96-bit nonce) | 0                  | 0            | **no**  | `crypto.argon2` added in Node 24.7.0. Zero supply-chain risk, OpenSSL-backed. Would require `engines >= 24.7` and a Node-only implementation (core currently has no Node types). |
| @noble/hashes + @noble/ciphers 2.4.0 | 577 ms        | XChaCha20-Poly1305                              | 0                  | 1.3 MB       | yes     | Pure TypeScript, audited by an independent firm per README, very widely used. Argon2 in pure JS is ~4x slower.                                                                   |
| hash-wasm 4.12.0 + WebCrypto         | 133 ms        | AES-256-GCM (WebCrypto)                         | 0                  | 2.0 MB       | yes     | Two sources to combine; last release 2024-11-19.                                                                                                                                 |

**Recommendation: libsodium-wrappers-sumo 0.8.4.** It matches the PRD ("one library, WASM preferred over native builds"), works on Node 22 and 24 alike, keeps `core` free of Node APIs, and XChaCha20's 192-bit nonce makes random nonces safe without counting messages. **Runner-up:** Node built-in, if we are willing to require Node 24.7+.

Parameter note for T08: keep Argon2id **parallelism = 1** (libsodium's only mode) so every implementation above can reproduce the same key.

## 2. CLI framework (subcommands, flags, help)

| Option                                      | Version  | Last release | Weekly downloads | Deps | Notes                                                                                              |
| ------------------------------------------- | -------- | ------------ | ---------------- | ---- | -------------------------------------------------------------------------------------------------- |
| **commander + @commander-js/extra-typings** | 15.0.0   | 2026-05-29   | 375 M            | 0    | Most used, typed options and actions via extra-typings, `exitOverride()` for tests, Node >= 22.12. |
| citty                                       | 0.2.2    | 2026-04-01   | 22 M             | 0    | Tiny and typed, but still 0.x with 70 open issues.                                                 |
| node:util `parseArgs`                       | built-in | —            | —                | 0    | Parses flags only; subcommands and help text would be hand-written.                                |
| yargs                                       | 18.2.0   | 2026-09-20   | 195 M            | 6    | Capable but heavier.                                                                               |

**Recommendation: commander 15.0.0 + @commander-js/extra-typings 15.0.0.**

## 3. Prompts (checklists, selects, text, password, spinners)

| Option             | Version | Last release | Weekly downloads | Deps      | Notes                                                                                             |
| ------------------ | ------- | ------------ | ---------------- | --------- | ------------------------------------------------------------------------------------------------- |
| **@clack/prompts** | 1.8.1   | 2026-09-13   | 18 M             | 4 (small) | `multiselect`, `select`, `password`, `spinner`, `isCancel` for Ctrl+C. Clean look. Node >= 20.12. |
| @inquirer/prompts  | 8.7.2   | 2026-09-07   | 28 M             | 10        | Mature (`checkbox`, `select`, `password`), more dependencies.                                     |
| enquirer           | 2.4.1   | 2023-07-28   | 25 M             | 2         | No release in 3 years. Rejected.                                                                  |
| prompts            | 2.4.2   | 2021-10-07   | 46 M             | 2         | No release in 5 years. Rejected.                                                                  |

**Recommendation: @clack/prompts 1.8.1.** It will sit behind the `Prompter` interface, so it can be swapped without touching commands.

## 4. OS keychain (session token and unlocked data key)

| Option               | Version | Last release | Weekly downloads | Notes                                                                                                                                                                    |
| -------------------- | ------- | ------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **@napi-rs/keyring** | 2.1.0   | 2026-09-13   | 2.7 M            | Rust `keyring` crate. Prebuilt binaries for macOS, Windows and Linux (x64 and arm64), no compile step. Windows Credential Manager, macOS Keychain, Linux Secret Service. |
| cross-keychain       | 1.1.0   | 2025-10-07   | 42 K             | Small user base.                                                                                                                                                         |
| keytar               | 7.9.0   | 2022-02-17   | 2.2 M            | **Archived** on GitHub (atom/node-keytar). Rejected.                                                                                                                     |

**Recommendation: @napi-rs/keyring 2.1.0**, with one rule for T22: on Linux, pin the store to `secret-service`. Its automatic fallback is the kernel keyring, which is in memory only and is lost on reboot. When Secret Service is missing (servers, WSL, SSH), use the PRD's user-only file fallback instead.

## Pinning

Exact versions (no `^`) are recorded above. Each package is installed, at that exact version, in the task that first uses it:

| Library                                              | Package | Task |
| ---------------------------------------------------- | ------- | ---- |
| libsodium-wrappers-sumo 0.8.4                        | core    | T08  |
| commander 15.0.0, @commander-js/extra-typings 15.0.0 | cli     | T20  |
| @clack/prompts 1.8.1                                 | cli     | T20  |
| @napi-rs/keyring 2.1.0                               | cli     | T22  |

If a newer version exists by then, it is checked against this record before use.
