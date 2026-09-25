import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { unwrapAnswer } from '../src/ui/clack-prompter.ts';
import { PromptCancelledError } from '../src/ui/prompter.ts';
import * as clack from '@clack/prompts';

const cliRoot = fileURLToPath(new URL('..', import.meta.url));

/** Runs the real `agentnomad` entry file with plain Node (type stripping, no build). */
function agentnomad(...args: string[]) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--conditions=agentnomad-source',
      'src/bin.ts',
      ...args,
    ],
    { cwd: cliRoot, encoding: 'utf8', timeout: 60_000 },
  );
}

describe('the agentnomad executable', () => {
  it('agentnomad --help works (T20 done-when)', () => {
    const result = agentnomad('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: agentnomad');
    expect(result.stdout).toContain('push');
  });

  it('exits with 1 on a usage error', () => {
    const result = agentnomad('nope');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown command 'nope'");
  });
});

describe('clack answers', () => {
  it('passes answers through and turns a cancel into PromptCancelledError', () => {
    expect(unwrapAnswer('claude-code')).toBe('claude-code');
    expect(() => unwrapAnswer(clack.CANCEL_SYMBOL)).toThrow(PromptCancelledError);
  });
});

describe('agentnomad agents (T28 done-when)', () => {
  it('lists Claude Code', () => {
    const result = agentnomad('agents');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Claude Code');
    expect(result.stdout).toContain('supported agent');
  });
});
