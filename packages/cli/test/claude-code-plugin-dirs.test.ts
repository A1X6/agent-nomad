import { readdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MOD_MODULE,
  MOD_NAME,
  modFiles,
  SAVED_PLUGIN_DIR_ENTRY,
  savedFiles,
  savedPluginDir,
  scriptedGit,
  validateCli,
  validatePassWithWarning,
  writeModFolder,
  type GitAnswer,
} from './claude-code-plugin-fixtures.ts';
import { base, home, root, useProjectFolders } from './claude-code-project-fixtures.ts';
import {
  collected,
  collectedJson,
  executableLookup,
  exists,
  readText,
  recordingReporter,
  scriptedPrompter,
  writeTestFile,
} from './fakes.ts';
import {
  createClaudeCodeRestorer,
  findPluginValidator,
  planPluginDirs,
  pluginDirFiles,
  pluginDirsSeparator,
  readSavedPluginDir,
  savedPluginDirMods,
  splitPluginDirs,
  type CollectedFile,
  type ConflictChoice,
  type ProgramCli,
} from '../src/index.ts';

/** Plugin folders `env.CLAUDE_CODE_PLUGIN_DIRS` loads (T99): what push saves, how pull writes. */

useProjectFolders('agentnomad-plugin-dirs-');

const VARIABLE = 'CLAUDE_CODE_PLUGIN_DIRS';
const COMMIT = '3f2a9c1e5b7d4a6f8e0c2b4d6f8a0c2e4b6d8f0a';
const REMOTE = 'https://example.com/me/probe-mod.git';
const SAVED_PATH = '.agentnomad/plugin-dirs/0.json';
/** The plugin folder in the tests, in home. */
const modFolder = () => join(home, 'dev', MOD_NAME);
/** The separator of the PC that is not this one, for a value saved there. */
const OTHER_SEPARATOR = delimiter === ';' ? ':' : ';';
const LISTED = modFiles('').map((file) => file.path);

/** `settings.json` with `value` in `env`. */
const settingsWith = (value: string, path = 'settings.json') =>
  collectedJson(path, { model: 'opus', env: { [VARIABLE]: value } });

/** Push of `settings`, with the mod written to `modFolder()` and `git`. */
async function save(settings: CollectedFile, git: ProgramCli | null = null) {
  await writeModFolder(modFolder());
  const skipped: string[] = [];
  const files = await pluginDirFiles(settings, {
    homedir: home,
    platform: process.platform,
    git: () => Promise.resolve(git),
    onSkipped: (what, reason) => skipped.push(`${what}: ${reason}`),
  });
  const [file] = files;
  const read = file === undefined ? null : readSavedPluginDir(file.content);
  const saved = read !== null && 'value' in read ? read.value : null;
  return { files, saved, skipped };
}

describe('the value of CLAUDE_CODE_PLUGIN_DIRS (T99)', () => {
  it('is split on ; on Windows', () => {
    expect(pluginDirsSeparator('win32')).toBe(';');
  });

  it('is split on : on macOS and Linux', () => {
    expect(pluginDirsSeparator('darwin')).toBe(':');
  });

  it('keeps a Windows drive letter when split on ;', () => {
    expect(splitPluginDirs('C:/plugins/a;D:/b', ';')).toEqual(['C:/plugins/a', 'D:/b']);
  });

  it('names its folders trimmed, without empty ones', () => {
    expect(splitPluginDirs(' /a ::/b:', ':')).toEqual(['/a', '/b']);
  });
});

describe('the mods in saved plugin folders, for the version warning (T104)', () => {
  it('names a folder with hooks/hooks.json as Claude Code does, by its manifest', () => {
    expect(savedPluginDirMods([savedPluginDir(OTHER_SEPARATOR)])).toEqual(['probe-mod@inline']);
  });

  it('leaves out a folder without hooks/hooks.json', () => {
    const noHooks = modFiles('').filter((file) => file.path !== 'hooks/hooks.json');
    expect(
      savedPluginDirMods([savedPluginDir(OTHER_SEPARATOR, { files: savedFiles(noHooks) })]),
    ).toEqual([]);
  });

  it('leaves out a saved plugin folder it cannot read', () => {
    expect(savedPluginDirMods([collected(SAVED_PATH, 'not json')])).toEqual([]);
  });
});

