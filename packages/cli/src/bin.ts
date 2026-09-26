#!/usr/bin/env node
/** The `agentnomad` executable: parses the command line and sets the exit code. */
import { homedir, hostname } from 'node:os';

import { createAppHandlers } from './app.ts';
import { runCli } from './cli/run.ts';
import { readFirstLine } from './cli/stdin.ts';
import { createClackPrompter, createClackReporter } from './ui/clack-prompter.ts';
import { createNoTerminalPrompter } from './ui/no-terminal-prompter.ts';

// A script, a pipe or CI: nothing is asked, and questions the flags leave open fail (T36).
// Node types isTTY as boolean, but it is undefined (not false) when piped: make it a real boolean.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const reporter = createClackReporter({ diagnostics: process.stderr, interactive });

process.exitCode = await runCli(process.argv.slice(2), {
  handlers: createAppHandlers({
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
    hostname: hostname(),
    cwd: process.cwd(),
    prompter: interactive ? createClackPrompter() : createNoTerminalPrompter(),
    reporter,
    readPasswordStdin: () => readFirstLine(process.stdin),
  }),
  reporter,
});
