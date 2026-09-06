/** Shared between adapters: what discovery found, as the contract describes it. */

import type { DetectionResult } from "#src/adapters/contract.js";
import type { ExecutableDiscovery } from "#src/process/discovery.js";

/** Trims a version line down to the version, when there is one to find. */
function versionOf(line: string | undefined): string | undefined {
  return /\d+\.\d+\.\d+/.exec(line ?? "")?.[0] ?? line;
}

/**
 * Turns what discovery found into what the orchestrator asks about.
 *
 * A found-but-unrunnable executable is `broken` rather than absent, because
 * the two need different advice: one is "install it", the other is "your
 * wrapper outlived its runtime".
 */
export function toDetection(found: ExecutableDiscovery): DetectionResult {
  if (!found.installed || found.selected === undefined) {
    return { installed: false, health: "unknown" };
  }

  const version = versionOf(found.version);

  return {
    installed: true,
    executable: found.selected.path,
    health: found.health === "healthy" ? "ok" : "broken",
    installHint: found.selected.installHint,
    ...(version === undefined ? {} : { version }),
  };
}
