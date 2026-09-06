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
import { detectCommand } from "#src/cli/detect.js";
import { EXIT, type ExitCode } from "#src/cli/exit.js";
import { relativeTime } from "#src/cli/format.js";
import { effectiveAgentConfig } from "#src/config/config.js";
import { editConfig } from "#src/config/edit.js";
import { AGENT_IDS } from "#src/core/agent.js";
import { cycleStartAt } from "#src/core/state.js";
import {
  formatLocalTime,
  parseLocalTime,
  parseTimeZone,
} from "#src/core/time.js";
import { writeAtomic } from "#src/state/atomic.js";

const CONFIG_MODE = 0o600;
const DEFAULT_NOT_BEFORE = "07:00";

/** How often launchd wakes us. A minute is cheap and keeps drift invisible. */
const TICK_INTERVAL_SECONDS = 60;

/**
 * The starting configuration, with its own defaults written out.
 *
 * Generated rather than copied so the values a user chose are the ones in the
 * file, and commented so the file explains itself when they open it.
 */
function template(timezone: string, notBefore: string): string {
  return `# agent waker configuration.
#
# Edit it by hand, or with \`agent-waker schedule set\`. Every value below is
# the default; delete a line to go back to it.
version: 1

# An IANA timezone name. The schedule is wall-clock time in this zone, so it
# stays at ${notBefore} across daylight-saving changes.
timezone: ${timezone}

schedule:
  # The earliest time to wake the agents. Not a guarantee of when they run.
  notBefore: "${notBefore}"

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

# Both agents are included by default. Turn one off with
# \`agent-waker disable codex\`.
agents:
  claude:
    enabled: true
  codex:
    enabled: true
`;
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

/** Writes the configuration file if it is not there, and returns its contents. */
async function ensureConfig(
  context: CommandContext,
  timezone: string,
  notBefore: string,
): Promise<void> {
  const existing = await readFile(context.paths.config, "utf8").catch(
    () => undefined,
  );

  if (existing === undefined) {
    await writeAtomic(context.paths.config, template(timezone, notBefore), {
      mode: CONFIG_MODE,
    });

    return;
  }

  // Already configured: change only what was asked for, keeping the rest.
  await writeAtomic(
    context.paths.config,
    editConfig(existing, [
      { path: ["timezone"], value: timezone },
      { path: ["schedule", "notBefore"], value: notBefore },
    ]),
    { mode: CONFIG_MODE, backupPath: `${context.paths.config}.bak` },
  );
}

export interface InitOptions {
  readonly time?: string;
  readonly timezone?: string;
}

export async function initCommand(
  context: CommandContext,
  options: InitOptions,
): Promise<ExitCode> {
  const { environment } = context;

  environment.write("Setting up agent waker.\n\n");

  // What is actually installed, before asking anything that depends on it.
  await detectCommand(context);

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

  await ensureConfig(context, timezone, notBefore);
  await installScheduler(context);

  // Re-read, so what is reported is what the file now says rather than what
  // was asked for.
  const config = await readFile(context.paths.config, "utf8");
  const now = environment.now();
  const effective = effectiveAgentConfig(context.config, "claude");
  const opensAt = cycleStartAt(
    { ...effective, timezone, notBefore: parseLocalTime(notBefore) },
    now,
  );
  const next =
    now < opensAt
      ? opensAt
      : cycleStartAt(
          { ...effective, timezone, notBefore: parseLocalTime(notBefore) },
          now + 86_400_000,
        );

  environment.write(
    [
      "agent waker is ready.",
      "",
      `  Desired activation   ${notBefore} ${timezone}`,
      ...AGENT_IDS.map(
        (agentId) =>
          `  ${context.registry.get(agentId).displayName.padEnd(20)} ${
            config.includes(`${agentId}:\n    enabled: false`)
              ? "disabled"
              : "enabled"
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
  if (now >= opensAt) {
    const answer = await askOr(
      context,
      "It is already past today's activation time. Check the agents now? [Y/n]",
      "n",
    );

    if (/^y/i.test(answer)) {
      environment.write("\n");

      const { tickCommand } = await import("#src/cli/tick.js");

      return await tickCommand(context, { force: true });
    }
  }

  return EXIT.ok;
}
