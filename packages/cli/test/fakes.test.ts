import { describe, expect, it } from 'vitest';

import { scriptedPrompter } from './fakes.ts';

const choices = [
  { value: 'global', label: 'Global' },
  { value: 'project', label: 'This project' },
] as const;

describe('scriptedPrompter: a scripted answer of the wrong kind fails at its question (QA-03)', () => {
  it('gives each answer of the right kind back', async () => {
    const { prompter } = scriptedPrompter([true, 'project', ['global'], 'ahmed', 'secret']);
    expect(await prompter.confirm('Go on?')).toBe(true);
    expect(await prompter.select('Which?', choices)).toBe('project');
    expect(await prompter.multiselect('Which ones?', choices)).toEqual(['global']);
    expect(await prompter.text('Username')).toBe('ahmed');
    expect(await prompter.password('Password')).toBe('secret');
  });

  it('refuses a choice where a yes/no is asked, though the string is truthy', () => {
    const { prompter } = scriptedPrompter(['global']);
    expect(() => prompter.confirm('Go on?')).toThrow('"Go on?" expected yes/no, got "global"');
  });

  it('refuses a select answer that is not one of the choices', () => {
    const { prompter } = scriptedPrompter([true]);
    expect(() => prompter.select('Which?', choices)).toThrow(
      '"Which?" expected one of global, project, got true',
    );
  });

  it('refuses a checklist answer that is not a list of choices', () => {
    expect(() => scriptedPrompter(['global']).prompter.multiselect('Which ones?', choices)).toThrow(
      'expected a list',
    );
    expect(() =>
      scriptedPrompter([['global', 'other']]).prompter.multiselect('Which ones?', choices),
    ).toThrow('got "other"');
  });

  it('refuses a yes/no where text or a password is asked', () => {
    expect(() => scriptedPrompter([false]).prompter.text('Username')).toThrow(
      '"Username" expected text, got false',
    );
    expect(() => scriptedPrompter([false]).prompter.password('Password')).toThrow(
      '"Password" expected text, got false',
    );
  });
});
