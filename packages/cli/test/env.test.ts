import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectedJson } from './fakes.ts';
import { stubRestorer } from './stub-restorer.ts';
import {
  isRedirectVariable,
  BLOCK_END,
  CLAUDE_ENV_REFERENCES,
  BLOCK_START,
  chooseEnvValues,
  createEnvCommand,
  createShellProfileWriter,
  createWindowsEnvWriter,
  describeEnv,
  envSectionFile,
  globalDestination,
  parseEnvSection,
  planEnvRestore,
  projectDestination,
  quotePosix,
  readBlock,
  realPowerShell,
  scanEnvReferences,
  shellProfileFor,
  upsertBlock,
  writeEnvValues,
  type AgentAdapter,
  type Choice,
  type CollectedFile,
  type EnvWriter,
  type MultiselectOptions,
  EnvSectionSchema,
} from '../src/index.ts';

const posix = process.platform !== 'win32';

const mcpJson = collectedJson('.mcp.json', {
  mcpServers: {
    github: { command: 'npx', args: ['gh-mcp'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
    api: {
      type: 'http',
      url: '${API_BASE:-https://api.example.com}/mcp',
      headers: { Authorization: 'Bearer ${API_KEY}' },
    },
    local: { command: 'node', args: ['${CLAUDE_PROJECT_DIR}/server.js'] },
  },
});

describe('finding ${VAR} references', () => {
  it('finds them in MCP servers, with where each is used, and ignores Claude Code’s own', () => {
    expect(scanEnvReferences([mcpJson], CLAUDE_ENV_REFERENCES).variables).toEqual([
      { name: 'API_BASE', usedBy: ['MCP server api (.mcp.json)'] },
      { name: 'API_KEY', usedBy: ['MCP server api (.mcp.json)'] },
      { name: 'GITHUB_TOKEN', usedBy: ['MCP server github (.mcp.json)'] },
    ]);
  });

  it('reads ~/.claude.json servers and settings, and knows variables settings set', () => {
    const scan = scanEnvReferences(
      [
        collectedJson('.agentnomad/claude.json', {
          mcpServers: { notion: { env: { NOTION_KEY: '${NOTION_KEY}' } } },
        }),
        collectedJson('settings.json', {
          env: { COMPANY_PROXY: 'http://proxy' },
          apiKeyHelper: 'echo ${HELPER_TOKEN}',
        }),
        collectedJson('CLAUDE.md', { note: '${NOT_SCANNED}' }),
      ],
      CLAUDE_ENV_REFERENCES,
      'global',
    );
    expect(scan.variables).toEqual([
      { name: 'HELPER_TOKEN', usedBy: ['settings.json, global'] },
      { name: 'NOTION_KEY', usedBy: ['MCP server notion (~/.claude.json), global'] },
    ]);
    expect([...scan.setBySettings]).toEqual(['COMPANY_PROXY']);
  });

  it('ignores files that are not JSON', () => {
    const broken = {
      path: '.mcp.json',
      content: new TextEncoder().encode('{ nope'),
      executable: false,
    };
    expect(scanEnvReferences([broken], CLAUDE_ENV_REFERENCES).variables).toEqual([]);
  });
});

describe('saving values on push (opt-in)', () => {
  const scan = scanEnvReferences([mcpJson], CLAUDE_ENV_REFERENCES);

  it('offers only variables set here, none ticked, and saves only the ticked ones', async () => {
    const offered: string[] = [];
    let initial: readonly string[] | undefined;
    const section = await chooseEnvValues({
      scan,
      env: { GITHUB_TOKEN: 'ghp_secret', API_KEY: 'key-1' },
      prompter: {
        multiselect: <T extends string>(
          _message: string,
          choices: readonly Choice<T>[],
          options?: MultiselectOptions<T>,
        ) => {
          offered.push(...choices.map((choice) => choice.value));
          initial = options?.initial;
          return Promise.resolve(
            choices
              .filter((choice) => choice.value === 'GITHUB_TOKEN')
              .map((choice) => choice.value),
          );
        },
      },
    });
    expect(offered).toEqual(['API_KEY', 'GITHUB_TOKEN']);
    expect(initial).toEqual([]);
    expect(section).toEqual({ variables: { GITHUB_TOKEN: 'ghp_secret' } });
  });

  it('saves nothing when nothing is ticked', async () => {
    const section = await chooseEnvValues({
      scan,
      env: { GITHUB_TOKEN: 'x' },
      prompter: { multiselect: () => Promise.resolve([]) },
    });
    expect(section).toBeNull();
  });

  it('the env section round-trips and is never written by restore', () => {
    const entry = envSectionFile({ variables: { GITHUB_TOKEN: 'ghp_secret' } });
    expect(parseEnvSection(entry.content)).toEqual({ variables: { GITHUB_TOKEN: 'ghp_secret' } });
    expect(parseEnvSection(new TextEncoder().encode('{"variables":{"bad name":"x"}}'))).toBeNull();
    expect(globalDestination(entry.path, new Set())).toEqual({ kind: 'metadata' });
    expect(projectDestination(entry.path)).toEqual({ kind: 'metadata' });
  });
});

describe('shell profile block', () => {
  it.each([
    ['a NUL byte', 'abc\u0000def'],
    ['the block end marker', 'x\n# <<< agentnomad env <<<\necho hi'],
    ['the block start marker', '# >>> agentnomad env >>>'],
  ])('refuses a saved value with %s (T38)', (_, value) => {
    expect(EnvSectionSchema.safeParse({ variables: { TOKEN: value } }).success).toBe(false);
  });

  it('quotes a value for a POSIX shell, a single quote included', () => {
    expect(quotePosix("a'b")).toBe(`'a'\\''b'`);
  });

  it('keeps ordinary values, even multi-line ones', () => {
    const variables = { KEY: 'line one\nline two', B: "it's" };
    expect(EnvSectionSchema.safeParse({ variables }).success).toBe(true);
  });

  const tricky = `it's $HOME "quoted" \\ back\nnew line`;

  it('adds a marked block and keeps the rest of the profile', () => {
    const text = upsertBlock('alias ll="ls -l"\n', { TOKEN: 'abc' }, 'posix');
    expect(text).toBe(
      `alias ll="ls -l"\n\n${BLOCK_START}\n# Added by agentnomad pull. Values are plain text on this PC.\nexport TOKEN='abc'\n${BLOCK_END}\n`,
    );
  });

  it('updates the same block next time, keeping earlier variables', () => {
    const once = upsertBlock('# top\n', { A: '1' }, 'posix');
    const twice = upsertBlock(`${once}# bottom\n`, { B: '2', A: 'new' }, 'posix');
    expect(twice.match(new RegExp(BLOCK_START, 'g'))).toHaveLength(1);
    expect([...readBlock(twice, 'posix')]).toEqual([
      ['A', 'new'],
      ['B', '2'],
    ]);
    expect(twice.startsWith('# top\n')).toBe(true);
    expect(twice.endsWith('# bottom\n')).toBe(true);
  });

  it.each(['posix', 'fish'] as const)(
    '%s quoting survives quotes, $, backslashes and newlines',
    (kind) => {
      const text = upsertBlock('', { TRICKY: tricky }, kind);
      expect(readBlock(text, kind).get('TRICKY')).toBe(tricky);
    },
  );

  it('picks the profile a new terminal reads', () => {
    expect(shellProfileFor('/bin/zsh', '/home/a', 'linux').label).toBe('~/.zshrc');
    expect(shellProfileFor('/bin/bash', '/home/a', 'linux').label).toBe('~/.bashrc');
    expect(shellProfileFor('/bin/bash', '/Users/a', 'darwin').label).toBe('~/.bash_profile');
    expect(shellProfileFor(undefined, '/Users/a', 'darwin').label).toBe('~/.zshrc');
    expect(shellProfileFor('/usr/bin/fish', '/home/a', 'linux')).toMatchObject({ kind: 'fish' });
    expect(shellProfileFor('/bin/dash', '/home/a', 'linux').label).toBe('~/.profile');
  });
});

describe('writing the profile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentnomad-env-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const bashrc = (path: string) =>
    createShellProfileWriter({ path, kind: 'posix', label: '~/.bashrc' });

  it('never replaces a profile it cannot read (T46)', async () => {
    const profile = join(dir, '.bashrc');
    await mkdir(profile);
    // The read's error, not the later rename onto a folder (EPERM on Windows); nothing written.
    await expect(bashrc(profile).write({ TOKEN: 'abc' })).rejects.toMatchObject({
      code: 'EISDIR',
    });
    expect(await readdir(dir)).toEqual(['.bashrc']);
  });

  // Without the guard, a profile the user may not read would be replaced (rename needs only
  // the folder's permission). Root reads any file, so the case cannot be set up as root.
  it.runIf(posix && process.getuid?.() !== 0)(
    'never replaces a profile it may not read (T46)',
    async () => {
      const PROFILE = 'alias ll="ls -l"';
      const profile = join(dir, '.bashrc');
      await writeFile(profile, PROFILE);
      await chmod(profile, 0);
      try {
        await expect(bashrc(profile).write({ TOKEN: 'abc' })).rejects.toMatchObject({
          code: 'EACCES',
        });
      } finally {
        await chmod(profile, 0o600);
      }
      expect(await readFile(profile, 'utf8')).toBe(PROFILE);
      expect(await readdir(dir)).toEqual(['.bashrc']);
    },
  );

  it.runIf(posix)('writes through a linked profile, keeping the link (T46)', async () => {
    const real = join(dir, 'dotfiles', 'bashrc');
    await mkdir(join(dir, 'dotfiles'));
    await writeFile(real, 'alias ll="ls -l"\n');
    const profile = join(dir, '.bashrc');
    await symlink(real, profile);
    await createShellProfileWriter({ path: profile, kind: 'posix', label: '~/.bashrc' }).write({
      TOKEN: 'abc',
    });
    expect((await lstat(profile)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toContain("export TOKEN='abc'");
  });

  it.runIf(posix)('a new profile is readable only by this user (T46)', async () => {
    const profile = join(dir, '.profile');
    await createShellProfileWriter({ path: profile, kind: 'posix', label: '~/.profile' }).write({
      TOKEN: 'abc',
    });
    expect((await stat(profile)).mode & 0o777).toBe(0o600);
  });

  it('backs the profile up before changing it', async () => {
    const profile = join(dir, '.bashrc');
    await writeFile(profile, 'alias ll="ls -l"\n');
    const writer = createShellProfileWriter(
      { path: profile, kind: 'posix', label: '~/.bashrc' },
      () => new Date('2026-09-25T12:00:00Z'),
    );
    const { backup } = await writer.write({ TOKEN: 'abc' });
    expect(backup).toBe(`${profile}.agentnomad-backup-20260925T120000Z`);
    expect(await readFile(backup ?? '', 'utf8')).toBe('alias ll="ls -l"\n');
    expect(await readFile(profile, 'utf8')).toContain("export TOKEN='abc'");
  });

  it('two writes in the same second keep both backups (review 6 BUG-01)', async () => {
    const profile = join(dir, '.bashrc');
    await writeFile(profile, 'alias ll="ls -l"\n');
    const writer = createShellProfileWriter(
      { path: profile, kind: 'posix', label: '~/.bashrc' },
      () => new Date('2026-09-25T12:00:00Z'),
    );
    const first = await writer.write({ TOKEN: 'abc' });
    const second = await writer.write({ TOKEN: 'new' });
    expect(first.backup).toBe(`${profile}.agentnomad-backup-20260925T120000Z`);
    expect(second.backup).toBe(`${profile}.agentnomad-backup-20260925T120000Z-2`);
    // The first backup still holds the profile as it was before agentnomad touched it.
    expect(await readFile(first.backup ?? '', 'utf8')).toBe('alias ll="ls -l"\n');
    expect(await readFile(second.backup ?? '', 'utf8')).toContain("export TOKEN='abc'");
  });

  it.runIf(posix)('a new shell really gets the value (second machine)', async () => {
    const profile = join(dir, '.bashrc');
    const value = `ghp_it's $HOME "x" \\ y`;
    await createShellProfileWriter({ path: profile, kind: 'posix', label: '~/.bashrc' }).write({
      GITHUB_TOKEN: value,
    });
    const shell = spawnSync('sh', ['-c', `. "${profile}" && printf %s "$GITHUB_TOKEN"`], {
      encoding: 'utf8',
    });
    expect(shell.stdout).toBe(value);
  });

  it('reads back its block, and an unchanged block is neither backed up nor written (T56)', async () => {
    const profile = join(dir, '.zshrc');
    await writeFile(profile, 'alias ll="ls -l"\n');
    let clock = 0;
    const writer = createShellProfileWriter(
      { path: profile, kind: 'posix', label: '~/.zshrc' },
      () => new Date(Date.UTC(2026, 9, 3, 12, 0, clock++)),
    );
    expect(await writer.current(['TOKEN'])).toEqual(new Map());
    expect((await writer.write({ TOKEN: 'abc', OTHER: 'x' })).backup).not.toBeNull();
    expect(await writer.current(['TOKEN', 'MISSING'])).toEqual(new Map([['TOKEN', 'abc']]));
    const before = await readFile(profile, 'utf8');
    const modified = (await stat(profile)).mtimeMs;
    expect(await writer.write({ TOKEN: 'abc' })).toEqual({ backup: null });
    expect(await readFile(profile, 'utf8')).toBe(before);
    expect((await stat(profile)).mtimeMs).toBe(modified);
    expect((await readdir(dir)).filter((name) => name.includes('backup'))).toHaveLength(1);
    // A changed value is still written, after a backup.
    expect((await writer.write({ TOKEN: 'new' })).backup).not.toBeNull();
    expect(await writer.current(['TOKEN'])).toEqual(new Map([['TOKEN', 'new']]));
  });

  it('a missing profile has no values yet (T56)', async () => {
    const writer = createShellProfileWriter({
      path: join(dir, 'none', '.zshrc'),
      kind: 'posix',
      label: '~/.zshrc',
    });
    expect(await writer.current(['TOKEN'])).toEqual(new Map());
  });

  it('Windows: reads user variables back and leaves one that already has the value (T56)', async () => {
    const calls: { script: string; env: Readonly<Record<string, string>> }[] = [];
    const stored: Record<string, string> = { GITHUB_TOKEN: 'ghp_secret', API_KEY: 'old' };
    const writer = createWindowsEnvWriter((script, env) => {
      calls.push({ script, env });
      const asked = (env['AGENTNOMAD_ENV_NAMES'] ?? '').split('\n');
      const found = Object.entries(stored).filter(([name]) => asked.includes(name));
      return Promise.resolve(
        Buffer.from(JSON.stringify(Object.fromEntries(found)), 'utf8').toString('base64'),
      );
    });
    expect(await writer.current(['GITHUB_TOKEN', 'NOPE'])).toEqual(
      new Map([['GITHUB_TOKEN', 'ghp_secret']]),
    );
    calls.length = 0;
    await writer.write({ GITHUB_TOKEN: 'ghp_secret', API_KEY: 'new' });
    const sets = calls.filter((call) => call.env['AGENTNOMAD_ENV_COUNT'] !== undefined);
    expect(sets.map((call) => call.env)).toEqual([
      {
        AGENTNOMAD_ENV_COUNT: '1',
        AGENTNOMAD_ENV_NAME_0: 'API_KEY',
        AGENTNOMAD_ENV_VALUE_0: 'new',
      },
    ]);
    expect(calls.every((call) => !call.script.includes('ghp_secret'))).toBe(true);
  });

  it.runIf(process.platform === 'win32')(
    'Windows: the real PowerShell reads user variables back, read only (T56)',
    async () => {
      const writer = createWindowsEnvWriter(realPowerShell(process.env));
      expect(await writer.current(['AGENTNOMAD_T56_NEVER_SET', 'AGENTNOMAD_T56_NOR_THIS'])).toEqual(
        new Map(),
      );
    },
    30_000,
  );

  it('Windows: sets user variables with the value never on the command line', async () => {
    const calls: { script: string; env: Readonly<Record<string, string>> }[] = [];
    const writer = createWindowsEnvWriter((script, env) => {
      calls.push({ script, env });
      // The read before writing finds no user variables.
      return Promise.resolve(Buffer.from('{}').toString('base64'));
    });
    await writer.write({ GITHUB_TOKEN: 'ghp_secret' });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.env).toEqual({ AGENTNOMAD_ENV_NAMES: 'GITHUB_TOKEN' });
    expect(calls[1]?.script).not.toContain('ghp_secret');
    expect(calls[1]?.env).toEqual({
      AGENTNOMAD_ENV_COUNT: '1',
      AGENTNOMAD_ENV_NAME_0: 'GITHUB_TOKEN',
      AGENTNOMAD_ENV_VALUE_0: 'ghp_secret',
    });
  });

  it('Windows: sets several user variables with one PowerShell, not one each (PERF-02)', async () => {
    const calls: { script: string; env: Readonly<Record<string, string>> }[] = [];
    const writer = createWindowsEnvWriter((script, env) => {
      calls.push({ script, env });
      return Promise.resolve(Buffer.from('{}').toString('base64'));
    });
    await writer.write({ A_TOKEN: 'one', B_TOKEN: 'two', C_TOKEN: 'three' });
    // One read, then one write for all three.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.env).toEqual({
      AGENTNOMAD_ENV_COUNT: '3',
      AGENTNOMAD_ENV_NAME_0: 'A_TOKEN',
      AGENTNOMAD_ENV_VALUE_0: 'one',
      AGENTNOMAD_ENV_NAME_1: 'B_TOKEN',
      AGENTNOMAD_ENV_VALUE_1: 'two',
      AGENTNOMAD_ENV_NAME_2: 'C_TOKEN',
      AGENTNOMAD_ENV_VALUE_2: 'three',
    });
    expect(calls.every((call) => !/one|two|three/.test(call.script))).toBe(true);
  });

  it('Windows: writes nothing when every variable already has its value', async () => {
    const calls: string[] = [];
    const writer = createWindowsEnvWriter((script) => {
      calls.push(script);
      return Promise.resolve(Buffer.from('{"A_TOKEN":"one"}').toString('base64'));
    });
    await writer.write({ A_TOKEN: 'one' });
    expect(calls).toHaveLength(1);
  });
});

