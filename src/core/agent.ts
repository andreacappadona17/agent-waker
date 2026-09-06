/** The coding agents this build knows how to activate. */

// ponytail: a fixed list, not a plugin registry. Adapters are compiled in for
// v0.1; when a third-party adapter can be installed, this becomes a lookup
// against the adapter registry and configuration validation moves with it.
export const AGENT_IDS = ["claude", "codex"] as const;

/** Identifies one supported coding agent. */
export type AgentId = (typeof AGENT_IDS)[number];

/** Narrows a configured or persisted key to a supported agent. */
export function isAgentId(value: unknown): value is AgentId {
  return (AGENT_IDS as readonly unknown[]).includes(value);
}