describe('push saves the plugin folders the user settings name (T99)', () => {
  it('saves one reserved entry per folder, numbered by its place in the value', async () => {
    const { files } = await save(settingsWith(`/missing${delimiter}${modFolder()}`));
    expect(files.map((file) => file.path)).toEqual(['.agentnomad/plugin-dirs/1.json']);
  });

  it('reads the value from the user settings only', async () => {
    const { files } = await save(settingsWith(modFolder(), 'settings.local.json'));
    expect(files).toEqual([]);
  });

  it('saves nothing when the settings set no folder', async () => {
    const { files } = await save(collectedJson('settings.json', { env: { OTHER: '1' } }));
    expect(files).toEqual([]);
  });

  it("saves each folder's files", async () => {
    const { saved } = await save(settingsWith(modFolder()));
    expect(saved?.files.map((file) => file.path).sort()).toEqual([...LISTED].sort());
  });

  it('saves the files with their content', async () => {
    const { saved } = await save(settingsWith(modFolder()));
    const module = saved?.files.find((file) => file.path === 'hooks/register.ts');
    expect(Buffer.from(module?.content ?? '', 'base64').toString('utf8')).toBe(MOD_MODULE);
  });

  it('saves the folder as the value names it, with this PC’s separator', async () => {
    const { saved } = await save(settingsWith(modFolder()));
    expect([saved?.entry, saved?.separator]).toEqual([modFolder(), delimiter]);
  });

  it('saves the folder by its path from home', async () => {
    const { saved } = await save(settingsWith(modFolder()));
    expect(saved?.path).toBe(`dev/${MOD_NAME}`);
  });

  it('reads a folder written from ~ in home', async () => {
    const { saved } = await save(settingsWith(`~/dev/${MOD_NAME}`));
    expect(saved?.path).toBe(`dev/${MOD_NAME}`);
  });

  it('saves no path for a folder outside home', async () => {
    const outside = join(root, MOD_NAME);
    await writeModFolder(outside);
    const { saved } = await save(settingsWith(outside));
    expect(saved?.path).toBeNull();
  });

  it('saves the remote and the commit of a folder at the top of a pushed repository', async () => {
    const git: Readonly<Record<string, GitAnswer>> = {
      'rev-parse --show-prefix': { stdout: '\n' },
      'ls-files -z --cached --others --exclude-standard': { stdout: `${LISTED.join('\0')}\0` },
      'rev-parse HEAD': { stdout: `${COMMIT}\n` },
      'branch -r --contains HEAD': { stdout: '  origin/main\n' },
      'remote get-url origin': { stdout: `${REMOTE}\n` },
    };
    const { saved } = await save(settingsWith(modFolder()), scriptedGit(git).git);
    expect(saved?.git).toEqual({ remote: REMOTE, commit: COMMIT });
  });

  it('leaves out a folder that is not a full path, and says why', async () => {
    const { files, skipped } = await save(settingsWith('dev/probe-mod'));
    expect([files, skipped]).toEqual([
      [],
      [
        'plugin folder dev/probe-mod: it is not a full path, so Claude Code does not load it either',
      ],
    ]);
  });

  it('leaves out a folder that is gone, and says why', async () => {
    const gone = join(home, 'gone');
    const { files, skipped } = await save(settingsWith(gone));
    expect([files, skipped]).toEqual([
      [],
      [`plugin folder ${gone}: its folder ${gone} is missing`],
    ]);
  });

  it('leaves out a folder larger than the server takes, and says why', async () => {
    await writeTestFile(join(modFolder(), 'big.bin'), new Uint8Array(5 * 1024 * 1024 + 1));
    const { files, skipped } = await save(settingsWith(modFolder()));
    expect([files, skipped]).toEqual([
      [],
      [
        `plugin folder ${modFolder()}: its files are 5.0 MB, more than the 5.0 MB a saved setup can hold. Ignore large files in git or move them out of the folder, then push again`,
      ],
    ]);
  });
});

