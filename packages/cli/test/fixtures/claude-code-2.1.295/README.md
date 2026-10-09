# Claude Code 2.1.295: plugin and mod sources (T95)

Real files from Claude Code 2.1.295 on Linux (2026-10-09), made before the plugin and mod sync
(T96 to T102) is built. `claude-code-plugin-sources.test.ts` checks the findings against them,
and `claude-code-paths.data.ts` (`plugins`) holds the names the sync code will use.

How they were made: a throwaway `CLAUDE_CONFIG_DIR`, then `claude plugin init`, a hand-written
mod in `skills/probe-mod/`, a local marketplace (`my-local.mkt`, plugins `lm-plugin` and
`Odd.Name_v2`), a `--plugin-dir` plugin (`inline-plug`), and three `claude -p` runs. Account
and skill ids are replaced with placeholders and long descriptions are cut; nothing else is
changed. Module files end in `.txt` so the repo's TypeScript build does not compile them.

## What was checked

1. **A mod in `~/.claude/skills/<name>/` loads as `<name>@skills-dir`.** Yes: `claude plugin
list` shows `probe-mod@skills-dir`, scope `user`, loaded. `claude plugin init <name>`
   scaffolds a plugin there too (with classic command hooks, not a module).
   `skills-dir-mod/` is the mod.
2. **Where a mod's `$.store` is written.** Not in `plugins/data/`, as expected, but in
   `plugins/store/<id with _>-<sha256(id), 12 hex>.json` (folder 700, file 600), e.g.
   `probe-mod_skills-dir-e89169932969.json`. A mod with only a hooks module got no
   `plugins/data/` folder. `store-probe-mod_skills-dir-e89169932969.json` is the file after
   the three runs (`runs: 3`). `.claude-plugin/types/` was not written in a `claude -p` run; Claude Code writes
   it when it hot-reloads a mod (dev-mods, `--plugin-dir`).
3. **claude.ai synced plugins.** `plugins/synced/<account>/manifest.json` entries have
   `pluginId`, `name`, `description`, `version`, `updatedAt`, `marketplaceName`,
   `installationPreference` (a sidecar `<name>.meta.json` repeats the last three). The only
   real entry is Anthropic's `cowork-plugin-management` (`knowledge-work-plugins`,
   `available`); this account had no `.marketplaces.json`, so no uploaded or org-required
   plugin was seen. From Claude Code's own code: `.marketplaces.json` holds `rows` with a
   `scope` of `org`, `default` or `account` ("you (your uploads)"), and
   `installationPreference` is one of `available`, `required` ("required by your org"),
   `auto_install`, `not_available`. The user's uploaded plugins on this account arrive as
   **skills** in `skills/synced/<account>/` with `source: "plugin"` and a `backingPluginId`
   (`synced/skills-manifest.json`), and **no entry has `creatorType`**, the field T42 reads.
4. **How `plugins/data/<plugin-id>/` is named.** The id `<name>@<source>` with every
   character outside `A-Za-z0-9_-` turned into `-`: `lm-plugin-my-local-mkt`,
   `Odd-Name_v2-my-local-mkt`, `probe-init-skills-dir`, `inline-plug-inline`
   (`plugins-tree.txt`). This matches the names seen before (`vercel-inline`,
   `warp-claude-code-warp`).
5. **What `claude plugin validate` prints for a mod.** One `hooks:` and one `calls:` line per
   module (`validate/probe-mod.txt`; with `--json` they are the hooks file's `notes`,
   `validate/probe-mod.json`). `calls:` names only the `$` methods (`$.process.spawn`), never
   the program, path or prompt. Classic command hooks are not listed at all. Exit codes
   (`validate/exit-codes.txt`): 0 when it passes, also with warnings; 1 for a syntax error,
   a missing module or a broken manifest; `--strict` turns a warning into 1.
