/**
 * `tick`: the scheduler's entry point.
 *
 * Entirely non-interactive, quiet when nothing is due, and safe to run every
 * minute. An overlapping run is not an error — the second one steps aside and
 * reports success, because a scheduler that logs a failure every minute while
 * a slow run finishes is worse than one that says nothing.
 *
 * This is also where telemetry leaves the machine, once, after the work is
 * done and the lock is released.
 */

import { EXIT, type ExitCode } from "#src/cli/exit.js";
import type { CommandContext } from "#src/cli/context.js";
import { tick, type TickOptions } from "#src/core/orchestrator.js";
import { needsAttention } from "#src/core/state.js";
import { LockedError } from "#src/state/store.js";

export async function tickCommand(
  context: CommandContext,
  options: TickOptions = {},
): Promise<ExitCode> {
  const { environment } = context;
  // A tick that throws still has something worth exporting; one that found
  // nothing to do does not.
  let worthExporting = true;

  try {
    const result = await tick(
      {
        config: context.config,
        store: context.store,
        registry: context.registry,
        log: context.log,
        telemetry: context.telemetry,
        runner: context.runner,
        workDir: context.paths.workDir,
        runtime: "local",
        now: environment.now,
        // The tick's own instant is frozen; measuring how long a provider took
        // needs a clock that moves.
        wallClock: Date.now,
      },
      options,
    );

    // A tick that said nothing to the event log has nothing to say to a
    // collector either (ARCHITECTURE §34), and skipping the export keeps the
    // common case off the network: on a minute-level schedule an unreachable
    // collector would otherwise cost a connection attempt every minute. Driven
    // by what was actually emitted rather than by whether an agent ran, so a
    // recovered or reset state file is still reported.
    worthExporting = result.notable;

    // Deferment is state, not failure: only something a person has to fix
    // counts against the exit code.
    return result.agents.some((agent) => needsAttention(agent.phase))
      ? EXIT.partial
      : EXIT.ok;
  } catch (error) {
    if (error instanceof LockedError) {
      // The previous run is still going. Nothing to do and nothing wrong.
      return EXIT.ok;
    }

    throw error;
  } finally {
    const failure = worthExporting
      ? await context.telemetry.flush()
      : undefined;

    if (failure !== undefined) {
      // Debug, not warn: a collector that is unreachable on a train must not
      // put a line in the log every minute. The scheduler kept working.
      // Swallowed: this runs in a `finally`, so a filesystem error here would
      // replace whatever the tick was about to return or throw.
      await context.log
        .write({
          timestamp: environment.now(),
          level: "debug",
          event: "telemetry.export_failed",
          runtime: "local",
          fields: { detail: failure },
        })
        .catch(() => undefined);
    }
  }
}
