import { join } from 'node:path';

import { expect, it } from 'vitest';

import { startLocalServer } from '../src/local-server.ts';
import { newPc, read, write, type RunResult } from '../src/pc.ts';

/**
 * T111: a file the global `CLAUDE.md` imports from elsewhere in the home comes along and lands
 * where the import points on a second PC; one push cannot take is named. Push and pull run on
 * this OS only, so it runs once, never in the CI step jobs.
 */
const LOGIN = ['--username', 'e2e-claude-md-imports', '--password-stdin'];
const stdin = 'amber-harbor-violet-sketch-73\n';

const ok = (result: RunResult) => {
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result;
};

it.skipIf(process.env['E2E_STEP'] !== undefined)(
  'a file CLAUDE.md imports restores on a second PC, and one push cannot take is named',
  async () => {
    const server = await startLocalServer(undefined);
    const first = await newPc('imp-first', { apiUrl: server.url, keychain: false });
    const second = await newPc('imp-second', { apiUrl: server.url, keychain: false });
    try {
      await write(
        join(first.home, '.claude', 'CLAUDE.md'),
        '# Me\n@~/notes/style.md\n@~/notes/run.sh\n',
      );
      await write(join(first.home, 'notes', 'style.md'), 'Use tabs.\n@team.md\n');
      await write(join(first.home, 'notes', 'team.md'), 'Team rules.\n');
      await write(join(first.home, 'notes', 'run.sh'), 'echo hi\n');
      ok(await first.run(['register', ...LOGIN, '--yes'], stdin));
      const pushed = ok(await first.run(['push', '--global', '--yes']));
      expect(`${pushed.stdout}\n${pushed.stderr}`).toContain(
        '~/notes/run.sh: ~/.claude/CLAUDE.md imports it on line 3 (@~/notes/run.sh)',
      );

      ok(await second.run(['login', ...LOGIN], stdin));
      ok(await second.run(['pull', '--global', '--yes']));
      expect(await read(join(second.home, 'notes', 'style.md'))).toBe('Use tabs.\n@team.md\n');
      expect(await read(join(second.home, 'notes', 'team.md'))).toBe('Team rules.\n');
      await expect(read(join(second.home, 'notes', 'run.sh'))).rejects.toThrow();
    } finally {
      await Promise.all([first.remove(), second.remove()]);
      await server.close();
    }
  },
);