describe('restoring values on pull', () => {
  /** Pull's two steps in a row: ask (plan), then write what was chosen (apply). */
  async function restoreEnvValues(
    deps: Parameters<typeof planEnvRestore>[0] & { writer: EnvWriter; agentName?: string },
  ) {
    const plan = await planEnvRestore(deps);
    if (plan.toAdd.length > 0)
      await writeEnvValues({ ...deps, agentName: deps.agentName ?? 'Claude Code' }, plan.toAdd);
    return { added: plan.toAdd, alreadySet: plan.alreadySet, declined: plan.declined };
  }

  function recordingWriter() {
    const written: Record<string, string>[] = [];
    const writer: EnvWriter = {
      where: '~/.zshrc',
      current: () => Promise.resolve(new Map()),
      write: (variables) => {
        written.push({ ...variables });
        return Promise.resolve({ backup: '/home/a/.zshrc.agentnomad-backup-x' });
      },
    };
    return { writer, written };
  }
  const section = { variables: { GITHUB_TOKEN: 'ghp_secret', API_KEY: 'key-1' } };

  it('adds only missing variables, after asking, and never shows values', async () => {
    const { writer, written } = recordingWriter();
    const lines: string[] = [];
    const result = await restoreEnvValues({
      isRedirectVariable,
      section,
      env: { API_KEY: 'already-here' },
      writer,
      agentName: 'Other Agent',
      prompter: { confirm: () => Promise.resolve(true) },
      reporter: {
        info: (m) => lines.push(m),
        success: (m) => lines.push(m),
        warn: (m) => lines.push(m),
      },
    });
    expect(result).toEqual({ added: ['GITHUB_TOKEN'], alreadySet: ['API_KEY'], declined: false });
    expect(written).toEqual([{ GITHUB_TOKEN: 'ghp_secret' }]);
    expect(lines.join('\n')).not.toContain('ghp_secret');
    expect(lines.join('\n')).toContain(
      'Open a new terminal (and restart Other Agent) so they take effect.',
    );
  });

  it('writes nothing when the user says no', async () => {
    const { writer, written } = recordingWriter();
    const result = await restoreEnvValues({
      isRedirectVariable,
      section,
      env: {},
      writer,
      prompter: { confirm: () => Promise.resolve(false) },
      reporter: { info: () => undefined, success: () => undefined, warn: () => undefined },
    });
    expect(result.declined).toBe(true);
    expect(written).toEqual([]);
  });

  it('counts a value already in its block as set: no question, no write (T56)', async () => {
    const { writer, written } = recordingWriter();
    const result = await restoreEnvValues({
      isRedirectVariable,
      section,
      env: {},
      writer: {
        ...writer,
        current: () => Promise.resolve(new Map(Object.entries(section.variables))),
      },
      prompter: { confirm: () => Promise.reject(new Error('must not ask')) },
      reporter: { info: () => undefined, success: () => undefined, warn: () => undefined },
    });
    expect(result).toEqual({ added: [], alreadySet: ['API_KEY', 'GITHUB_TOKEN'], declined: false });
    expect(written).toEqual([]);
  });

  it('a different value in its block is still offered (T56)', async () => {
    const { writer, written } = recordingWriter();
    const result = await restoreEnvValues({
      isRedirectVariable,
      section,
      env: {},
      writer: { ...writer, current: () => Promise.resolve(new Map([['API_KEY', 'older']])) },
      prompter: { confirm: () => Promise.resolve(true) },
      reporter: { info: () => undefined, success: () => undefined, warn: () => undefined },
    });
    expect(result.added).toEqual(['API_KEY', 'GITHUB_TOKEN']);
    expect(written).toEqual([section.variables]);
  });

  it('--yes alone never adds a variable that sends traffic elsewhere (T56)', async () => {
    const lines: string[] = [];
    const push = (m: string) => lines.push(m);
    const reporter = { info: push, success: push, warn: push };
    const redirects = {
      variables: { API_KEY: 'key-1', HTTPS_PROXY: 'http://p', ANTHROPIC_BASE_URL: 'https://x' },
    };
    const first = recordingWriter();
    const result = await restoreEnvValues({
      isRedirectVariable,
      section: redirects,
      env: {},
      writer: first.writer,
      prompter: { confirm: () => Promise.reject(new Error('must not ask')) },
      reporter,
      assumeYes: true,
    });
    expect(first.written).toEqual([{ API_KEY: 'key-1' }]);
    expect(result.declined).toBe(true);
    expect(lines.join('\n')).toContain('Not added: ANTHROPIC_BASE_URL, HTTPS_PROXY.');
    expect(lines.join('\n')).toContain('--allow-commands');
    expect(lines.join('\n')).not.toContain('http://p');

    const asked: [string, boolean | undefined][] = [];
    const second = recordingWriter();
    await restoreEnvValues({
      isRedirectVariable,
      section: redirects,
      env: {},
      writer: second.writer,
      prompter: {
        confirm: (message, initial) => {
          asked.push([message, initial]);
          return Promise.resolve(initial ?? false);
        },
      },
      reporter,
    });
    expect(asked[1]).toEqual([
      'ANTHROPIC_BASE_URL, HTTPS_PROXY send programs’ requests elsewhere. Add them too?',
      false,
    ]);
    expect(second.written).toEqual([{ API_KEY: 'key-1' }]);

    const third = recordingWriter();
    await restoreEnvValues({
      isRedirectVariable,
      section: redirects,
      env: {},
      writer: third.writer,
      prompter: { confirm: () => Promise.reject(new Error('must not ask')) },
      reporter,
      assumeYes: true,
      allowCommands: true,
    });
    expect(third.written).toEqual([redirects.variables]);
  });

  describe('variables that make programs run code (T44)', () => {
    const loaders = {
      variables: { API_KEY: 'key-1', NODE_OPTIONS: '--require /tmp/x.js', PROMPT_COMMAND: 'x' },
    };
    const quiet = () => {
      const lines: string[] = [];
      const push = (m: string) => lines.push(m);
      return { lines, reporter: { info: push, success: push, warn: push } };
    };

    it('--yes adds the others but never these, and says how to accept them', async () => {
      const { writer, written } = recordingWriter();
      const { lines, reporter } = quiet();
      const result = await restoreEnvValues({
        isRedirectVariable,
        section: loaders,
        env: {},
        writer,
        prompter: { confirm: () => Promise.reject(new Error('must not ask')) },
        reporter,
        assumeYes: true,
      });
      expect(written).toEqual([{ API_KEY: 'key-1' }]);
      expect(result.added).toEqual(['API_KEY']);
      expect(lines.join('\n')).toContain('--allow-commands');
      expect(lines.join('\n')).not.toContain('/tmp/x.js');
    });

    it('--allow-commands adds them too', async () => {
      const { writer, written } = recordingWriter();
      await restoreEnvValues({
        isRedirectVariable,
        section: loaders,
        env: {},
        writer,
        prompter: { confirm: () => Promise.reject(new Error('must not ask')) },
        reporter: quiet().reporter,
        assumeYes: true,
        allowCommands: true,
      });
      expect(written).toEqual([
        { API_KEY: 'key-1', NODE_OPTIONS: '--require /tmp/x.js', PROMPT_COMMAND: 'x' },
      ]);
    });

    it('asks about them separately, defaulting to no', async () => {
      const { writer, written } = recordingWriter();
      const asked: [string, boolean | undefined][] = [];
      await restoreEnvValues({
        isRedirectVariable,
        section: loaders,
        env: {},
        writer,
        prompter: {
          confirm: (message, initial) => {
            asked.push([message, initial]);
            return Promise.resolve(initial ?? false);
          },
        },
        reporter: quiet().reporter,
      });
      expect(asked).toEqual([
        ['Add 1 variable?', true],
        ['NODE_OPTIONS, PROMPT_COMMAND make programs load or run code. Add them too?', false],
      ]);
      expect(written).toEqual([{ API_KEY: 'key-1' }]);
    });
  });
});

