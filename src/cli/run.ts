/**
 * `run`: make the decision now rather than waiting for the schedule.
 *
 * Not "send the prompt regardless". It skips the timer and nothing else: a
 * provider that is rate limited still reports as limited, and an agent whose
 * cycle is already complete is left alone rather than charged another turn
 * (UX §26).
 *
 * What it prints is the status vocabulary, deliberately. `run` and `status`
 * describe the same agents in the same state, so two wordings would only
 * diverge — which is also why the labels are used verbatim rather than
 * recased, and why the whole report is turned into ASCII once at the end
 * rather than a line at a time.
 */

import type { CommandContext } from "#src/cli/context.js";
import { EXIT, type ExitCode } from "#src/cli/exit.js";
import { iconFor, relativeTime } from "#src/cli/format.js";
import {
  buildAgentViews,
  details,
  nextDecisionAt,
  phaseContext,
  renderOptions,
  stateLabel,
  toAscii,
  type PhaseContext,
  type StatusAgentView,
} from "#src/cli/status.js";
import { exitFor, runTick } from "#src/cli/tick.js";
import type { AgentId } from "#src/core/agent.js";
import { LockedError } from "#src/state/store.js";

/**
 * One line per agent, saying what this run did about it.
 *
 * Only one case needs a sentence the status table would not have given: an
 * agent this run deliberately left alone, where the phase alone cannot tell
 * "activated just now" from "activated at seven, and not charged again".
 */
function outcomeLine(
  agent: StatusAgentView,
  untouched: ReadonlySet<AgentId>,
  view: PhaseContext,
  options: { unicode: boolean },
  width: number,
): string {
  const label =
    agent.enabled && untouched.has(agent.agentId) && agent.phase === "activated"
      ? `already activated ${relativeTime(
          agent.lastActivationAt,
          view.now,
          view.timezone,
        )} — nothing was sent`
      : stateLabel(agent, view);

  return `  ${iconFor(
    agent.enabled ? agent.phase : "idle",
    options,
  )} ${agent.displayName.padEnd(width)}  ${label}`;
}

/** Evaluates the named agents now, or every agent when none is named. */
export async function runCommand(
  context: CommandContext,
  agents: readonly AgentId[],
): Promise<ExitCode> {
  const { environment } = context;
  const options = renderOptions(context);

  try {
    const result = await runTick(context, {
      force: true,
      ...(agents.length > 0 ? { only: agents } : {}),
      // Eager, and the one thing written before the report: an activation is
      // allowed two minutes, so silence until the end reads as a hang. ASCII
      // regardless, because it cannot go through the report's single
      // conversion at the end.
      onEvaluate: (agentId) => {
        environment.write(
          `Checking ${context.registry.get(agentId).displayName}...\n`,
        );
      },
    });

    // Read back rather than reported: `run` says what is true now, which is
    // what the next `status` will say too.
    const now = environment.now();
    const view = phaseContext(context, now);
    const all = await buildAgentViews(context, now);
    const chosen =
      agents.length > 0
        ? all.filter((agent) => agents.includes(agent.agentId))
        : all;
    // Under `force`, the only reason to skip an enabled agent is a cycle it
    // already finished.
    const untouched = new Set(
      result.agents
        .filter((outcome) => outcome.skipped === "not_due")
        .map((outcome) => outcome.agentId),
    );
    const width = Math.max(...chosen.map((agent) => agent.displayName.length));
    const soonest = chosen
      .map(nextDecisionAt)
      .filter((instant) => instant !== undefined)
      .toSorted((left, right) => left - right)[0];

    const rendered = [
      "",
      "Activation check complete",
      "",
      ...chosen.map((agent) =>
        outcomeLine(agent, untouched, view, options, width),
      ),
      ...details(chosen, view),
      // Omitted rather than filled with an em dash: nothing is scheduled when
      // every agent is disabled or waiting on a person, and saying so is the
      // table's job, not the footer's.
      ...(soonest === undefined
        ? []
        : [
            "",
            `Next scheduled decision: ${relativeTime(soonest, now, view.timezone)}`,
          ]),
      "",
    ].join("\n");

    environment.write(`${options.unicode ? rendered : toAscii(rendered)}\n`);

    return exitFor(result);
  } catch (error) {
    if (!(error instanceof LockedError)) throw error;

    // The scheduled tick got there first. Saying so beats a stack trace, and
    // beats waiting for a run that is already happening.
    environment.writeError(
      "A scheduled run is already in progress. Try again in a moment.\n",
    );

    return EXIT.failed;
  }
}
