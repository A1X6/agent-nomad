## What this is

Two more full reviews of the T95 and T96 work (plugins and mods in the skills folder), each followed by a round that fixed every finding, on top of the review-15 fixes already on this branch.

| Review | Files read in full | Findings | Medium | Caused by the previous fix round | Pre-existing, in files that entered scope |
| --- | --- | --- | --- | --- | --- |
| 16 | 44 | 37 | 2 | 22 | 15 |
| 17 | 51 | 46 | 5 | 15 | 31 |

No Critical or High finding in either round. Reports: `docs/reviews/review-2026-10-09-16/` and `docs/reviews/review-2026-10-09-17/` (every box ticked, `files.md` reads `fixed`).

## What changed in the code

- **Structure.** The plugin path rules (`pluginFolderOf`, `pluginMcpFileKind`) and the account-skills bundle paths live in `global-paths.ts`, with the other path rules. That ends the one import cycle (`env-files → skills-dir-plugins → command-review → env-files`) and the last pure module's reach to `node:fs`; `bundle-paths.ts` holds the home-folder rules and sits under the pure lint block. `import-cycles.test.ts` keeps the graph cycle-free.
- **Env scan.** `EnvReferenceFiles.mcpFileKind` replaces `isMcpFile`: a plugin's `.mcp.json` is read as the server map with or without the wrapper, and a manifest's `mcpServers` list (maps and file names mixed) is read, so push offers the values a plugin's servers need, labelled by server.
- **Pull.** A saved claude.ai skill that is a plugin is never added as a local skill. An accepted plugin folder's differing files are asked about once, as the folder, so a yes to what it runs is never followed by half of it written. `--agent` names the next step. The project-folder check has one home (`projectFolderRefusalFor`).
- **Plugin reader.** Every unreadable part says why (`no such file`, the parse problem); a hooks file without the `hooks` wrapper is shown, never dropped.
- **Smaller.** One `stat` per restored and per walked file; `"blocked"` names the policy only when managed settings exist; the hook-group schema and the writable folder lists are constants; stale comments and lines over the width are gone.
- **Tests.** 80 new cases: pull's and push's agent and scope choosers and their messages, the folder conflict, the after-restore policy test (which could pass without the injection), the validator's timeout, the collectors', rules' and restorer's uncovered branches, the env scan's edges. Shared fixtures (`loggedInStore`, `sessionKeys`, `remoteSettingsFile`, `PROJECT_MOD_FOLDER`, `generatedTypesDir`, `fakeExecutables` overrides, a scripted prompter that records the choices offered) replace copies; packed tests are split.
- **Docs.** ARCHITECTURE, the threat model (rows 18 and 19), CONTRIBUTING, the adapter guide and README follow the code.

## Verification

Type check, lint, format, 1,541 tests (12 skipped), `pnpm knip`, and the e2e suite (15 tests) pass on `5a2ae0e`.

<!-- pr-lens -->

<h3>Reviews 16 and 17 of T95 and T96, with every finding fixed</h3>

<p>Two more full reviews of the plugins-in-the-skills-folder work (T95, T96), 83 findings fixed. The plugin path rules and the account-skills paths now live in global-paths.ts, which ends the one import cycle and the pure modules' reach to node:fs; the env scan reads a plugin's manifest lists and wrapper-less .mcp.json the way the plugin review does; pull asks about a changed plugin's differing files once, as the folder; a saved claude.ai skill that is a plugin is never added as a local skill; the walker stats each file once. 80 new tests pin the branches the reviews found untested, and a test keeps the import graph free of cycles.</p>

<p><code>60 files</code> · <code>+3856</code> · <code>−772</code> · <code>Findings fixed 83</code> · <code>Full reviews 2</code> · <code>Tests 1,541 pass</code> · <code>Import cycles 1 → 0</code></p>

<details open>
<summary><b>What the two review rounds changed</b></summary>

<p>The adapter's path rules in one place, the env scan and the plugin review reading files the same way, and the tests that pin it.</p>

<a href="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/overview-light-e473ff55de6995b7edd9f6995c2e2d9e.svg"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/overview-dark-7015e7cd9ec1714e1b767eb1be40ccfa.svg">
  <img alt="What the two review rounds changed" src="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/overview-light-e473ff55de6995b7edd9f6995c2e2d9e.svg" width="1877">
</picture></a>

<details>
<summary><b>The plugin path rules and the cycle they end</b></summary>

<p>env-files imported the plugin reader, which imported command-review, which imported env-files. The rules both need now sit in global-paths.</p>

<a href="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/path-rules-light-28c2e145bfc929a982caca8f552cf263.svg"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/path-rules-dark-400ee94e35fa32235cbbc442a4d03efa.svg">
  <img alt="The plugin path rules and the cycle they end" src="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/path-rules-light-28c2e145bfc929a982caca8f552cf263.svg" width="1038">
</picture></a>

</details>

<details>
<summary><b>Push and pull</b></summary>

<p>The commands reach the adapter only through its interfaces; the project-folder check and the env scan are shared code they both call.</p>

<a href="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/commands-area-light-4c69e1fc713c8b6a0e1f47ab174b42c3.svg"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/commands-area-dark-57018c31eef3c7c2cfe8630e25709921.svg">
  <img alt="Push and pull" src="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/commands-area-light-4c69e1fc713c8b6a0e1f47ab174b42c3.svg" width="956">
</picture></a>

</details>

<details>
<summary><b>Reviewing and restoring a plugin</b></summary>

<p>The restorer hands the plugin folders to the pure reader, which asks the injected validator, which runs Claude Code's own check on a temporary copy.</p>

<a href="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/review-area-light-d66a2571931f39d6e1b704b55ba5ce8b.svg"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/review-area-dark-f4b59084915669ac6c1c60fb84e74476.svg">
  <img alt="Reviewing and restoring a plugin" src="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/review-area-light-d66a2571931f39d6e1b704b55ba5ce8b.svg" width="456">
</picture></a>

</details>

<details>
<summary><b>Tests and docs</b></summary>

<p>Two new test files, 80 new cases in the existing ones, the two review reports and the docs that follow the code.</p>

<a href="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/quality-area-light-7d25185e21be7d03f911aa04bf534213.svg"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/quality-area-dark-c296395dd0fe5c38f490b856c545ba5e.svg">
  <img alt="Tests and docs" src="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/quality-area-light-7d25185e21be7d03f911aa04bf534213.svg" width="1708">
</picture></a>

</details>

</details>

<details>
<summary><b>Pulling a changed plugin</b></summary>

<a href="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/flow-pull-light-1c49b4f6327989edd0e246511f44ea25.svg"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/flow-pull-dark-2d7ac52f955a072b28412ddeb21a72e0.svg">
  <img alt="Pulling a changed plugin" src="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/flow-pull-light-1c49b4f6327989edd0e246511f44ea25.svg" width="1638">
</picture></a>

</details>

<details>
<summary><b>Push finds a plugin's ${VAR}</b></summary>

<a href="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/flow-env-light-5acfb8fad068439df84bdc7eb08c0058.svg"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/flow-env-dark-3cf96eda13d97aabed3976366325341e.svg">
  <img alt="Push finds a plugin's ${VAR}" src="https://raw.githubusercontent.com/A1X6/agent-nomad/review-reports/docs/reviews/review-2026-10-09-17/pr-lens/flow-env-light-5acfb8fad068439df84bdc7eb08c0058.svg" width="992">
</picture></a>

</details>

---

<sub>◈ Rendered by <a href="https://github.com/coldteadotai/pr-lens">PR Lens</a> · from the team behind <a href="https://coldtea.ai">Coldtea</a></sub>
