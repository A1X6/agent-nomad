/**
 * Environment variables that make a shell or a runtime load or run code (T44): the Bash
 * manual's `PROMPT_COMMAND` and `BASH_ENV`, Node's `NODE_OPTIONS` (`--require`, `--import`),
 * the dynamic loader's `LD_*` and `DYLD_*`, and their kin. A saved value for one of these is
 * a way to run code on another PC, so it is treated like a hook: never added by `--yes` alone.
 * T55 adds module and home paths (`NODE_PATH`, `PYTHONHOME`), Java agents
 * (`JAVA_TOOL_OPTIONS` and kin), password and editor programs SSH and other tools start
 * (`SSH_ASKPASS`, `EDITOR`, `VISUAL`, `PAGER`, `LESSOPEN`) and functions Bash imports
 * (`BASH_FUNC_*`). Every Git variable (`GIT_*`, SEC-05 of review 16): `GIT_CONFIG_PARAMETERS`
 * passes config entries as `git -c` does, and others name programs, hooks or config files. A
 * saved one is rare and only ever asked about. `XDG_CONFIG_HOME` moves where Git and the fish
 * shell read their config from.
 */
const LOADER_VARIABLE =
  /^(PROMPT_COMMAND|BASH_ENV|ENV|ZDOTDIR|NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|GIT_.+|XDG_CONFIG_HOME|SSH_ASKPASS|EDITOR|VISUAL|PAGER|LESSOPEN|LESSCLOSE|BASH_FUNC_.+|LD_.+|DYLD_.+)$/;

/**
 * Whether `name` is one of the variables above. Compared without case, as `isRedirectVariable`
 * does: Windows reads `node_options` as `NODE_OPTIONS` (SEC-05 of review 15).
 */
export const isLoaderVariable = (name: string): boolean =>
  LOADER_VARIABLE.test(name.toUpperCase());
