/** The coding agents this build knows how to activate. */

// ponytail: a fixed list, not a plugin registry. Adapters are compiled in for
// v0.1; when a third-party adapter can be installed, this becomes a lookup
// against the adapter registry and configuration validation moves with it.
import { describeValue } from "#src/core/describe.js";

export const AGENT_IDS = ["claude", "codex"] as const;

/** Identifies one supported coding agent. */
export type AgentId = (typeof AGENT_IDS)[number];

/** Narrows a configured or persisted key to a supported agent. */
export function isAgentId(value: unknown): value is AgentId {
  return (AGENT_IDS as readonly unknown[]).includes(value);
}

/**
 * Narrows names to agents, naming anything that is not one.
 *
 * Case-insensitive, because this reads what a person typed — at a prompt or on
 * a command line — and "Claude" is not a different product.
 *
 * @throws {Error} naming the first unrecognised value and what is supported.
 */
export function asAgents(names: readonly string[]): AgentId[] {
  return names.map((name) => {
    const candidate = name.trim().toLowerCase();

    if (!isAgentId(candidate)) {
      throw new Error(
        `Unknown agent ${describeValue(name)}. This build supports ${AGENT_IDS.join(", ")}.`,
      );
    }

    return candidate;
  });
}
