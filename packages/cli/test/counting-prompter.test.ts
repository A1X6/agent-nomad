import { describe, expect, it } from 'vitest';

import { scriptedPrompter } from './fakes.ts';
import { countingPrompter } from '../src/index.ts';

const CHOICES = [
  { value: 'global', label: 'Global setup' },
  { value: 'project', label: 'This project' },
] as const;

describe('countingPrompter (T115)', () => {
  it('counts every kind of question and passes each answer through', async () => {
    const script = scriptedPrompter(['global', ['project'], 'my-app', 'secret', true]);
    const questions = countingPrompter(script.prompter);
    expect(await questions.prompter.select('Which?', CHOICES)).toBe('global');
    expect(await questions.prompter.multiselect('Which ones?', CHOICES)).toEqual(['project']);
    expect(await questions.prompter.text('Name?')).toBe('my-app');
    expect(await questions.prompter.password('Password?')).toBe('secret');
    expect(await questions.prompter.confirm('Sure?', false)).toBe(true);
    expect(questions.asked()).toBe(5);
    expect(script.asked).toEqual(['Which?', 'Which ones?', 'Name?', 'Password?', 'Sure?']);
  });

  it('counts nothing before a question is asked', () => {
    expect(countingPrompter(scriptedPrompter([]).prompter).asked()).toBe(0);
  });
});
