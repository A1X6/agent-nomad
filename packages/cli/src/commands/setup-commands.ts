import type { CryptoService } from '@agentnomad/core';

import type { AgentRegistry } from '../agents/adapter.ts';
import type { ApiClient } from '../api/api-client.ts';
import { readDataKey, withSession } from '../auth/local-session.ts';
import type { CommandHandlers, ScopeFlags } from '../cli/commands.ts';
import { listSavedSetups, type SavedSetup } from '../pull/saved-setups.ts';
import type { SecretStore } from '../secrets/secret-store.ts';
import type { LocalState } from '../state/local-state.ts';
import type { Prompter, Reporter } from '../ui/prompter.ts';

export interface SetupCommandDeps {
  readonly prompter: Prompter;
  readonly reporter: Reporter;
  readonly registry: () => AgentRegistry;
  readonly secrets: () => Promise<SecretStore>;
  readonly api: () => ApiClient;
  readonly crypto: () => Promise<CryptoService>;
  readonly localState: () => LocalState;
  /** The current folder, for "this folder is saved as …". */
  readonly cwd: string;
  /** Clock for "2 hours ago"; injectable for tests. */
  readonly now?: () => Date;
}

/** `5 KB`, `1.2 MB`. */
export const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${String(bytes)} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** `just now`, `5 minutes ago`, `2 hours ago`, `yesterday`, `3 days ago`, or the date. */
export function timeAgo(iso: string, now: Date): string {
  const seconds = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  const plural = (count: number, unit: string) =>
    `${String(count)} ${unit}${count === 1 ? '' : 's'} ago`;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return plural(Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return plural(Math.floor(seconds / 3600), 'hour');
  const days = Math.floor(seconds / 86_400);
  if (days === 1) return 'yesterday';
  if (days < 30) return plural(days, 'day');
  return iso.slice(0, 10);
}

const setupName = (setup: SavedSetup) =>
  setup.projectName === null ? 'global setup' : `project "${setup.projectName}"`;

/** Setups matching `--agent`, `--global`, `--project`; all of them when none is given. */
function matching(setups: readonly SavedSetup[], flags: ScopeFlags): SavedSetup[] {
  const scoped = flags.global || flags.project !== undefined;
  return setups.filter(
    (setup) =>
      (!flags.agents || flags.agents.includes(setup.agent)) &&
      (!scoped ||
        (flags.global && setup.projectName === null) ||
        (flags.project !== undefined && setup.projectName === flags.project)),
  );
}

/** `list`, `status` and `delete` (T35): what is saved, whether this PC is up to date, removing. */
export function createSetupCommands(
  deps: SetupCommandDeps,
): Pick<CommandHandlers, 'list' | 'status' | 'delete'> {
  const { prompter, reporter } = deps;
  const displayName = (agent: string) => deps.registry().get(agent)?.displayName ?? agent;

  async function saved(): Promise<{ secrets: SecretStore; setups: SavedSetup[] }> {
    const secrets = await deps.secrets();
    const dataKey = await readDataKey(secrets);
    try {
      const crypto = await deps.crypto();
      const setups = await withSession(secrets, () => listSavedSetups(deps.api(), crypto, dataKey));
      return { secrets, setups };
    } finally {
      dataKey.fill(0);
    }
  }

  /** Setups grouped by agent, the global setup first, then projects by name. */
  function byAgent(setups: readonly SavedSetup[]): Map<string, SavedSetup[]> {
    const groups = new Map<string, SavedSetup[]>();
    const sorted = [...setups].sort((a, b) =>
      a.projectName === null
        ? -1
        : b.projectName === null
          ? 1
          : a.projectName.localeCompare(b.projectName),
    );
    for (const setup of sorted)
      groups.set(setup.agent, [...(groups.get(setup.agent) ?? []), setup]);
    return groups;
  }

  return {
    async list() {
      const { setups } = await saved();
      if (setups.length === 0) {
        reporter.info('Nothing is saved yet. Run `agentnomad push` to save your setup.');
        return;
      }
      const now = deps.now?.() ?? new Date();
      const width = Math.max(...setups.map((setup) => setupName(setup).length));
      const lines: string[] = [];
      for (const [agent, group] of byAgent(setups)) {
        lines.push(displayName(agent));
        for (const setup of group) {
          lines.push(
            `  ${setupName(setup).padEnd(width)}  revision ${String(setup.revision)}  ${formatSize(setup.sizeBytes).padStart(6)}  ${timeAgo(setup.updatedAt, now)}`,
          );
        }
      }
      reporter.info(lines.join('\n'));
    },

    async status(flags) {
      const { setups } = await saved();
      const state = deps.localState();
      const known = await state.knownRevisions();
      const shown = [...byAgent(matching(setups, flags)).values()].flat();
      const lines = shown.map((setup) => {
        const here = known[`${setup.agent}/${setup.scopeKey}`];
        const label = `${displayName(setup.agent)} ${setupName(setup)}`;
        if (here === undefined) return `· ${label}: never pulled or pushed on this PC`;
        if (here === setup.revision) return `✓ ${label}: up to date (revision ${String(here)})`;
        if (here < setup.revision) {
          return `↓ ${label}: newer copy on the server (revision ${String(setup.revision)}, this PC has ${String(here)}). Run \`agentnomad pull\`.`;
        }
        return `? ${label}: this PC has revision ${String(here)}, the server ${String(setup.revision)}`;
      });
      // Setups this PC knew that are gone from the server (deleted from another PC).
      const onServer = new Set(setups.map((setup) => `${setup.agent}/${setup.scopeKey}`));
      for (const key of Object.keys(known)) {
        const agent = key.split('/')[0] ?? key;
        if (
          !onServer.has(key) &&
          (!flags.agents || flags.agents.includes(agent)) &&
          !flags.project &&
          !flags.global
        ) {
          lines.push(`✗ A ${displayName(agent)} setup this PC had was deleted on the server.`);
        }
      }
      reporter.info(lines.length > 0 ? lines.join('\n') : 'Nothing saved matches.');
      const folderName = await state.projectNameFor(deps.cwd);
      reporter.info(
        folderName === null
          ? 'This folder is not saved as a project.'
          : `This folder is saved as "${folderName}".`,
      );
    },

    async delete(options) {
      const { secrets, setups } = await saved();
      let chosen = matching(setups, options);
      if (setups.length === 0) {
        reporter.info('Nothing is saved, so there is nothing to delete.');
        return;
      }
      if (options.global || options.project !== undefined) {
        if (chosen.length === 0)
          throw new Error('No saved setup matches. Run `agentnomad list` to see them.');
      } else {
        const keys = await prompter.multiselect(
          'Which saved setups to delete from the server? (Your files on this PC are not touched.)',
          chosen.map((setup) => ({
            value: `${setup.agent}/${setup.scopeKey}`,
            label: `${displayName(setup.agent)} ${setupName(setup)}`,
            hint: `revision ${String(setup.revision)}`,
          })),
          { required: false, initial: [] },
        );
        chosen = chosen.filter((setup) => keys.includes(`${setup.agent}/${setup.scopeKey}`));
        if (chosen.length === 0) {
          reporter.info('Nothing was deleted.');
          return;
        }
      }
      const names = chosen.map((setup) => `${displayName(setup.agent)} ${setupName(setup)}`);
      if (
        !options.yes &&
        !(await prompter.confirm(
          `Delete ${names.join(', ')} from the server? This cannot be undone.`,
          false,
        ))
      ) {
        reporter.info('Nothing was deleted.');
        return;
      }
      for (const setup of chosen) {
        await withSession(secrets, () =>
          deps.api().bundles.delete({ agent: setup.agent, scopeKey: setup.scopeKey }),
        );
        await deps.localState().forgetRevision(setup.agent, setup.scopeKey);
        reporter.success(
          `Deleted the ${displayName(setup.agent)} ${setupName(setup)} from the server.`,
        );
      }
    },
  };
}
