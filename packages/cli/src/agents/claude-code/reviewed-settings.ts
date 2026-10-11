/**
 * The Claude Code settings keys and `env` names the pull review watches (T44, T55), each
 * checked against Claude Code's settings and environment variable reference. Plain data, so
 * the weekly drift check (T41) can flag changelog entries that name one.
 */

/**
 * Settings keys whose value is a command Claude Code runs ("with your own command" in its
 * settings reference); every one is accepted in any settings file.
 */
export const COMMAND_SETTINGS = [
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
  'fileSuggestion',
  // `{ type: "command", command }`, run for each subagent's status line (named by the
  // changelog for 2.1.293; read from any settings file by the 2.1.296 program, T107).
  'subagentStatusLine',
];

/**
 * The Claude apps gateway that `/login` signs in to, so every request goes there (changelog
 * for 2.1.295). The 2.1.296 program reads it from user settings only, with `forceLoginMethod`
 * set to `gateway` (T107).
 */
export const LOGIN_GATEWAY_SETTING = 'forceLoginGatewayUrl';

/**
 * `env` names in a settings file that send Claude Code's requests, prompts or telemetry
 * elsewhere, or choose the program it starts commands with (T55): the endpoint, proxy and
 * certificate variables of its environment variable and network pages, its shell variables,
 * and `PATH` (Claude Code writes every `env` entry into its process environment).
 */
const REDIRECT_VARIABLES = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CODE_SHELL',
  'CLAUDE_CODE_SHELL_PREFIX',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_LOG_USER_PROMPTS',
  'PATH',
];

const REDIRECT_NAMES = new Set(REDIRECT_VARIABLES);

/** Compared without case: the proxy variables work in lower case, and Windows ignores it. */
export const isRedirectVariable = (name: string): boolean => REDIRECT_NAMES.has(name.toUpperCase());

/**
 * The `env` name whose folders Claude Code loads as plugins every session (T99, as Claude Code
 * 2.1.296 reads it). A pulled value is reviewed like a redirect (SEC-04 of review 16).
 */
export const PLUGIN_DIRS_VARIABLE = 'CLAUDE_CODE_PLUGIN_DIRS';

/** A settings `env` name the review shows: a redirect variable or the plugin folders. */
export const isWatchedVariable = (name: string): boolean =>
  isRedirectVariable(name) || name.toUpperCase() === PLUGIN_DIRS_VARIABLE;

/**
 * Permission and sandbox settings that let Claude Code act without asking (T44, T55). Each
 * takes effect from any settings file, except the two modes noted in `command-review.ts`.
 */
const LOOSENING_SETTINGS = [
  'permissions.defaultMode',
  'permissions.allow',
  'permissions.additionalDirectories',
  'sandbox',
  'enableAllProjectMcpServers',
];

/** Everything above, for the drift check's watch list. */
export const WATCHED_SETTINGS: readonly string[] = [
  ...COMMAND_SETTINGS,
  ...LOOSENING_SETTINGS,
  ...REDIRECT_VARIABLES,
  PLUGIN_DIRS_VARIABLE,
  LOGIN_GATEWAY_SETTING,
];

/**
 * `$` methods a mod's module calls (the `calls:` line of `claude plugin validate`, T96) that
 * the pull review flags (T97): what each group does on this PC. `calls` names only the method,
 * never the program, path or prompt, so the review offers the module's source. Checked against
 * the 2.1.296 program's own list of methods (SEC-04 of review 15): `$.tool.call` runs any tool
 * of the session by name, Bash included, and `$.session.authorize` makes `$.http.fetch` send
 * the user's Claude login headers (SEC-08 of review 16).
 */
const RISKY_MOD_CALLS: readonly { readonly prefix: string; readonly does: string }[] = [
  { prefix: '$.process', does: 'runs programs' },
  { prefix: '$.tool.call', does: 'runs tools, Bash included' },
  { prefix: '$.command.run', does: 'runs commands' },
  { prefix: '$.agent.spawn', does: 'runs subagents' },
  { prefix: '$.mcp', does: 'starts or calls MCP servers' },
  { prefix: '$.config.set', does: 'changes settings' },
  { prefix: '$.env.set', does: 'sets environment variables' },
  { prefix: '$.session.send', does: 'sends prompts' },
  { prefix: '$.session.authorize', does: 'uses your Claude login' },
  { prefix: '$.prompt.submit', does: 'sends prompts' },
  { prefix: '$.model', does: 'calls the model' },
  { prefix: '$.net', does: 'uses the network' },
  { prefix: '$.http', does: 'uses the network' },
  { prefix: '$.fetch', does: 'uses the network' },
  { prefix: '$.web', does: 'uses the network' },
  { prefix: '$.ws', does: 'uses the network' },
];

/** `$.fs` methods that only read; every other `$.fs` method counts as a file write. */
const READING_FS_CALLS: readonly string[] = [
  '$.fs.read',
  '$.fs.readFile',
  '$.fs.readText',
  '$.fs.readJson',
  '$.fs.readdir',
  '$.fs.list',
  '$.fs.exists',
  '$.fs.stat',
  '$.fs.glob',
  '$.fs.ancestors',
];

/**
 * What a `$` call does that the review flags, or `null` (`$.store.get`, `$.ui.status`). A call
 * made through a helper is named `$.tool.call (via run)` by validate.
 */
export function riskOfCall(call: string): string | null {
  const method = /^[^\s{]*/.exec(call)?.[0] ?? call;
  const under = (prefix: string) => method === prefix || method.startsWith(`${prefix}.`);
  if (under('$.fs')) return READING_FS_CALLS.includes(method) ? null : 'writes files';
  return RISKY_MOD_CALLS.find((risky) => under(risky.prefix))?.does ?? null;
}

/**
 * Events a mod's module hooks (the `hooks:` line of validate) that the pull review flags, as
 * `RISKY_MOD_CALLS` (SEC-08 of review 16). In the 2.1.296 program a `tool.check` hook answers
 * a tool call's permission question with `{ decision }` and a `classic.PreToolUse` hook with
 * `{ allow: true }`; a `PermissionRequest` hook answers the permission dialog (hooks docs).
 * Each can allow every Bash command the model proposes, with no prompt.
 */
const RISKY_MOD_HOOKS: readonly { readonly event: string; readonly does: string }[] = [
  { event: 'tool.check', does: 'decides tool permissions, can allow Bash' },
  { event: 'classic.PreToolUse', does: 'decides tool permissions, can allow Bash' },
  { event: 'classic.PermissionRequest', does: 'decides tool permissions, can allow Bash' },
];

/**
 * What a hook does that the review flags, or `null` (`session.start`). Its filter is left out
 * (`tool.check{tool=Bash}`), and a pattern counts when it may select one of those events
 * (`tool.*`, `!ui.render`), so the review fails toward showing.
 */
export function riskOfHook(hook: string): string | null {
  const event = /^[^\s{]*/.exec(hook)?.[0] ?? hook;
  const star = event.indexOf('*');
  const selects = (risky: string) => {
    if (event.startsWith('!')) return event.slice(1) !== risky;
    return star === -1 ? event === risky : risky.startsWith(event.slice(0, star));
  };
  return RISKY_MOD_HOOKS.find((risky) => selects(risky.event))?.does ?? null;
}
