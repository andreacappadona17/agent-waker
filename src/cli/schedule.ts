/**
 * The commands that change configuration: `schedule set`, `enable`, `disable`.
 *
 * Every one of them validates first, keeps a backup, and writes atomically, so
 * a failed edit cannot leave a user with a scheduler that no longer starts.
 * The file itself is edited in place rather than regenerated, which is what
 * keeps their comments and their ordering.
 */

import type { CommandContext } from "#src/cli/context.js";
import { EXIT, type ExitCode } from "#src/cli/exit.js";
import { relativeTime } from "#src/cli/format.js";
import {
  activationTimes,
  effectiveAgentConfig,
  parseConfig,
  type AgentWakerConfig,
  type ActivationTimes,
} from "#src/config/config.js";
import { editConfig, type ConfigEdit } from "#src/config/edit.js";
import { AGENT_IDS, asAgents, type AgentId } from "#src/core/agent.js";
import {
  localDateAt,
  nextLocalDate,
  resolveLocalTime,
  formatLocalTime,
  parseLocalTime,
  parseTimeZone,
} from "#src/core/time.js";
import { readFile } from "node:fs/promises";
import { writeAtomic } from "#src/state/atomic.js";

/** Owner read/write: a schedule is not secret, but it is nobody else's. */
const CONFIG_MODE = 0o600;

/** Applies edits to the configuration file, keeping the previous version. */
async function rewrite(
  context: CommandContext,
  edits: readonly ConfigEdit[],
): Promise<void> {
  const path = context.paths.config;
  const source = await readFile(path, "utf8");

  // Throws before anything is written if the result would not load.
  const updated = editConfig(source, edits);

  await writeAtomic(path, updated, {
    mode: CONFIG_MODE,
    backupPath: `${path}.bak`,
  });
}

/** CLI assignments to the already-supported per-agent desired times. */
export function parseAgentTimes(input: string | undefined): ConfigEdit[] {
  if (input === undefined) return [];
  const seen = new Set<AgentId>();
  return input.split(",").flatMap((assignment) => {
    const [name, time, extra] = assignment.split("=");
    if (name === undefined || time === undefined || extra !== undefined) {
      throw new Error(
        "--agent-times needs agent=HH:MM assignments, separated by commas.",
      );
    }
    const agent = asAgents([name])[0];
    if (agent === undefined || seen.has(agent))
      throw new Error(`Duplicate agent time: ${name}`);
    seen.add(agent);
    return scheduleEdits(parseWindowTimes(time.replaceAll("|", ",")), agent);
  });
}

/** Shows only scheduling choices, never credentials or telemetry settings. */
export function renderSchedulePlan(
  context: CommandContext,
  config: AgentWakerConfig,
): void {
  const now = context.environment.now();
  const next: number[] = [];
  const lines = [
    "Resolved schedule",
    "",
    `  Default  ${activationTimes(config).map(formatLocalTime).join(", ")} ${config.timezone}`,
  ];
  for (const agentId of AGENT_IDS) {
    for (const time of activationTimes(config, agentId)) {
      const effective = effectiveAgentConfig(config, agentId, time);
      const opens = resolveLocalTime(
        localDateAt(now, effective.timezone),
        effective.notBefore,
        effective.timezone,
      );
      if (effective.enabled)
        next.push(
          now < opens
            ? opens
            : resolveLocalTime(
                nextLocalDate(localDateAt(now, effective.timezone)),
                effective.notBefore,
                effective.timezone,
              ),
        );
      lines.push(
        `  ${context.registry.get(agentId).displayName}  ${effective.enabled ? "enabled" : "disabled"}  ${formatLocalTime(effective.notBefore)} ${effective.timezone}`,
      );
    }
  }
  lines.push(
    "",
    next.length === 0
      ? "No agents enabled."
      : `Next desired activation: ${relativeTime(Math.min(...next), now, config.timezone)}`,
  );
  context.environment.write(`${lines.join("\n")}\n`);
}

