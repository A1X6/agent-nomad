import { describe, expect, it } from 'vitest';

import { agentVersionNotice, compareVersions, unknownEntriesNotice } from '../src/index.ts';

describe('unknown entries notice', () => {
  it('says what was not saved and why', () => {
    expect(unknownEntriesNotice('Claude Code', ['hooks/', 'new-feature.json'])).toBe(
      'Only these are left out, because agentnomad does not know them yet: hooks/, new-feature.json. A newer Claude Code may have added them; if they matter to you, update agentnomad.',
    );
    expect(unknownEntriesNotice('Claude Code', [])).toBeNull();
  });
});

describe('Claude Code version stamp', () => {
  it.each([
    ['2.1.282', '2.1.282', 0],
    ['2.2.0', '2.1.282', 1],
    ['2.1.9', '2.1.10', -1],
    ['2.0.0-beta.3', '2.0.0', 0],
    ['3', '2.9.9', 1],
  ])('%s vs %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });

  it('warns only when the setup came from a newer version', () => {
    expect(agentVersionNotice('Claude Code', '2.2.0', '2.1.282')).toBe(
      'This setup was saved from Claude Code 2.2.0, but this PC has 2.1.282. Update Claude Code so every setting works.',
    );
    expect(agentVersionNotice('Claude Code', '2.1.0', '2.1.282')).toBeNull();
    expect(agentVersionNotice('Claude Code', null, '2.1.282')).toBeNull();
    expect(agentVersionNotice('Claude Code', '2.1.0', null)).toContain('version here is unknown');
  });
});
