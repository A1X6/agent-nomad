#!/usr/bin/env node
/** The `agentnomad` executable: parses the command line and sets the exit code. */
import { homedir, hostname } from 'node:os';

import { createAppHandlers } from './app.ts';
import { runCli } from './cli/run.ts';
import { createClackPrompter, createClackReporter } from './ui/clack-prompter.ts';

const reporter = createClackReporter();

process.exitCode = await runCli(process.argv.slice(2), {
  handlers: createAppHandlers({
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
    hostname: hostname(),
    prompter: createClackPrompter(),
    reporter,
  }),
  reporter,
});
