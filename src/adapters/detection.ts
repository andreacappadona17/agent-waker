/** Shared between adapters: reading what a provider says about itself. */

import type { AgentObservation } from "#src/core/observation.js";
import type { ProcessResult } from "#src/process/runner.js";

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

/**
 * Which of an activation's flags a provider no longer offers.
 *
 * Tokenised rather than a substring search, which is the difference between a
 * check that works and one that cannot fail. `-p` occurs forty-four times
 * inside other words in Claude's help, and `--sandbox` is a substring of
 * `--sandbox-mode` — so `includes` would pass a provider that had dropped the
 * flag and a provider that had renamed it, which are the two cases this
 * exists for.
 *
 * Takes the activation's whole argument list, so there is no second list of
 * flags to drift out of step with what is actually passed.
 */
export function missingFlags(
  help: string,
  activationArgs: readonly string[],
): readonly string[] {
  // Word characters and hyphens, so `-p, --print` yields both flags and
  // `--output-format=json` yields the flag without its value.
  const offered = new Set(help.split(/[^\w-]+/));

  // ponytail: an option *value* starting with a dash would be read as a flag.
  // None does. Mark the values if that changes.
  return activationArgs.filter(
    (argument) => argument.startsWith("-") && !offered.has(argument),
  );
}

/** Maps process startup and timeout failures consistently across adapters. */
export function processFailure(
  result: ProcessResult,
): AgentObservation | undefined {
  if (result.timedOut) return { kind: "runtime_error", category: "timeout" };

  switch (result.startFailure) {
    case undefined:
      return undefined;
    case "ENOENT":
      return { kind: "runtime_error", category: "executable_missing" };
    case "ENOEXEC":
    case "EACCES":
      return { kind: "runtime_error", category: "broken_install" };
    default:
      return { kind: "runtime_error", category: "unknown" };
  }
}