describe('agentnomad env', () => {
  const adapter = (
    global: CollectedFile[],
    project: CollectedFile[],
    installed = true,
  ): AgentAdapter => ({
    id: 'claude-code',
    displayName: 'Claude Code',
    detector: {
      detect: () => Promise.resolve({ installed, baseDir: '/h/.claude', version: null }),
    },
    collector: {
      collect: (target) => Promise.resolve(target.kind === 'global' ? global : project),
    },
    restorer: stubRestorer(),
    envReferences: CLAUDE_ENV_REFERENCES,
  });

  async function run(env: Record<string, string>, cwd = '/work/app') {
    const lines: string[] = [];
    await createEnvCommand({
      registry: () => ({
        list: () => [
          adapter(
            [
              collectedJson('.agentnomad/claude.json', {
                mcpServers: { github: { env: { T: '${GITHUB_TOKEN}' } } },
              }),
            ],
            [mcpJson],
          ),
        ],
        get: () => undefined,
      }),
      reporter: {
        info: (m) => lines.push(m),
        success: (m) => lines.push(m),
        warn: (m) => lines.push(m),
      },
      env,
      cwd,
      homedir: '/h',
      platform: 'linux',
    }).env();
    return lines;
  }

  it('lists each variable as set or missing, with where it is used, and no values', async () => {
    const lines = await run({ GITHUB_TOKEN: 'ghp_secret' });
    expect(lines[0]?.split('\n')).toEqual([
      'Environment variables your setups use:',
      '  ✗ API_BASE      missing here     MCP server api (.mcp.json), Claude Code this project',
      '  ✗ API_KEY       missing here     MCP server api (.mcp.json), Claude Code this project',
      '  ✓ GITHUB_TOKEN  set here         MCP server github (.mcp.json), Claude Code this project; MCP server github (~/.claude.json), Claude Code global',
    ]);
    expect(lines[1]).toContain('2 missing here');
    expect(lines.join('\n')).not.toContain('ghp_secret');
  });

  it('in the home folder or the agent’s own folder, lists the global setup only (UX-03)', async () => {
    for (const cwd of ['/h', '/h/.claude']) {
      const lines = await run({ GITHUB_TOKEN: 'ghp_secret' }, cwd);
      expect(lines[0]?.split('\n')).toEqual([
        'Environment variables your setups use:',
        '  ✓ GITHUB_TOKEN  set here         MCP server github (~/.claude.json), Claude Code global',
      ]);
    }
  });

  it('says so when everything is set', async () => {
    const lines = await run({ GITHUB_TOKEN: 'a', API_BASE: 'b', API_KEY: 'c' });
    expect(lines.at(-1)).toBe('All of them are set here.');
  });

  it('marks variables the settings set', () => {
    const scan = scanEnvReferences(
      [collectedJson('settings.json', { env: { X: '1' }, apiKeyHelper: '${X}' })],
      CLAUDE_ENV_REFERENCES,
    );
    expect(describeEnv(scan, {})[0]).toContain('set in settings');
  });

  it('lines up the "used by" column whatever the status (UX-04)', () => {
    const scan = {
      variables: [
        { name: 'A', usedBy: ['one'] },
        { name: 'B', usedBy: ['two'] },
        { name: 'C', usedBy: ['three'] },
      ],
      setBySettings: new Set(['A']),
    };
    expect(describeEnv(scan, { B: 'set' })).toEqual([
      '✓ A  set in settings  one',
      '✓ B  set here         two',
      '✗ C  missing here     three',
    ]);
  });
});
