/**
 * `init`: from nothing to a machine that wakes its agents in the morning.
 *
 * Interactive when somebody is there and silent when nobody is, which is the
 * same code path either way: every question has a default, and without a
 * terminal the default is simply taken. That keeps it scriptable without a
 * second implementation to drift.
 *
 * It writes a configuration file with its defaults spelled out in comments,
 * because the next thing a user does is open it.
 */

import { readFile } from "node:fs/promises";

import { schedulerFor, type CommandContext } from "#src/cli/context.js";
import { renderDetection, surveyAgents } from "#src/cli/detect.js";
import { EXIT, type ExitCode } from "#src/cli/exit.js";
import { relativeTime, supportsUnicode } from "#src/cli/format.js";
import { effectiveAgentConfig, parseConfig } from "#src/config/config.js";
import { editConfig } from "#src/config/edit.js";
import { AGENT_IDS, asAgents, type AgentId } from "#src/core/agent.js";
import { cycleStartAt } from "#src/core/state.js";
import {
  DAY_MS,
  formatLocalTime,
  parseLocalTime,
  parseTimeZone,
} from "#src/core/time.js";
import { writeAtomic } from "#src/state/atomic.js";

const CONFIG_MODE = 0o600;
const DEFAULT_NOT_BEFORE = "07:00";

/** Enough for a typo, few enough that a piped answer cannot spin. */
const MAX_PROMPT_ATTEMPTS = 3;

/**
 * What the scheduler does, once it is installed.
 *
 * The last line is the one that matters: what users worry about is a provider
 * being called every minute, and it is the schedule that runs that often, not
 * the agents (UX §6.7).
 */
const SCHEDULER_NOTE = `The background schedule is installed.

  it checks what is due every minute
  no terminal window needs to stay open
  agents are only contacted when one is actually due

`;

/** How often launchd wakes us. A minute is cheap and keeps drift invisible. */
const TICK_INTERVAL_SECONDS = 60;

/**
 * The starting configuration, with its own defaults written out.
 *
 * Static, and edited rather than generated: a first run then takes exactly the
 * same path as every later one, including the round-trip through `parseConfig`
 * that `editConfig` does. The one file this program must be able to read is
 * the one it just wrote, and that guarantee used to apply only to the second
 * write.
 */
const TEMPLATE = `# agent waker configuration.
#
# Edit it by hand, or with \`agent-waker schedule set\`. Every value below is
# the default; delete a line to go back to it.
version: 1

# An IANA timezone name. The schedule is wall-clock time in this zone, so the
# time below does not move across daylight-saving changes.
timezone: UTC

schedule:
  # The earliest time to wake the agents. Not a guarantee of when they run.
  notBefore: "${DEFAULT_NOT_BEFORE}"

# How much to write to the event log. Raise it to debug to see no-op ticks and
# telemetry export failures.
# logging:
#   level: info

# Send traces and logs to an OpenTelemetry collector. Off until an endpoint is
# named here; nothing leaves this machine otherwise. Scheduling never fails
# because a collector is unreachable.
#
# telemetry:
#   endpoint: http://localhost:4318
#   headers:
#     x-scope-orgid: team
#   serviceName: agent-waker
#   timeout: 5s

# Which agents are in the daily cycle. Change one with
# \`agent-waker enable\` or \`agent-waker disable\`.
agents:
  claude:
    enabled: true
  codex:
    enabled: true
`;

const WELCOME = `agent waker

Keep coding-agent subscription windows aligned with when you work.

  · finds the agent CLIs already on this computer
  · uses the subscription login each one already has
  · activates them from a time you choose
  · waits when a usage window has not reset yet

It does not install agents, and it does not store your credentials.

`;

/**
 * What happens when an agent is still limited, said once.
 *
 * The retry ladder is deliberately not configurable during setup (UX §6.6).
 * Explaining it once is what stops the first deferred morning looking like a
 * failure.
 */
function deferralNote(notBefore: string, horizonMs: number): string {
  // Read from the configuration rather than stated: a re-init of a file with
  // its own horizon would otherwise quote the default back at the user.
  const hours = Math.round(horizonMs / 3_600_000);

  return `
If an agent is still limited at ${notBefore}, agent waker waits for its reset
time when the provider gives one. When it does not, it retries gradually for
up to ${String(hours)} hours, then switches to infrequent checks.

`;
}

