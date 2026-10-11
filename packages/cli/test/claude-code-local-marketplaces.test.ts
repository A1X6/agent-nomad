import { chmod, readdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  addedFromFolders,
  localCatalog,
  localModId,
  MOD_MODULE,
  MOD_NAME,
  modFiles,
  savedFiles,
  savedLocalMarketplace,
  scriptedGit,
  validatePassWithWarning,
  validatorFor,
  writeLocalMarketplace,
  type GitAnswer,
} from './claude-code-plugin-fixtures.ts';
import {
  base,
  home,
  root,
  testRestorer,
  useProjectFolders,
} from './claude-code-project-fixtures.ts';
import {
  collected,
  collectedJson,
  executableLookup,
  exists,
  readJson,
  readText,
  recordingReporter,
  scriptedPrompter,
  writeTestFile,
} from './fakes.ts';
import {
  findGit,
  homeFolderFor,
  localMarketplaceFiles,
  planLocalMarketplaces,
  readSavedLocalMarketplace,
  savedMarketplaceMods,
  type CollectedFile,
  type ConflictChoice,
  type LocalMarketplaceRestoreDeps,
  type ProgramCli,
} from '../src/index.ts';

/** Marketplaces added from a local folder (T98): what push saves and how pull writes it. */

useProjectFolders('agentnomad-local-markets-');

const TOOLS = 'tools';
const COMMIT = '3f2a9c1e5b7d4a6f8e0c2b4d6f8a0c2e4b6d8f0a';
const REMOTE = 'https://example.com/me/tools.git';
/** A control character, which git would read as part of the remote. */
const BELL = String.fromCharCode(7);
const toolsFolder = () => join(home, 'markets', TOOLS);
const SAVED_PATH = `.agentnomad/local-marketplaces/${TOOLS}.json`;

/** The files of the marketplace `tools` with the mod, paths from its folder. */
const toolsFiles = (): CollectedFile[] => [
  collectedJson('.claude-plugin/marketplace.json', localCatalog(TOOLS)),
  ...modFiles(`${MOD_NAME}/`),
];
const LISTED = toolsFiles().map((file) => file.path);

/** git at the top of a repository listing the marketplace's files, its commit on no remote. */
const REPO: Readonly<Record<string, GitAnswer>> = {
  'rev-parse --show-prefix': { stdout: '\n' },
  'ls-files -z --cached --others --exclude-standard': { stdout: `${LISTED.join('\0')}\0` },
  'rev-parse HEAD': { stdout: `${COMMIT}\n` },
  'branch -r --contains HEAD': { stdout: '' },
};
/** The same repository with its commit on `origin/main`. */
const PUSHED_REPO: Readonly<Record<string, GitAnswer>> = {
  ...REPO,
  'branch -r --contains HEAD': { stdout: '  origin/HEAD -> origin/main\n  origin/main\n' },
  'remote get-url origin': { stdout: 'https://me:secret-token@example.com/me/tools.git\n' },
};

/** Push of the marketplace `tools` in `folder`, added and its mod installed, with `git`. */
async function save(git: ProgramCli | null, folder = toolsFolder()) {
  await writeLocalMarketplace(folder, TOOLS);
  await addedFromFolders(base, { [TOOLS]: folder });
  const skipped: string[] = [];
  const files = await localMarketplaceFiles(
    { baseDir: base, platform: process.platform, scope: { kind: 'global' } },
    {
      homedir: home,
      git: () => Promise.resolve(git),
      onSkipped: (what, reason) => skipped.push(`${what}: ${reason}`),
    },
  );
  const [file] = files;
  const read = file === undefined ? null : readSavedLocalMarketplace(file.content);
  const saved = read !== null && 'value' in read ? read.value : null;
  return { files, saved, skipped };
}