/** `schedule set 07:00 [--timezone Europe/Rome]`. */
export async function scheduleSetCommand(
  context: CommandContext,
  time: string | undefined,
  timezone: string | undefined,
  options: { agent?: string; dryRun?: boolean; assumeYes?: boolean } = {},
): Promise<ExitCode> {
  const { environment } = context;
  const agent =
    options.agent === undefined ? undefined : asAgents([options.agent])[0];
  const before = activationTimes(context.config, agent)
    .map(formatLocalTime)
    .join(", ");

  if (
    time === undefined &&
    environment.ask !== undefined &&
    environment.isTty
  ) {
    time =
      (
        await environment.ask(
          "What time do you want the agents ready by?",
          before,
        )
      ).trim() || before;
  }
  if (time === undefined) {
    environment.writeError(
      "Give a time, such as `agent-waker schedule set 07:00`.\n",
    );

    return EXIT.usage;
  }

  // Parsed here so a bad value is refused before the file is touched, and the
  // message is the same one the config loader would have given.
  const wanted = parseWindowTimes(time);
  const zone = timezone === undefined ? undefined : parseTimeZone(timezone);
  const edits: ConfigEdit[] = [
    ...scheduleEdits(wanted, agent),
    ...(zone === undefined ? [] : [{ path: ["timezone"], value: zone }]),
  ];

  const source = await readFile(context.paths.config, "utf8");
  const updated = editConfig(source, edits);
  renderSchedulePlan(context, parseConfig(updated, context.paths.config));
  if (options.dryRun === true) {
    environment.write("Dry run: nothing written.\n");
    return EXIT.ok;
  }
  if (
    environment.isTty &&
    environment.ask !== undefined &&
    options.assumeYes !== true
  ) {
    const answer =
      (await environment.ask("Apply this schedule? [Y/n]", "y")).trim() || "y";
    if (!/^y(?:es)?$/i.test(answer)) {
      environment.write("Schedule unchanged.\n");
      return EXIT.ok;
    }
  }
  if ((await readFile(context.paths.config, "utf8")) !== source) {
    throw new Error(
      "The configuration changed while the plan was being reviewed. Run schedule set again to preview the new plan.",
    );
  }
  await writeAtomic(context.paths.config, updated, {
    mode: CONFIG_MODE,
    backupPath: `${context.paths.config}.bak`,
  });

  environment.write(
    [
      "Desired activation changed",
      "",
      `  from  ${before}`,
      `  to    ${wanted.map(formatLocalTime).join(", ")}`,
      `  zone  ${zone ?? context.config.timezone}`,
      "",
      "The background scheduler does not need to be restarted; it reads this",
      "file every time it runs.",
      "",
    ].join("\n"),
  );

  return EXIT.ok;
}

/** `enable <agent>` and `disable <agent>`. */
export async function setEnabledCommand(
  context: CommandContext,
  agents: readonly AgentId[],
  enabled: boolean,
): Promise<ExitCode> {
  const { environment } = context;

  if (agents.length === 0) {
    environment.writeError(
      `Name an agent, such as \`agent-waker ${enabled ? "enable" : "disable"} codex\`.\n`,
    );

    return EXIT.usage;
  }

  await rewrite(
    context,
    agents.map((agentId) => ({
      path: ["agents", agentId, "enabled"],
      value: enabled,
    })),
  );

  for (const agentId of agents) {
    const name = context.registry.get(agentId).displayName;
    const opposite = enabled ? "disable" : "enable";

    environment.write(
      [
        `${name} ${enabled ? "enabled" : "disabled"}.`,
        "",
        enabled
          ? "  It will be evaluated at the next scheduled run."
          : "  Its scheduling state is kept, so `status` still shows what happened,",
        enabled ? "" : "  but it will never become due while it is disabled.",
        "",
        `  Undo with: agent-waker ${opposite} ${agentId}`,
        "",
      ]
        .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
        .join("\n"),
    );
  }

  // Enabling is the moment to notice the agent cannot actually run.
  if (enabled) {
    const effective = effectiveAgentConfig(
      context.config,
      agents[0] ?? "claude",
    );

    if (!effective.enabled) {
      environment.write("Run `agent-waker doctor` to check it is usable.\n");
    }
  }

  return EXIT.ok;
}

/** CLI accepts comma-separated times; config validation provides duplicate checks. */
export function parseWindowTimes(input: string): ActivationTimes {
  return input.split(",").map((time) => parseLocalTime(time.trim())) as [
    import("#src/core/time.js").LocalTime,
    ...import("#src/core/time.js").LocalTime[],
  ];
}
export function scheduleEdits(
  times: ActivationTimes,
  agent?: AgentId,
): ConfigEdit[] {
  const path =
    agent === undefined ? ["schedule"] : ["agents", agent, "schedule"];
  return times.length === 1
    ? [
        { path: [...path, "windows"], value: undefined },
        { path: [...path, "notBefore"], value: formatLocalTime(times[0]) },
      ]
    : [
        { path: [...path, "notBefore"], value: undefined },
        { path: [...path, "windows"], value: times.map(formatLocalTime) },
      ];
}
