/**
 * `tick`: the scheduler's entry point.
 *
 * Entirely non-interactive, quiet when nothing is due, and safe to run every
 * minute. An overlapping run is not an error — the second one steps aside and
 * reports success, because a scheduler that logs a failure every minute while
 * a slow run finishes is worse than one that says nothing.
 */

import { EXIT, type ExitCode } from "#src/cli/exit.js";
import type { CommandContext } from "#src/cli/context.js";
import { tick, type TickOptions } from "#src/core/orchestrator.js";
import { LockedError } from "#src/state/store.js";

/** Phases that no amount of waiting will clear. */
const NEEDS_A_PERSON = new Set(["unhealthy", "auth_required", "failed"]);

export async function tickCommand(
  context: CommandContext,
  options: TickOptions = {},
): Promise<ExitCode> {
  const { environment } = context;

  try {
    const result = await tick(
      {
        config: context.config,
        store: context.store,
        registry: context.registry,
        log: context.log,
        runner: context.runner,
        workDir: context.paths.workDir,
        runtime: "local",
        now: environment.now,
      },
      options,
    );

    // Deferment is state, not failure: only something a person has to fix
    // counts against the exit code.
    return result.agents.some((agent) => NEEDS_A_PERSON.has(agent.phase))
      ? EXIT.partial
      : EXIT.ok;
  } catch (error) {
    if (error instanceof LockedError) {
      // The previous run is still going. Nothing to do and nothing wrong.
      return EXIT.ok;
    }

    throw error;
  }
}