/** The saved entry `n` of the mod folder, saved on the other OS, with `overrides`. */
const savedMod = (overrides: object = {}, n = 0) => savedPluginDir(OTHER_SEPARATOR, overrides, n);

/**
 * Pull's plan for `files`, then its restore: `git` re-clones, `answers` answer the review's
 * questions, `conflict` each file that differs; `--allow-commands` unless `flags` say else.
 */
async function pull(
  files: CollectedFile[],
  options: {
    git?: ProgramCli;
    answers?: unknown[];
    conflict?: ConflictChoice;
    flags?: { assumeYes: boolean; allowCommands: boolean };
  } = {},
) {
  const fake = validateCli(validatePassWithWarning);
  const lookup = executableLookup({
    platform: 'linux',
    homedir: '/home/a',
    env: { PATH: '/usr/bin' },
    executables: ['/usr/bin/claude'],
  });
  const validator = await findPluginValidator(lookup, fake.cli);
  const script = scriptedPrompter(options.answers ?? []);
  const { reporter, lines } = recordingReporter({ levels: false });
  const conflicts: string[] = [];
  const restorer = createClaudeCodeRestorer({
    baseDir: base,
    homedir: home,
    platform: process.platform,
    env: {},
    customConfigDir: false,
    isClaudeRunning: () => Promise.resolve(false),
  });
  const plan = await planPluginDirs(
    {
      files,
      prompter: script.prompter,
      reporter,
      ...(options.flags ?? { assumeYes: false, allowCommands: true }),
      askConflict: (path) => {
        conflicts.push(path);
        return Promise.resolve(options.conflict ?? 'skip');
      },
    },
    {
      homedir: home,
      baseDir: base,
      platform: process.platform,
      validator: () => Promise.resolve(validator),
      restorer,
      git: () => Promise.resolve(options.git ?? null),
    },
  );
  const report = await plan.restore(() => Promise.resolve('skip'));
  return { plan, report, lines, conflicts, asked: script.asked };
}

/** The value in `settings.json` among `files`. */
const valueIn = (files: readonly CollectedFile[]) => {
  const settings = files.find((file) => file.path === 'settings.json');
  const parsed = JSON.parse(new TextDecoder().decode(settings?.content)) as {
    env: Record<string, string>;
  };
  return parsed.env[VARIABLE];
};

const MODULE = ['hooks', 'register.ts'] as const;