/**
 * Which agents to manage.
 *
 * Re-asks rather than aborting: this is the first prompt of the onboarding,
 * and a typo should not send the user back to the beginning of it.
 */
async function chooseAgents(
  context: CommandContext,
  offered: readonly AgentId[],
): Promise<ReadonlySet<AgentId>> {
  const question = `Which agents should agent waker manage? [${AGENT_IDS.join(
    ", ",
  )}, or none]`;

  // Bounded, so a script piping nonsense cannot spin. Interactively, three
  // goes is more than the answer needs.
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
    // "none" rather than an empty default, so the prompt never renders as `()`.
    const answer = await askOr(context, question, offered.join(", ") || "none");

    if (/^none$/i.test(answer)) return new Set();

    try {
      return new Set(
        asAgents(answer.split(/[\s,]+/).filter((name) => name !== "")),
      );
    } catch (error) {
      // Nothing has been written yet, so re-asking costs the user a line.
      if (context.environment.ask === undefined) throw error;

      context.environment.writeError(`${(error as Error).message}\n`);
    }
  }

  throw new Error(`Giving up after ${String(MAX_PROMPT_ATTEMPTS)} attempts.`);
}

async function askOr(
  context: CommandContext,
  question: string,
  fallback: string,
): Promise<string> {
  const answer = await context.environment.ask?.(question, fallback);

  return answer === undefined || answer.trim() === ""
    ? fallback
    : answer.trim();
}

/** Rebuilds the scheduler from the paths that are true right now. */
async function installScheduler(context: CommandContext): Promise<void> {
  await schedulerFor(context).install({
    nodePath: context.environment.execPath,
    entrypoint: context.environment.entrypoint,
    intervalSeconds: TICK_INTERVAL_SECONDS,
    logDirectory: context.paths.logDir,
  });
}

/**
 * `init --repair`: the configuration is fine, the scheduler is not.
 *
 * The case this exists for is a Node upgrade or a reinstall, which leaves the
 * LaunchAgent pointing at a launcher that has moved.
 */
export async function repairCommand(
  context: CommandContext,
): Promise<ExitCode> {
  await installScheduler(context);

  context.environment.write(
    [
      "Scheduler reinstalled.",
      "",
      `  interpreter  ${context.environment.execPath}`,
      `  entry point  ${context.environment.entrypoint}`,
      "",
      "Check it with: agent-waker doctor",
      "",
    ].join("\n"),
  );

  return EXIT.ok;
}

/**
 * Writes the choices into the configuration, keeping everything else.
 *
 * One path whether the file exists or not: a missing one starts from the
 * template, and `editConfig` puts the values in either way.
 */
async function writeChoices(
  context: CommandContext,
  existing: string | undefined,
  choices: {
    timezone: string;
    notBefore: string;
    enabled: ReadonlySet<AgentId>;
  },
): Promise<void> {
  await writeAtomic(
    context.paths.config,
    editConfig(existing ?? TEMPLATE, [
      { path: ["timezone"], value: choices.timezone },
      { path: ["schedule", "notBefore"], value: choices.notBefore },
      ...AGENT_IDS.map((agentId) => ({
        path: ["agents", agentId, "enabled"],
        value: choices.enabled.has(agentId),
      })),
    ]),
    // Best effort, and a no-op on a first run: there is nothing to keep yet.
    { mode: CONFIG_MODE, backupPath: `${context.paths.config}.bak` },
  );
}

export interface InitOptions {
  readonly time?: string;
  readonly timezone?: string;
  /**
   * Which agents to manage, comma-separated, or `none`.
   *
   * Given so that `init` is fully specifiable from the command line: without
   * it a bootstrap script run in a terminal would block on the prompt.
   */
  readonly agents?: string;
}

