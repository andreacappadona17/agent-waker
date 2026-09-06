/** Finds the adapter for an agent. */

import type { AgentId } from "#src/core/agent.js";
import type { AgentAdapter } from "#src/adapters/contract.js";

/** Raised when this build has no adapter for an agent it was asked about. */
export class UnknownAdapterError extends Error {
  readonly agentId: string;

  constructor(agentId: string) {
    super(`No adapter is registered for ${agentId}.`);
    this.name = "UnknownAdapterError";
    this.agentId = agentId;
  }
}

export interface AdapterRegistry {
  get(id: AgentId): AgentAdapter;
  list(): AgentAdapter[];
}

/** Builds a registry, refusing a duplicate rather than picking a winner. */
export function createRegistry(
  adapters: readonly AgentAdapter[],
): AdapterRegistry {
  const byId = new Map<AgentId, AgentAdapter>();

  for (const adapter of adapters) {
    if (byId.has(adapter.id)) {
      throw new Error(`Two adapters claim to be ${adapter.id}.`);
    }

    byId.set(adapter.id, adapter);
  }

  return {
    get(id: AgentId): AgentAdapter {
      const adapter = byId.get(id);

      if (adapter === undefined) throw new UnknownAdapterError(id);

      return adapter;
    },

    list(): AgentAdapter[] {
      return [...byId.values()];
    },
  };
}