describe('pull writes a saved plugin folder (T99)', () => {
  it('writes the folder to the same path from home', async () => {
    await pull([savedMod()]);
    expect(await readText(join(modFolder(), ...MODULE))).toBe(MOD_MODULE);
  });

  it('writes a folder that was outside home to ~/.agentnomad/plugin-dirs/<name>', async () => {
    await pull([savedMod({ path: null })]);
    expect(await readText(join(home, '.agentnomad', 'plugin-dirs', MOD_NAME, ...MODULE))).toBe(
      MOD_MODULE,
    );
  });

  it('never writes into a folder for keys and logins: ~/.agentnomad/plugin-dirs instead', async () => {
    await pull([savedMod({ path: `.ssh/${MOD_NAME}` })]);
    expect(await exists(join(home, '.agentnomad', 'plugin-dirs', MOD_NAME))).toBe(true);
  });

  it('gives two folders of the same name outside home a folder each', async () => {
    const { plan } = await pull([
      savedMod({ path: null }),
      savedMod({ path: null, entry: '/b' }, 1),
    ]);
    const value = `${SAVED_PLUGIN_DIR_ENTRY}${OTHER_SEPARATOR}/b`;
    expect(valueIn(plan.withPluginDirs([settingsWith(value)]))).toBe(
      [
        join(home, '.agentnomad', 'plugin-dirs', MOD_NAME),
        join(home, '.agentnomad', 'plugin-dirs', `${MOD_NAME}-2`),
      ].join(delimiter),
    );
  });

  it('points the value at the folder it wrote, with this PC’s separator', async () => {
    const { plan } = await pull([savedMod()]);
    const value = `${SAVED_PLUGIN_DIR_ENTRY}${OTHER_SEPARATOR}/not/saved`;
    expect(valueIn(plan.withPluginDirs([settingsWith(value)]))).toBe(
      `${modFolder()}${delimiter}/not/saved`,
    );
  });

  it('keeps a drive letter the home path brought into a value saved with : (T104)', async () => {
    const entry = `C:/pc/home/dev/${MOD_NAME}`;
    const { plan } = await pull([savedMod({ entry, separator: ':' })]);
    const value = `${entry}:/not/saved`;
    expect(valueIn(plan.withPluginDirs([settingsWith(value)]))).toBe(
      `${modFolder()}${delimiter}/not/saved`,
    );
  });

  it('finds a folder the value names in another form of the same path', async () => {
    const { plan } = await pull([savedMod()]);
    const value = `${SAVED_PLUGIN_DIR_ENTRY}/`;
    expect(valueIn(plan.withPluginDirs([settingsWith(value)]))).toBe(modFolder());
  });

  it('leaves the settings as they are when the value already names the folder', async () => {
    const { plan } = await pull([savedMod({ entry: modFolder(), separator: delimiter })]);
    const settings = settingsWith(modFolder());
    expect(plan.withPluginDirs([settings])).toEqual([settings]);
  });

  it('keeps the rest of the settings when it rewrites the value', async () => {
    const { plan } = await pull([savedMod()]);
    const [settings] = plan.withPluginDirs([settingsWith(SAVED_PLUGIN_DIR_ENTRY)]);
    expect(JSON.parse(new TextDecoder().decode(settings?.content))).toEqual({
      model: 'opus',
      env: { [VARIABLE]: modFolder() },
    });
  });

  it('re-clones the folder at the saved commit, then writes the saved files', async () => {
    const clone = `clone --no-checkout --quiet -- ${REMOTE} ${modFolder()}`;
    const { git, calls } = scriptedGit({ [clone]: {}, [`reset --quiet ${COMMIT}`]: {} });
    await pull([savedMod({ git: { remote: REMOTE, commit: COMMIT } })], { git });
    expect(calls.map((call) => call.args)).toEqual([clone, `reset --quiet ${COMMIT}`]);
  });

  it('asks about a file that is here and differs, by its saved name', async () => {
    await writeTestFile(join(modFolder(), ...MODULE), 'mine');
    const { conflicts } = await pull([savedMod()]);
    expect(conflicts).toEqual(['.agentnomad/plugin-dirs/0/hooks/register.ts']);
  });

  it('reviews the folder before writing it, and --yes alone declines it (T97)', async () => {
    const { lines } = await pull([savedMod()], {
      flags: { assumeYes: true, allowCommands: false },
    });
    expect(lines).toContain(
      `Skipped ${modFolder()}: ${MOD_NAME}@inline runs code inside Claude Code. --yes never accepts a plugin with code; add --allow-commands to accept it.`,
    );
  });

  it('writes nothing of a declined folder, and notes it', async () => {
    const { plan } = await pull([savedMod()], {
      flags: { assumeYes: true, allowCommands: false },
    });
    expect([plan.declined, await exists(modFolder())]).toEqual([true, false]);
  });

  it('takes a declined folder out of the value', async () => {
    const { plan } = await pull([savedMod()], {
      flags: { assumeYes: true, allowCommands: false },
    });
    const value = `${SAVED_PLUGIN_DIR_ENTRY}${OTHER_SEPARATOR}/not/saved`;
    expect(valueIn(plan.withPluginDirs([settingsWith(value)]))).toBe('/not/saved');
  });

  it('writes a folder after a yes in the review', async () => {
    const { asked } = await pull([savedMod()], {
      flags: { assumeYes: false, allowCommands: false },
      answers: [true],
    });
    expect([asked, await readdir(modFolder())]).toEqual([
      [`Write ${MOD_NAME}@inline? It runs code inside Claude Code.`],
      ['.claude-plugin', 'hooks'],
    ]);
  });

  it('says so when a saved plugin folder cannot be read, and writes nothing', async () => {
    const { lines } = await pull([collected(SAVED_PATH, '{"name": "probe-mod"}')]);
    expect(
      lines.some((line) =>
        line.startsWith(`The saved plugin folder ${SAVED_PATH} could not be read:`),
      ),
    ).toBe(true);
  });
});