export async function initCommand(
  context: CommandContext,
  options: InitOptions,
): Promise<ExitCode> {
  const { environment } = context;

  environment.write(WELCOME);

  const existing = await readFile(context.paths.config, "utf8").catch(
    () => undefined,
  );

  // What is actually installed, before asking anything that depends on it.
  const surveys = await surveyAgents(context);

  environment.write(
    `${renderDetection(surveys, {
      unicode: supportsUnicode(environment.env),
    })}\n`,
  );

  // A second `init` is a user changing a time, not asking to have a decision
  // they already made reconsidered: offering the healthy agents here would
  // silently switch a disabled one back on. On a first run only the ready ones
  // are offered — an agent that is missing, broken, or signed in with
  // something unusable would fail every morning until somebody noticed
  // (UX §6.4). None ready means none offered, and the user can still name one
  // they are about to sign into.
  const offered =
    existing === undefined
      ? surveys.filter((survey) => survey.ready).map((survey) => survey.agentId)
      : AGENT_IDS.filter((agentId) => context.config.agents[agentId].enabled);
  const enabled =
    options.agents === undefined
      ? await chooseAgents(context, offered)
      : new Set(
          /^none$/i.test(options.agents.trim())
            ? []
            : asAgents(options.agents.split(/[\s,]+/).filter((n) => n !== "")),
        );

  const timezone = parseTimeZone(
    options.timezone ??
      (await askOr(
        context,
        "Which timezone is your working day in?",
        environment.systemTimezone,
      )),
  );
  const notBefore = formatLocalTime(
    parseLocalTime(
      options.time ??
        (await askOr(
          context,
          "What time do you want the agents ready by?",
          DEFAULT_NOT_BEFORE,
        )),
    ),
  );

  environment.write(
    deferralNote(
      notBefore,
      context.config.retry.unknownReset.normalWindowHorizonMs,
    ),
  );

  // Re-read: the prompts above have no time limit, and the file may have
  // appeared or changed while they were open.
  await writeChoices(
    context,
    await readFile(context.paths.config, "utf8").catch(() => undefined),
    { timezone, notBefore, enabled },
  );
  await installScheduler(context);

  environment.write(SCHEDULER_NOTE);

  // Re-read and re-parse: `context.config` was loaded before this command
  // wrote the file, so it still says what was true a moment ago. Reporting
  // from it would be wrong, and handing it to a catch-up run would contact
  // agents the user has just excluded — a real provider turn, spent against
  // an answer they gave thirty seconds earlier.
  const written = parseConfig(
    await readFile(context.paths.config, "utf8"),
    context.paths.config,
  );
  const now = environment.now();

  // `notBefore` can be set per agent, so both of the times below read every
  // enabled agent rather than whichever one is listed first. Nothing enabled
  // means nothing will happen, and then the global time is still the honest
  // thing to show.
  const enabledAgents = AGENT_IDS.filter((id) => written.agents[id].enabled);
  const windows = (enabledAgents.length > 0 ? enabledAgents : AGENT_IDS).map(
    (agentId) => {
      const effective = effectiveAgentConfig(written, agentId);
      const opens = cycleStartAt(effective, now);

      return {
        opens,
        next: now < opens ? opens : cycleStartAt(effective, now + DAY_MS),
      };
    },
  );

  // The next decision point is the earliest window, not the first-listed.
  const next = Math.min(...windows.map((window) => window.next));
  // Past the earliest opening is enough for the catch-up offer below: a run
  // then has at least one agent whose window is open.
  const opensAt = Math.min(...windows.map((window) => window.opens));

  environment.write(
    [
      "agent waker is ready.",
      "",
      `  Desired activation   ${notBefore} ${timezone}`,
      ...surveys.map(
        ({ agentId, displayName }) =>
          `  ${displayName.padEnd(20)} ${
            written.agents[agentId].enabled ? "enabled" : "disabled"
          }`,
      ),
      "",
      "Next decision point:",
      `  ${relativeTime(next, now, timezone)}`,
      "",
      "Useful commands:",
      "  agent-waker status",
      "  agent-waker doctor",
      "  agent-waker run",
      "",
    ].join("\n"),
  );

  // Set up after the morning has passed: offer to catch up rather than
  // leaving the machine idle until tomorrow.
  // Yes by default when somebody is there to say no (UX §6.8): the
  // alternative is a machine that was just set up and then does nothing until
  // tomorrow. Never when nobody is, because a scripted install must not start
  // talking to providers on its own.
  if (now >= opensAt && environment.ask !== undefined) {
    const answer = await askOr(
      context,
      "It is already past today's activation time. Check the agents now? [Y/n]",
      "y",
    );

    if (/^y/i.test(answer)) {
      environment.write("\n");

      const { tickCommand } = await import("#src/cli/tick.js");

      // The configuration this command just wrote, not the one it started
      // with: a disabled agent must stay untouched.
      return await tickCommand(
        { ...context, config: written },
        { force: true },
      );
    }
  }

  return EXIT.ok;
}
