import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { collected } from './fakes.ts';

import {
  followImports,
  GLOBAL_MEMORY_FILES,
  globalImportPlace,
  importsIn,
  importsOf,
  MAX_IMPORT_HOPS,
  PROJECT_MEMORY_FILES,
  projectImportPlace,
  resolveImport,
  type ImportSource,
  type MemoryFile,
} from '../src/index.ts';

// The rules read no file, so these folders need not exist.
const home = resolve('/home/me');
const base = join(home, '.claude');
const project = resolve('/work/my-app');
const context = { homedir: home, platform: process.platform };
const globalContext = { ...context, baseDir: base };
const projectContext = { projectDir: project, platform: process.platform };

/** The paths `text` imports, as written after the `@`. */
const importedPaths = (text: string) => importsIn(text).map((entry) => entry.path);

describe('claude-md imports: what counts as an import (Claude Code 2.1.296 UZn)', () => {
  it('reads an import at the start of the text', () => {
    expect(importedPaths('@docs/style.md')).toEqual(['docs/style.md']);
  });

  it('reads an import after white space, on any line', () => {
    expect(importedPaths('See the guide:\n- @docs/a.md and\t@docs/b.md')).toEqual([
      'docs/a.md',
      'docs/b.md',
    ]);
  });

  it('ends the path at the first white space', () => {
    expect(importedPaths('@docs/a.md is the guide')).toEqual(['docs/a.md']);
  });

  it('keeps a space written as a backslash and a space', () => {
    expect(importedPaths('@Design\\ Docs/a.md')).toEqual(['Design Docs/a.md']);
  });

  it('cuts the path at #', () => {
    expect(importedPaths('@docs/a.md#setup')).toEqual(['docs/a.md']);
  });

  it('takes no @ inside a word, such as an email address', () => {
    expect(importedPaths('Mail me@example.com')).toEqual([]);
  });

  it('takes no quoted path', () => {
    expect(importedPaths('"@docs/a.md"')).toEqual([]);
  });

  it.each([['@/'], ['@@team'], ['@#heading'], ['@(note)'], ['@%x'], ['@!x']])(
    'takes no import from %s',
    (text) => {
      expect(importedPaths(text)).toEqual([]);
    },
  );

  it.each([['@./a.md'], ['@~/a.md'], ['@/etc/a.md'], ['@../a.md'], ['@_a.md'], ['@A.md']])(
    'takes %s as an import',
    (text) => {
      expect(importedPaths(text)).toEqual([text.slice(1)]);
    },
  );

  it('never takes a network path', () => {
    expect(importedPaths('@//server/share/a.md')).toEqual([]);
  });

  it('gives the line and the import as written', () => {
    expect(importsIn('# Title\n\nSee @docs/a.md#top')).toEqual([
      { line: 3, written: '@docs/a.md#top', path: 'docs/a.md' },
    ]);
  });
});

describe('claude-md imports: what is skipped', () => {
  it('skips a code span', () => {
    expect(importedPaths('Write `@docs/a.md` to import a file.')).toEqual([]);
  });

  it('skips a code span of two backticks holding one', () => {
    expect(importedPaths('``a ` @docs/a.md`` and @docs/b.md')).toEqual(['docs/b.md']);
  });

  it('reads an unclosed backtick as text', () => {
    expect(importedPaths('a ` @docs/a.md')).toEqual(['docs/a.md']);
  });

  it('opens no code span with an escaped backtick', () => {
    expect(importedPaths('a \\` @docs/a.md `')).toEqual(['docs/a.md']);
  });

  it('ends a code span at the end of its paragraph', () => {
    expect(importedPaths('a `b\n\n@docs/a.md `')).toEqual(['docs/a.md']);
  });

  it('skips a fenced code block of backticks', () => {
    expect(importedPaths('```md\n@docs/a.md\n```\n@docs/b.md')).toEqual(['docs/b.md']);
  });

  it('skips a fenced code block of tildes', () => {
    expect(importedPaths('~~~\n@docs/a.md\n~~~\n@docs/b.md')).toEqual(['docs/b.md']);
  });

  it('closes a fence only with as many of the same character', () => {
    expect(importedPaths('````\n```\n@docs/a.md\n~~~~\n````\n@docs/b.md')).toEqual(['docs/b.md']);
  });

  it('skips an unclosed fenced block to the end', () => {
    expect(importedPaths('@docs/a.md\n```\n@docs/b.md')).toEqual(['docs/a.md']);
  });

  // BUG-01 (review 15): CLAUDE.md files on Windows often end their lines in CRLF.
  it('skips a fenced code block with a blank line in a CRLF file', () => {
    const text = 'Intro\n\n```sh\necho hi\n\n@notes.md\n```\n\nAfter @real.md\n';
    expect(importedPaths(text.replace(/\n/g, '\r\n'))).toEqual(['real.md']);
  });

  it('opens no fence indented four spaces', () => {
    expect(importedPaths('    ```\n@docs/a.md')).toEqual(['docs/a.md']);
  });

  it('skips an HTML comment', () => {
    expect(importedPaths('<!-- @docs/a.md\n-->\n@docs/b.md')).toEqual(['docs/b.md']);
  });

  it('skips the frontmatter', () => {
    expect(importedPaths('---\npaths: "@docs/a.md"\n---\n@docs/b.md')).toEqual(['docs/b.md']);
  });
});

