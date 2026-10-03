/**
 * `agentnomad push` with one question answered (T56): which environment values to save. The
 * CLI asks that only in a terminal, and the e2e PCs have none, so this runs the same handlers
 * in a child process of the PC (its environment, folders and keychain rule; see pc.ts).
 *
 * Usage: node push-env-value.ts <NAME,…> <push options as JSON>
 */
import { homedir, hostname } from 'node:os';

import { createAppHandlers, type Prompter, type Reporter } from '@agentnomad/cli';

const names = (process.argv[2] ?? '').split(',');
const options = JSON.parse(process.argv[3] ?? '{}') as Parameters<
  ReturnType<typeof createAppHandlers>['push']
>[0];

const refuse = (message: string) => Promise.reject(new Error(`Not scripted: "${message}"`));
const prompter: Prompter = {
  select: refuse,
  text: refuse,
  password: refuse,
  confirm: refuse,
  multiselect: <T extends string>(message: string) =>
    message.startsWith('Save these values')
      ? Promise.resolve(names as T[])
      : (refuse(message) as Promise<T[]>),
};
const print = (stream: NodeJS.WriteStream) => (message: string) => stream.write(`${message}\n`);
const reporter: Reporter = {
  info: print(process.stdout),
  success: print(process.stdout),
  warn: print(process.stderr),
  error: print(process.stderr),
  spinner: () => ({ start: () => undefined, stop: () => undefined }),
};

await createAppHandlers({
  env: process.env,
  platform: process.platform,
  homedir: homedir(),
  hostname: hostname(),
  cwd: process.cwd(),
  prompter,
  reporter,
}).push(options);
