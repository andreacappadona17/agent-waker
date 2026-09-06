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
import { effectiveAgentConfig } from "#src/config/config.js";
import { editConfig, type ConfigEdit } from "#src/config/edit.js";
import type { AgentId } from "#src/core/agent.js";
import {
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

/** `schedule set 07:00 [--timezone Europe/Rome]`. */
export async function scheduleSetCommand(
  context: CommandContext,
  time: string | undefined,
  timezone: string | undefined,
): Promise<ExitCode> {
  const { environment } = context;

  if (time === undefined) {
    environment.writeError(
      "Give a time, such as `agent-waker schedule set 07:00`.\n",
    );

    return EXIT.usage;
  }

  // Parsed here so a bad value is refused before the file is touched, and the
  // message is the same one the config loader would have given.
  const wanted = parseLocalTime(time);
  const zone = timezone === undefined ? undefined : parseTimeZone(timezone);
  const before = formatLocalTime(context.config.schedule.notBefore);

  const edits: ConfigEdit[] = [
    { path: ["schedule", "notBefore"], value: formatLocalTime(wanted) },
    ...(zone === undefined ? [] : [{ path: ["timezone"], value: zone }]),
  ];

  await rewrite(context, edits);

  environment.write(
    [
      "Desired activation changed",
      "",
      `  from  ${before}`,
      `  to    ${formatLocalTime(wanted)}`,
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
