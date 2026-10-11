/**
 * An excerpt of Claude Code's settings reference
 * (https://code.claude.com/docs/en/settings-reference.md), saved on 2026-10-11 for Claude Code
 * 2.1.296 (T109): the index table's heading and every row with the scope "Global config", plus
 * a few rows with other scopes. The drift check reads the `~/.claude.json` preference keys from it.
 */
export const SETTINGS_REFERENCE_2026_10_11 = [
  '## Settings index',
  '',
  '| Key | Description | Topic | Scope |',
  '| :- | :- | :- | :- |',
  '| [`advisorModel`](#advisormodel) | Pick which model answers when Claude asks the [advisor tool](/docs/en/advisor) | Model and responses | Any file |',
  '| [`agent`](#agent) | Start every session as a named [subagent](/docs/en/sub-agents) with its prompt, tools, and model | Agents, sessions, and worktrees | Any file |',
  '| [`apiKeyHelper`](#apikeyhelper) | Generate the [API credential](/docs/en/authentication#credential-management) with your own command | Authentication and providers | Any file |',
  '| [`autoConnectIde`](#autoconnectide) | Connect to a running [VS Code](/docs/en/vs-code) or [JetBrains](/docs/en/jetbrains#from-external-terminals) IDE automatically from an external terminal | Global config settings | Global config |',
  '| [`autoInstallIdeExtension`](#autoinstallideextension) | Turn off automatic install of the [IDE extension](/docs/en/vs-code#install-the-extension) from a VS Code terminal | Global config settings | Global config |',
  '| [`claudeInChromeDefaultEnabled`](#claudeinchromedefaultenabled) | Turn on [Chrome integration](/docs/en/chrome) when a session starts, in the interactive CLI and the VS Code extension | Global config settings | Global config |',
  '| [`copyFullResponse`](#copyfullresponse) | Make [`/copy`](/docs/en/commands) copy the full response without showing the picker | Global config settings | Global config |',
  '| [`copyOnSelect`](#copyonselect) | Turn off automatic copying of text you select with the mouse in [fullscreen rendering](/docs/en/fullscreen#use-the-mouse) and agent view | Global config settings | Global config |',
  '| [`defaultToAgentsView`](#defaulttoagentsview) | Open [agent view](/docs/en/agent-view) instead of a new conversation when you run `claude` with no arguments | Global config settings | Global config |',
  "| [`diffTool`](#difftool) | Choose whether Claude's proposed file changes open in the [VS Code](/docs/en/vs-code) or [JetBrains](/docs/en/jetbrains#features) diff viewer or stay in the terminal | Global config settings | Global config |",
  "| [`disabledMcpjsonServers`](#disabledmcpjsonservers) | Reject specific servers from a project's [`.mcp.json`](/docs/en/mcp#project-scope) | MCP | Any file |",
  "| [`enabledMcpjsonServers`](#enabledmcpjsonservers) | Approve specific servers from a project's [`.mcp.json`](/docs/en/mcp#project-server-approvals-and-workspace-trust) | MCP | Any file |",
  "| [`externalEditorContext`](#externaleditorcontext) | Show Claude's last response as comments when you press [Ctrl+G](/docs/en/interactive-mode#general-controls) to edit | Global config settings | Global config |",
  '| [`leftArrowOpensAgents`](#leftarrowopensagents) | Turn off the `←` shortcut that [backgrounds the session and opens agent view](/docs/en/agent-view#switch-sessions-without-leaving-the-terminal) | Global config settings | Global config |',
  '| [`permissionExplainerEnabled`](#permissionexplainerenabled) | Removed in v2.1.257, together with the `Ctrl+E` command explanation on shell permission prompts | Global config settings | Global config |',
  "| [`prStatusFooterEnabled`](#prstatusfooterenabled) | Turn off the prompt footer's [PR review status](/docs/en/interactive-mode#pr-review-status) badge and the pull request check behind it | Global config settings | Global config |",
  "| [`teammateDefaultModel`](#teammatedefaultmodel) | Removed in v2.1.234; see [Specify teammates and models](/docs/en/agent-teams#specify-teammates-and-models) for how Claude Code picks a teammate's model | Global config settings | Global config |",
].join('\n');

/** The "Global config" keys of that excerpt, in its order. */
export const GLOBAL_CONFIG_KEYS_2026_10_11 = [
  'autoConnectIde',
  'autoInstallIdeExtension',
  'claudeInChromeDefaultEnabled',
  'copyFullResponse',
  'copyOnSelect',
  'defaultToAgentsView',
  'diffTool',
  'externalEditorContext',
  'leftArrowOpensAgents',
  'permissionExplainerEnabled',
  'prStatusFooterEnabled',
  'teammateDefaultModel',
];
