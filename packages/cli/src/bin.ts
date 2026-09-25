#!/usr/bin/env node
/** The `agentnomad` executable: parses the command line and sets the exit code. */
import { NOT_YET_AVAILABLE } from './cli/commands.ts';
import { runCli } from './cli/run.ts';
import { createClackReporter } from './ui/clack-prompter.ts';

process.exitCode = await runCli(process.argv.slice(2), {
  handlers: NOT_YET_AVAILABLE,
  reporter: createClackReporter(),
});
