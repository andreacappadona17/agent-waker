/**
 * `uninstall`: remove what agent waker put there, and nothing else.
 *
 * It never touches a provider CLI. Somebody who stops using this scheduler has
 * not stopped using Claude Code, and a program that removes tools it did not
 * install is one nobody should run.
 *
 * Deleting is not reversible, so it says exactly what will go and asks first
 * whenever there is somebody to ask.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";

import { schedulerFor, type CommandContext } from "#src/cli/context.js";
import { EXIT, type ExitCode } from "#src/cli/exit.js";

/** Everything the state directory holds apart from the logs. */
const STATE_FILES = ["state.json", "state.json.bak", "lock"];

export interface UninstallOptions {
  /** Logs are kept by default: they are the record of what happened. */
  readonly includeLogs: boolean;
  /** Skips the confirmation, for a script that has already decided. */
  readonly assumeYes: boolean;
}

export async function uninstallCommand(
  context: CommandContext,
  options: UninstallOptions,
): Promise<ExitCode> {
  const { environment, paths } = context;
  const targets = [
    ["the scheduled job", "~/Library/LaunchAgents"],
    ["configuration", paths.configDir],
    ["state", paths.stateDir],
    ...(options.includeLogs ? [["logs", paths.logDir]] : []),
    ["cached working files", paths.cacheDir],
  ] as const;

  environment.write(
    [
      "This will remove:",
      "",
      ...targets.map(([what, where]) => `  ${what.padEnd(22)} ${where}`),
      "",
      ...(options.includeLogs
        ? []
        : ["Logs are kept. Add --logs to remove them as well.", ""]),
      "Claude Code and Codex are left alone; agent waker did not install them.",
      "",
    ].join("\n"),
  );

  const answer = options.assumeYes
    ? "y"
    : ((await environment.ask?.("Remove them? [y/N]", "n")) ?? "n");

  if (!/^y/i.test(answer)) {
    environment.write("Nothing was removed.\n");

    return EXIT.ok;
  }

  await schedulerFor(context)
    .uninstall()
    // The files still go: a scheduler entry pointing at nothing is worse than
    // one that was cleanly removed, and doctor would have flagged it anyway.
    .catch(() => undefined);

  if (options.includeLogs) {
    await rm(paths.logDir, { recursive: true, force: true });
  }

  // The log directory sits inside the state directory, so the state files are
  // removed by name rather than by wiping the parent. Removing the parent is
  // then attempted and simply fails while the logs are still in it.
  for (const name of STATE_FILES) {
    await rm(join(paths.stateDir, name), { force: true });
  }

  await rm(paths.stateDir, {
    recursive: options.includeLogs,
    force: true,
  }).catch(() => undefined);

  await rm(paths.configDir, { recursive: true, force: true });
  await rm(paths.cacheDir, { recursive: true, force: true });

  environment.write("agent waker removed.\n");

  return EXIT.ok;
}
