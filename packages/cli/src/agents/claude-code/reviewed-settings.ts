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
];

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
];

/**
 * `$` methods a mod's module calls (the `calls:` line of `claude plugin validate`, T96) that
 * the pull review flags (T97): what each group does on this PC. `calls` names only the method,
 * never the program, path or prompt, so the review offers the module's source.
 */
export const RISKY_MOD_CALLS: readonly { readonly prefix: string; readonly does: string }[] = [
  { prefix: '$.process', does: 'runs programs' },
  { prefix: '$.model', does: 'calls the model' },
  { prefix: '$.net', does: 'uses the network' },
  { prefix: '$.http', does: 'uses the network' },
  { prefix: '$.fetch', does: 'uses the network' },
  { prefix: '$.web', does: 'uses the network' },
  { prefix: '$.ws', does: 'uses the network' },
];

/** `$.fs` methods that only read; every other `$.fs` method counts as a file write. */
export const READING_FS_CALLS: readonly string[] = [
  '$.fs.read',
  '$.fs.readFile',
  '$.fs.readText',
  '$.fs.readJson',
  '$.fs.readdir',
  '$.fs.list',
  '$.fs.exists',
  '$.fs.stat',
  '$.fs.glob',
];

/** What a `$` call does that the review flags, or `null` (`$.store.get`, `$.ui.status`). */
export function riskOfCall(call: string): string | null {
  const under = (prefix: string) => call === prefix || call.startsWith(`${prefix}.`);
  if (under('$.fs')) return READING_FS_CALLS.includes(call) ? null : 'writes files';
  return RISKY_MOD_CALLS.find((risky) => under(risky.prefix))?.does ?? null;
}
