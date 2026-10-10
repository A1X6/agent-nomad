import { describe, expect, it } from 'vitest';

import { modFiles } from './claude-code-plugin-fixtures.ts';
import { collected, collectedJson, paths } from './fakes.ts';
import { isGeneratedInSkillsPlugin, skillsPluginFolders, skillsPluginsNote } from '../src/index.ts';

/** Plugins and mods in `~/.claude/skills/` (T97): which folders they are, and what is generated. */

/** A plugin in `skills/notes/` with a skill and no hooks. */
const plainPlugin = [
  collectedJson('skills/notes/.claude-plugin/plugin.json', { name: 'notes' }),
  collected('skills/notes/skills/write/SKILL.md', '# Write'),
];

describe('what Claude Code generates in a skills-folder plugin (T97)', () => {
  it.each([
    'skills/probe-mod/.claude-plugin/types',
    'skills/probe-mod/.claude-plugin/types/register.d.ts',
    'skills/probe-mod/.Claude-Plugin/Types/register.d.ts',
  ])('%s is generated', (path) => {
    expect(isGeneratedInSkillsPlugin(path)).toBe(true);
  });

  it.each([
    'skills/probe-mod/.claude-plugin/plugin.json',
    'skills/probe-mod/types/register.d.ts',
    'skills/.claude-plugin/types/x.d.ts',
    'commands/probe-mod/.claude-plugin/types/x.d.ts',
  ])('%s is not', (path) => {
    expect(isGeneratedInSkillsPlugin(path)).toBe(false);
  });
});

describe('plugin folders in skills/ (T97)', () => {
  it('a folder with .claude-plugin/plugin.json is a plugin named <name>@skills-dir', () => {
    const [folder] = skillsPluginFolders(plainPlugin);
    expect(folder?.id).toBe('notes@skills-dir');
    expect(paths(folder?.files ?? [])).toEqual([
      '.claude-plugin/plugin.json',
      'skills/write/SKILL.md',
    ]);
  });

  it('a folder with hooks/hooks.json is a mod', () => {
    expect(skillsPluginFolders(modFiles()).map((folder) => folder.mod)).toEqual([true]);
  });

  it('a skill without a manifest is no plugin', () => {
    expect(skillsPluginFolders([collected('skills/plain/SKILL.md', '# Plain')])).toEqual([]);
  });

  it('skills/synced/ is never a plugin folder', () => {
    const synced = [collectedJson('skills/synced/.claude-plugin/plugin.json', {})];
    expect(skillsPluginFolders(synced)).toEqual([]);
  });
});

describe("push's note on plugins in skills/ (T97)", () => {
  it('names each plugin, and the ones that run code', () => {
    expect(skillsPluginsNote([...modFiles(), ...plainPlugin])).toBe(
      'Plugins in skills/: notes@skills-dir, probe-mod@skills-dir (runs code)',
    );
  });

  it('says nothing without plugins', () => {
    expect(skillsPluginsNote([collected('skills/plain/SKILL.md', '# Plain')])).toBeNull();
  });
});