describe('push saves a local marketplace (T98)', () => {
  it('saves one reserved entry per marketplace', async () => {
    const { files } = await save(null);
    expect(files.map((file) => file.path)).toEqual([SAVED_PATH]);
  });

  it('in a git repository, saves only the files git lists', async () => {
    await writeTestFile(join(toolsFolder(), 'build.log'), 'ignored by git');
    const { saved } = await save(scriptedGit(REPO).git);
    expect(saved?.files.map((file) => file.path)).toEqual(LISTED);
  });

  it('outside git, saves the whole folder but .git and the names push always skips', async () => {
    await writeTestFile(join(toolsFolder(), '.git', 'config'), '[core]');
    await writeTestFile(join(toolsFolder(), 'node_modules', 'x.js'), 'x');
    await writeTestFile(join(toolsFolder(), 'NOTES.md'), 'notes');
    const { saved } = await save(null);
    expect(saved?.files.map((file) => file.path).sort()).toEqual([...LISTED, 'NOTES.md'].sort());
  });

  it('saves the files as they are, with their content', async () => {
    const { saved } = await save(null);
    const module = saved?.files.find((file) => file.path === `${MOD_NAME}/hooks/register.ts`);
    expect(Buffer.from(module?.content ?? '', 'base64').toString('utf8')).toBe(MOD_MODULE);
  });

  it('saves the remote, without its login, and the commit when the commit is on the remote', async () => {
    const { saved } = await save(scriptedGit(PUSHED_REPO).git);
    expect(saved?.git).toEqual({ remote: REMOTE, commit: COMMIT });
  });

  it('saves no remote when the commit is on no remote branch', async () => {
    const { saved } = await save(scriptedGit(REPO).git);
    expect(saved?.git).toBeNull();
  });

  it('saves no remote for a folder inside a repository, only its files', async () => {
    const { saved } = await save(
      scriptedGit({ ...PUSHED_REPO, 'rev-parse --show-prefix': { stdout: 'mods/\n' } }).git,
    );
    expect(saved?.git).toBeNull();
  });

  it('saves the folder by its path from home', async () => {
    const { saved } = await save(null);
    expect(saved?.path).toBe('markets/tools');
  });

  it('saves no path for a folder outside home', async () => {
    const { saved } = await save(null, join(root, 'tools'));
    expect(saved?.path).toBeNull();
  });

  it('leaves out a marketplace larger than the server takes, and says why', async () => {
    await writeTestFile(join(toolsFolder(), 'big.bin'), new Uint8Array(5 * 1024 * 1024 + 1));
    const { files, skipped } = await save(null);
    expect(files).toEqual([]);
    expect(skipped).toEqual([
      'marketplace tools: its files are 5.0 MB and 263 B, more than the 5.0 MB a saved setup can hold. Ignore large files in git or move them out of the folder, then push again',
    ]);
  });

  it('leaves out a marketplace whose folder is gone, and says why', async () => {
    await addedFromFolders(base, { [TOOLS]: toolsFolder() });
    const skipped: string[] = [];
    const files = await localMarketplaceFiles(
      { baseDir: base, platform: process.platform, scope: { kind: 'global' } },
      { homedir: home, onSkipped: (what, reason) => skipped.push(`${what}: ${reason}`) },
    );
    expect(files).toEqual([]);
    expect(skipped).toEqual([`marketplace tools: its folder ${toolsFolder()} is missing`]);
  });
});

/** The saved entry of `tools`, as push writes it, with `overrides`. */
const savedTools = (overrides: object = {}) => savedLocalMarketplace(TOOLS, overrides);

