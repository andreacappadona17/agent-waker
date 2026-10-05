/** Gemini's native env search must stop at its dedicated HOME boundary. */
import { join } from "node:path";
import type { AgentId } from "#src/core/agent.js";
export function adapterWorkDirectory(
  root: string,
  agent: AgentId,
  providerHome?: string,
): string {
  return agent === "gemini" && providerHome !== undefined
    ? join(providerHome, "work")
    : join(root, agent);
}