describe('claude-md imports: where an import points', () => {
  it('reads a relative path from the importing file', () => {
    expect(resolveImport('../notes/a.md', join(base, 'CLAUDE.md'), context)).toBe(
      join(home, 'notes', 'a.md'),
    );
  });

  it('reads ~/ as the home folder', () => {
    expect(resolveImport('~/notes/a.md', join(project, 'CLAUDE.md'), context)).toBe(
      join(home, 'notes', 'a.md'),
    );
  });

  it('keeps an absolute path', () => {
    expect(resolveImport(resolve('/srv/a.md'), join(project, 'CLAUDE.md'), context)).toBe(
      resolve('/srv/a.md'),
    );
  });

  it('reads /c/ as the C: drive on Windows', () => {
    expect(
      resolveImport('/c/notes/a.md', 'C:\\Users\\me\\.claude\\CLAUDE.md', {
        homedir: 'C:\\Users\\me',
        platform: 'win32',
      }),
    ).toBe('c:\\notes\\a.md');
  });
});

describe('claude-md imports: where push saves a global import', () => {
  it('saves a file in the base folder at its path there', () => {
    expect(globalImportPlace(join(base, 'notes', 'a.md'), globalContext)).toEqual({
      kind: 'bundle',
      bundlePath: 'notes/a.md',
    });
  });

  it('saves a file elsewhere in the home under .agentnomad/home/', () => {
    expect(globalImportPlace(join(home, 'notes', 'a.md'), globalContext)).toEqual({
      kind: 'bundle',
      bundlePath: '.agentnomad/home/notes/a.md',
    });
  });

  it.each([['projects/x/memory/MEMORY.md'], ['plugins/cache/a.md'], ['.agentnomad/notes.md']])(
    'refuses %s in the base folder',
    (relative) => {
      expect(globalImportPlace(join(base, ...relative.split('/')), globalContext)).toEqual({
        kind: 'refused',
        reason: 'it is in a folder agentnomad never syncs',
      });
    },
  );

  it('refuses a file in a folder for keys and logins', () => {
    expect(globalImportPlace(join(home, '.ssh', 'notes.md'), globalContext)).toEqual({
      kind: 'refused',
      reason: 'it is in a folder for keys and logins',
    });
  });

  it('refuses a file in a folder whose files run by themselves', () => {
    expect(globalImportPlace(join(home, '.config', 'autostart', 'a.md'), globalContext)).toEqual({
      kind: 'refused',
      reason: 'it is in a folder whose files run by themselves',
    });
  });

  it('refuses a file outside the home folder', () => {
    expect(globalImportPlace(resolve('/srv/a.md'), globalContext)).toEqual({
      kind: 'refused',
      reason: 'it is outside the home folder',
    });
  });

  it.each([
    ['notes/run.sh'],
    ['notes/tool.ts'],
    ['.bashrc'],
    ['notes/Makefile'],
    ['.claude.json'],
    ['.config/tool/settings.yaml'],
  ])('refuses %s, which is not Markdown or plain text', (relative) => {
    expect(globalImportPlace(join(home, ...relative.split('/')), globalContext)).toEqual({
      kind: 'refused',
      reason:
        'agentnomad saves an imported file only when it is Markdown or plain text, never code, settings, a script or a file without an extension',
    });
  });
});

describe('claude-md imports: where push saves a project import', () => {
  it('saves a file inside the project at its project path', () => {
    expect(projectImportPlace(join(project, 'docs', 'a.md'), projectContext)).toEqual({
      kind: 'bundle',
      bundlePath: 'docs/a.md',
    });
  });

  it('refuses a file outside the project', () => {
    expect(projectImportPlace(join(home, 'a.md'), projectContext)).toEqual({
      kind: 'refused',
      reason: 'it is outside the project',
    });
  });

  it('refuses a file in .git', () => {
    expect(projectImportPlace(join(project, '.git', 'info', 'a.md'), projectContext)).toEqual({
      kind: 'refused',
      reason: 'it is in a folder agentnomad never syncs',
    });
  });
});