describe('the mods in saved local marketplaces, for the version warning (T104)', () => {
  it('names an installed plugin whose folder has hooks/hooks.json', () => {
    expect(savedMarketplaceMods([savedTools()])).toEqual(['probe-mod@tools']);
  });

  it('leaves out a plugin without hooks/hooks.json', () => {
    const noHooks = toolsFiles().filter((file) => file.path !== `${MOD_NAME}/hooks/hooks.json`);
    expect(savedMarketplaceMods([savedTools({ files: savedFiles(noHooks) })])).toEqual([]);
  });

  it('leaves out a mod in the folder that is not installed', () => {
    expect(savedMarketplaceMods([savedTools({ plugins: [] })])).toEqual([]);
  });

  it('leaves out a saved marketplace it cannot read', () => {
    expect(savedMarketplaceMods([collected(SAVED_PATH, 'not json')])).toEqual([]);
  });

  it('leaves out files that are not saved marketplaces', () => {
    expect(savedMarketplaceMods(modFiles())).toEqual([]);
  });
});

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
    known?: LocalMarketplaceRestoreDeps['known'];
    /** Claude Code's base folder, `~/.claude` unless said. */
    baseDir?: string;
  } = {},
) {
  const { validator } = await validatorFor(validatePassWithWarning);
  const script = scriptedPrompter(options.answers ?? []);
  const { reporter, lines } = recordingReporter({ levels: false });
  const conflicts: string[] = [];
  const restorer = testRestorer();
  const plan = await planLocalMarketplaces(
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
      baseDir: options.baseDir ?? base,
      platform: process.platform,
      known: options.known ?? {},
      validator: () => Promise.resolve(validator),
      restorer,
      git: () => Promise.resolve(options.git ?? null),
    },
  );
  const report = await plan.restore(() => Promise.resolve('skip'));
  return { plan, report, lines, conflicts, asked: script.asked };
}

const MODULE = [MOD_NAME, 'hooks', 'register.ts'] as const;

