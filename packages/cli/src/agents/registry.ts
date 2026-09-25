import type { AgentId } from '@agentnomad/contracts';

import type { AgentAdapter, AgentRegistry } from './adapter.ts';

/**
 * The only place agents are registered (T28). Adding an agent means writing its adapter
 * and adding it to the list passed in; nothing else changes.
 */
export function createAgentRegistry(adapters: readonly AgentAdapter[]): AgentRegistry {
  const byId = new Map<AgentId, AgentAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.id)) throw new Error(`Agent "${adapter.id}" is registered twice`);
    byId.set(adapter.id, adapter);
  }
  const list = Object.freeze([...adapters]);
  return {
    list: () => list,
    get: (id) => byId.get(id),
  };
}
