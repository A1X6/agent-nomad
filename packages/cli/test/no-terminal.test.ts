import { describe, expect, it } from 'vitest';

import { AnswerNeededError, createNoTerminalPrompter } from '../src/index.ts';

describe('no-terminal prompter', () => {
  it('never asks: every question fails with the question in the message', async () => {
    const prompter = createNoTerminalPrompter();
    const questions = [
      prompter.select('Which project?', [{ value: 'a', label: 'a' }]),
      prompter.multiselect('Which agents?', [{ value: 'a', label: 'a' }]),
      prompter.text('Username'),
      prompter.password('Password'),
      prompter.confirm('Allow them?', true),
    ];
    for (const question of questions)
      await expect(question).rejects.toBeInstanceOf(AnswerNeededError);
    await expect(prompter.confirm('Allow them?')).rejects.toThrow(
      '"Allow them?" needs an answer, but there is no terminal to ask in.',
    );
  });
});