describe('pull writes a saved local marketplace (T98)', () => {
  const cloneArgs = () => `clone --no-checkout --quiet -- ${REMOTE} ${toolsFolder()}`;
  const withGit = savedTools({ git: { remote: REMOTE, commit: COMMIT } });

  it('re-clones the folder at the saved commit, then writes the saved files', async () => {
    const { git, calls } = scriptedGit({
      [cloneArgs()]: {},
      [`reset --quiet ${COMMIT}`]: {},
    });
    const { report } = await pull([withGit], { git });
    expect(calls.map((call) => call.args)).toEqual([cloneArgs(), `reset --quiet ${COMMIT}`]);
    expect(await exists(join(toolsFolder(), '.git'))).toBe(true);
    expect(await readText(join(toolsFolder(), ...MODULE))).toBe(MOD_MODULE);
    expect(report.warnings).toEqual([]);
  });

  it('writes the saved files without git when the re-clone fails', async () => {
    const { git } = scriptedGit({
      [cloneArgs()]: { exitCode: 128, stderr: 'fatal: repository not found\n' },
    });
    const { report } = await pull([withGit], { git });
    expect(report.warnings).toEqual([
      `Could not re-clone the marketplace tools from ${REMOTE} (fatal: repository not found), so its saved files were written without git.`,
    ]);
    expect(await exists(join(toolsFolder(), '.git'))).toBe(false);
    expect(await readText(join(toolsFolder(), ...MODULE))).toBe(MOD_MODULE);
  });

  it('writes the saved files without git when git is not installed', async () => {
    const { report } = await pull([withGit]);
    expect(report.warnings).toEqual([
      `Could not re-clone the marketplace tools from ${REMOTE} (git is not installed here), so its saved files were written without git.`,
    ]);
    expect(await readText(join(toolsFolder(), ...MODULE))).toBe(MOD_MODULE);
  });

  it('never re-clones into a folder that is already there', async () => {
    await writeTestFile(join(toolsFolder(), 'README.md'), 'mine');
    const { git, calls } = scriptedGit({});
    await pull([withGit], { git });
    expect(calls).toEqual([]);
  });

  it('has Claude Code add the marketplace from the folder it wrote', async () => {
    const { plan } = await pull([savedTools()]);
    expect(plan.marketplaces).toEqual([{ name: TOOLS, add: toolsFolder() }]);
  });

  it('installs the saved plugins of the marketplace', async () => {
    const { plan } = await pull([savedTools()]);
    expect(plan.plugins).toEqual([{ id: localModId(TOOLS), scope: 'user', commandSource: false }]);
  });

  it('writes a folder that was outside home to ~/.agentnomad/marketplaces/<name>', async () => {
    const { plan } = await pull([savedTools({ path: null })]);
    const dir = join(home, '.agentnomad', 'marketplaces', TOOLS);
    expect(plan.marketplaces).toEqual([{ name: TOOLS, add: dir }]);
    expect(await readText(join(dir, ...MODULE))).toBe(MOD_MODULE);
  });

  it('never writes into a folder for keys and logins: ~/.agentnomad/marketplaces instead', async () => {
    const { plan } = await pull([savedTools({ path: '.ssh/tools' })]);
    expect(plan.marketplaces).toEqual([
      { name: TOOLS, add: join(home, '.agentnomad', 'marketplaces', TOOLS) },
    ]);
    expect(await exists(join(home, '.ssh', TOOLS))).toBe(false);
  });

  it("never writes into Claude Code's own folder: ~/.agentnomad/marketplaces instead", async () => {
    const { plan } = await pull([savedTools({ path: '.claude/tools' })]);
    expect(plan.marketplaces).toEqual([
      { name: TOOLS, add: join(home, '.agentnomad', 'marketplaces', TOOLS) },
    ]);
    expect(await exists(join(base, TOOLS))).toBe(false);
  });

  // SEC-01 (review 15): each saved file is checked from home, not only the saved folder.
  it('never writes a file into an autostart folder inside the saved one: ~/.agentnomad/marketplaces instead', async () => {
    const files = savedFiles([...toolsFiles(), collected('fish/config.fish', 'echo hi')]);
    const { plan } = await pull([savedTools({ path: '.config', files })]);
    const dir = join(home, '.agentnomad', 'marketplaces', TOOLS);
    expect(plan.marketplaces).toEqual([{ name: TOOLS, add: dir }]);
    expect(await exists(join(home, '.config', 'fish', 'config.fish'))).toBe(false);
    expect(await readText(join(dir, 'fish', 'config.fish'))).toBe('echo hi');
  });

  it('never writes a LaunchAgent inside the saved folder: ~/.agentnomad/marketplaces instead', async () => {
    const files = savedFiles([...toolsFiles(), collected('LaunchAgents/x.plist', '<plist/>')]);
    const { plan } = await pull([savedTools({ path: 'Library', files })]);
    expect(plan.marketplaces).toEqual([
      { name: TOOLS, add: join(home, '.agentnomad', 'marketplaces', TOOLS) },
    ]);
    expect(await exists(join(home, 'Library', 'LaunchAgents', 'x.plist'))).toBe(false);
  });

  it("never writes a folder that holds Claude Code's own folder: ~/.agentnomad/marketplaces instead", async () => {
    const files = savedFiles([...toolsFiles(), collectedJson('claude/settings.json', {})]);
    const { plan } = await pull([savedTools({ path: '.config', files })], {
      baseDir: join(home, '.config', 'claude'),
    });
    expect(plan.marketplaces).toEqual([
      { name: TOOLS, add: join(home, '.agentnomad', 'marketplaces', TOOLS) },
    ]);
    expect(await exists(join(home, '.config', 'claude', 'settings.json'))).toBe(false);
  });

  it('writes into the folder this PC already adds the marketplace from, and adds nothing', async () => {
    const mine = join(root, 'my-tools');
    const { plan } = await pull([savedTools()], {
      known: { [TOOLS]: { source: { source: 'directory', path: mine } } },
    });
    expect(plan.marketplaces).toEqual([]);
    expect(await readText(join(mine, ...MODULE))).toBe(MOD_MODULE);
  });

  it('skips a marketplace this PC adds from another source, and says so', async () => {
    const { plan, lines } = await pull([savedTools()], {
      known: { [TOOLS]: { source: { source: 'github' } } },
    });
    expect(plan.plugins).toEqual([]);
    expect(lines).toContain(
      'Skipped the saved marketplace tools: a marketplace with that name is already added here from another source.',
    );
  });

  it('asks about a file that is here and differs, by its saved name', async () => {
    await writeTestFile(join(toolsFolder(), ...MODULE), 'mine');
    const { conflicts } = await pull([savedTools()]);
    expect(conflicts).toEqual([
      `.agentnomad/local-marketplaces/tools/${MOD_NAME}/hooks/register.ts`,
    ]);
  });

  it('overwrites a file that differs when asked to, keeping a backup', async () => {
    await writeTestFile(join(toolsFolder(), ...MODULE), 'mine');
    const { report } = await pull([savedTools()], { conflict: 'overwrite' });
    expect(await readText(join(toolsFolder(), ...MODULE))).toBe(MOD_MODULE);
    expect(report.backups).toHaveLength(1);
  });

  it('merges a JSON file that differs when asked to', async () => {
    await writeTestFile(
      join(toolsFolder(), '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: TOOLS, description: 'mine' }),
    );
    await pull([savedTools()], { conflict: 'merge' });
    expect(await readJson(join(toolsFolder(), '.claude-plugin', 'marketplace.json'))).toMatchObject(
      { description: 'mine', owner: { name: 'me' } },
    );
  });

  it('leaves a file that differs as it is when skipped', async () => {
    await writeTestFile(join(toolsFolder(), ...MODULE), 'mine');
    await pull([savedTools()], { conflict: 'skip' });
    expect(await readText(join(toolsFolder(), ...MODULE))).toBe('mine');
  });

  it('reviews the mod before writing it, and --yes alone declines it (T97)', async () => {
    const { lines } = await pull([savedTools()], {
      flags: { assumeYes: true, allowCommands: false },
    });
    expect(lines).toContain(
      `Skipped ${join(toolsFolder(), MOD_NAME)}: ${localModId(TOOLS)} runs code inside Claude Code. --yes never accepts a plugin with code; add --allow-commands to accept it.`,
    );
  });

  it('leaves out the files and the install of a declined mod, and notes it', async () => {
    const { plan } = await pull([savedTools()], {
      flags: { assumeYes: true, allowCommands: false },
    });
    expect(plan.plugins).toEqual([]);
    expect(plan.declined).toBe(true);
    expect(await readdir(toolsFolder())).toEqual(['.claude-plugin']);
  });

  it('writes a mod after a yes in the review', async () => {
    const { asked } = await pull([savedTools()], {
      flags: { assumeYes: false, allowCommands: false },
      answers: [true],
    });
    expect(asked).toEqual([`Write ${localModId(TOOLS)}? It runs code inside Claude Code.`]);
    expect(await readText(join(toolsFolder(), ...MODULE))).toBe(MOD_MODULE);
  });

  it('says so when a saved marketplace cannot be read, and writes nothing', async () => {
    const { plan, lines } = await pull([collected(SAVED_PATH, '{"name": "tools"}')]);
    expect(plan.marketplaces).toEqual([]);
    expect(
      lines.some((line) =>
        line.startsWith(`The saved marketplace ${SAVED_PATH} could not be read:`),
      ),
    ).toBe(true);
  });

  // QA-01 (review 15): pull runs git on the saved remote and commit, so an entry git could
  // take as an option or a command is refused whole, before git runs.
  it.each([
    ['a git helper that runs a command', { remote: 'ext::sh -c touch% x', commit: COMMIT }],
    ['a git helper without white space', { remote: 'ext::sh', commit: COMMIT }],
    ['an option for a remote', { remote: '--upload-pack=x', commit: COMMIT }],
    [
      'white space in the remote',
      { remote: 'https://example.com/me/my tools.git', commit: COMMIT },
    ],
    ['a control character in the remote', { remote: `${REMOTE}${BELL}`, commit: COMMIT }],
    ['an option for a commit', { remote: REMOTE, commit: '--hard' }],
    ['a short commit', { remote: REMOTE, commit: COMMIT.slice(0, 7) }],
    ['a commit that is not hex', { remote: REMOTE, commit: `g${COMMIT.slice(1)}` }],
  ])('refuses a saved entry with %s and runs no git', async (_, git) => {
    const scripted = scriptedGit({});
    const { plan, lines } = await pull([savedTools({ git })], { git: scripted.git });
    expect(plan.marketplaces).toEqual([]);
    expect(
      lines.some((line) =>
        line.startsWith(`The saved marketplace ${SAVED_PATH} could not be read:`),
      ),
    ).toBe(true);
    expect(scripted.calls).toEqual([]);
    expect(await exists(toolsFolder())).toBe(false);
  });
});

describe('the git that pull re-clones with never waits for an answer (QA-01 of review 15)', () => {
  const windows = process.platform === 'win32';
  const GUARDED = [
    'GIT_ALLOW_PROTOCOL',
    'GIT_TERMINAL_PROMPT',
    'GCM_INTERACTIVE',
    'GIT_SSH_COMMAND',
  ] as const;

  /** What `findGit` runs as git with `env`: one that prints the guarded variables. */
  async function guardedEnv(env: Record<string, string>): Promise<string[]> {
    const folder = join(root, 'bin');
    const program = join(folder, windows ? 'git.cmd' : 'git');
    const lines = GUARDED.map((name) =>
      windows ? `echo ${name}=%${name}%` : `echo "${name}=$${name}"`,
    );
    await writeTestFile(
      program,
      windows ? ['@echo off', ...lines].join('\r\n') : ['#!/bin/sh', ...lines].join('\n'),
    );
    await chmod(program, 0o755);
    // cmd.exe, which runs a .cmd, is found on the PATH given.
    const path = windows ? [folder, process.env['PATH'] ?? ''].join(delimiter) : folder;
    const git = await findGit(
      executableLookup({
        platform: process.platform,
        homedir: home,
        env: { ...env, PATH: path },
        executables: [program],
      }),
    );
    if (git === null) throw new Error('git not found');
    const result = await git.run(['--version'], root);
    return result.stdout.split(/\r?\n/).filter((line) => line !== '');
  }

  it('allows only the safe protocols, no password prompt and ssh in batch mode', async () => {
    expect(await guardedEnv({})).toEqual([
      'GIT_ALLOW_PROTOCOL=file:git:http:https:ssh',
      'GIT_TERMINAL_PROMPT=0',
      'GCM_INTERACTIVE=never',
      'GIT_SSH_COMMAND=ssh -o BatchMode=yes',
    ]);
  });

  it("keeps the user's own ssh command, and overrides their protocols and prompt", async () => {
    const env = {
      GIT_ALLOW_PROTOCOL: 'ext',
      GIT_TERMINAL_PROMPT: '1',
      GCM_INTERACTIVE: 'always',
      GIT_SSH_COMMAND: 'ssh -i work_key',
    };
    expect(await guardedEnv(env)).toEqual([
      'GIT_ALLOW_PROTOCOL=file:git:http:https:ssh',
      'GIT_TERMINAL_PROMPT=0',
      'GCM_INTERACTIVE=never',
      'GIT_SSH_COMMAND=ssh -i work_key',
    ]);
  });
});

// SEC-03 (review 16): a Mac's file system folds case, so `~/.Claude` is `~/.claude` there.
describe("Claude Code's own folder in another case (SEC-03 of review 16)", () => {
  const FALLBACK = '/Users/me/.agentnomad/marketplaces/tools';
  const placed = (path: string, platform: NodeJS.Platform, baseDir = '/Users/me/.claude') =>
    homeFolderFor(
      {
        path,
        files: [{ path: 'skills/evil/.claude-plugin/plugin.json', content: '', executable: false }],
      },
      FALLBACK,
      { homedir: '/Users/me', baseDir, platform },
    );

  it.each(['.claude', '.Claude', '.CLAUDE'])('on macOS, %s goes to the fallback', (path) => {
    expect(placed(path, 'darwin')).toBe(FALLBACK);
  });

  it('on macOS, a case variant of a folder holding CLAUDE_CONFIG_DIR goes to the fallback', () => {
    expect(placed('.Config', 'darwin', '/Users/me/.config/claude')).toBe(FALLBACK);
  });

  it('on Linux, .Claude is another folder than .claude', () => {
    expect(placed('.Claude', 'linux')).toBe('/Users/me/.Claude');
  });
});