/** A source over `files` (path from the project: text); every place is its project path. */
function projectSource(files: Readonly<Record<string, string>>): ImportSource {
  const byNative = new Map(
    Object.entries(files).map(([relative, text]) => [join(project, relative), text]),
  );
  return {
    place: (nativePath) => projectImportPlace(nativePath, projectContext),
    read: (nativePath) => Promise.resolve(byNative.get(nativePath) ?? null),
    isFile: (nativePath) => Promise.resolve(byNative.has(nativePath)),
  };
}

/** The project's CLAUDE.md with `text`. */
const claudeMd = (text: string): MemoryFile => ({
  nativePath: join(project, 'CLAUDE.md'),
  bundlePath: 'CLAUDE.md',
  text,
});

describe('claude-md imports: following them', () => {
  it('follows the imports of an imported file', async () => {
    const found = await followImports(
      [claudeMd('@a.md')],
      projectSource({ 'a.md': '@docs/b.md', 'docs/b.md': 'B' }),
      context,
    );
    expect(found.files.map((file) => file.bundlePath)).toEqual(['a.md', 'docs/b.md']);
  });

  it('reads an import in an imported file from that file', async () => {
    const found = await followImports(
      [claudeMd('@docs/a.md')],
      projectSource({ 'docs/a.md': '@b.md', 'docs/b.md': 'B' }),
      context,
    );
    expect(found.files.map((file) => file.bundlePath)).toEqual(['docs/a.md', 'docs/b.md']);
  });

  it(`follows ${String(MAX_IMPORT_HOPS)} hops and no more`, async () => {
    const found = await followImports(
      [claudeMd('@1.md')],
      projectSource({
        '1.md': '@2.md',
        '2.md': '@3.md',
        '3.md': '@4.md',
        '4.md': '@5.md',
        '5.md': '',
      }),
      context,
    );
    expect(found.files.map((file) => file.bundlePath)).toEqual(['1.md', '2.md', '3.md', '4.md']);
  });

  it('takes each file once, even in a loop', async () => {
    const found = await followImports(
      [claudeMd('@a.md @a.md')],
      projectSource({ 'a.md': '@CLAUDE.md @a.md' }),
      context,
    );
    expect(found.files.map((file) => file.bundlePath)).toEqual(['a.md']);
  });

  it('skips a missing file without a word', async () => {
    const found = await followImports([claudeMd('@missing.md')], projectSource({}), context);
    expect(found).toEqual({ files: [], skipped: [] });
  });

  it('reports a file it cannot take, with who imports it and how', async () => {
    const outside = join(home, 'a.md');
    const source: ImportSource = { ...projectSource({}), isFile: () => Promise.resolve(true) };
    const found = await followImports([claudeMd('Read\n@~/a.md')], source, context);
    expect(found.skipped).toEqual([
      {
        nativePath: outside,
        importer: join(project, 'CLAUDE.md'),
        line: { line: 2, written: '@~/a.md', path: '~/a.md' },
        reason: 'it is outside the project',
      },
    ]);
  });

  it('follows no import of a file it cannot take', async () => {
    const found = await followImports(
      [claudeMd('@run.sh')],
      projectSource({ 'run.sh': '@a.md', 'a.md': 'A' }),
      context,
    );
    expect(found.files).toEqual([]);
  });
});

describe('claude-md imports: the memory files of a setup (DUP-03)', () => {
  it("follows the imports of a project's memory files and rules at any depth, no other file", async () => {
    const found = await importsOf(
      project,
      PROJECT_MEMORY_FILES,
      [
        collected('AGENTS.md', '@a.md'),
        collected('.claude/rules/deep/style.md', '@b.md'),
        collected('.claude/rules/notes.txt', '@c.md'),
        collected('README.md', '@d.md'),
      ],
      projectSource({ 'a.md': 'A', '.claude/rules/deep/b.md': 'B', 'c.md': 'C', 'd.md': 'D' }),
      context,
    );
    expect(found.files.map((file) => file.bundlePath)).toEqual(['a.md', '.claude/rules/deep/b.md']);
  });

  it("follows the imports of the global CLAUDE.md and rules, not a project's AGENTS.md", async () => {
    const files = { 'a.md': 'A', 'rules/b.md': 'B', 'c.md': 'C' };
    const byNative = new Map(
      Object.entries(files).map(([relative, text]) => [join(base, relative), text]),
    );
    const found = await importsOf(
      base,
      GLOBAL_MEMORY_FILES,
      [
        collected('CLAUDE.md', '@a.md'),
        collected('rules/style.md', '@b.md'),
        collected('AGENTS.md', '@c.md'),
      ],
      {
        place: (nativePath) => globalImportPlace(nativePath, globalContext),
        read: (nativePath) => Promise.resolve(byNative.get(nativePath) ?? null),
        isFile: () => Promise.resolve(false),
      },
      context,
    );
    expect(found.files.map((file) => file.bundlePath)).toEqual(['a.md', 'rules/b.md']);
  });
});
