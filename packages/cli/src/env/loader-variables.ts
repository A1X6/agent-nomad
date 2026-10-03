/**
 * Environment variables that make a shell or a runtime load or run code (T44): the Bash
 * manual's `PROMPT_COMMAND` and `BASH_ENV`, Node's `NODE_OPTIONS` (`--require`, `--import`),
 * the dynamic loader's `LD_*` and `DYLD_*`, and their kin. A saved value for one of these is
 * a way to run code on another PC, so it is treated like a hook: never added by `--yes` alone.
 * T55 adds module and home paths (`NODE_PATH`, `PYTHONHOME`), Java agents
 * (`JAVA_TOOL_OPTIONS` and kin), password and editor programs Git, SSH and other tools start
 * (`GIT_ASKPASS`, `SSH_ASKPASS`, `EDITOR`, `VISUAL`, `PAGER`, `LESSOPEN`), Git config files
 * and entries given through the environment (which can name programs too), and functions
 * Bash imports (`BASH_FUNC_*`).
 */
export const LOADER_VARIABLE =
  /^(PROMPT_COMMAND|BASH_ENV|ENV|ZDOTDIR|NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|GIT_SSH_COMMAND|GIT_EXTERNAL_DIFF|GIT_ASKPASS|SSH_ASKPASS|GIT_EDITOR|GIT_PAGER|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_.+|GIT_CONFIG_VALUE_.+|EDITOR|VISUAL|PAGER|LESSOPEN|LESSCLOSE|BASH_FUNC_.+|LD_.+|DYLD_.+)$/;
