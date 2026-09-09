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

import { realpath, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { schedulerFor, type CommandContext } from "#src/cli/context.js";
import { EXIT, type ExitCode } from "#src/cli/exit.js";

/** Everything the state directory holds apart from the logs. */
const STATE_FILES = ["state.json", "state.json.bak"];

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

  await context.store.withLock(async () => {
    const nested = relative(
      await realpath(paths.workDir),
      await realpath(paths.stateDir),
    );
    if (nested !== ".." && !nested.startsWith("../") && !isAbsolute(nested)) {
      throw new Error(
        "Cannot remove cached working files: the state directory is inside them. Move the state directory before uninstalling.",
      );
    }

    await schedulerFor(context)
      .uninstall()
      .catch(() => undefined);

    if (options.includeLogs) {
      await rm(paths.logDir, { recursive: true, force: true });
    }

    for (const name of STATE_FILES) {
      await rm(join(paths.stateDir, name), { force: true });
    }

    // Keep the lock inode and its directory. Unlinking it would let another
    // process create a different file and bypass locks held by existing openers.
    await rm(paths.config, { force: true });
    await rm(`${paths.config}.bak`, { force: true });
    await rm(paths.workDir, { recursive: true, force: true });
    // XDG roots can coincide. Remove only owned files, then empty directories.
    await rmdir(paths.configDir).catch(() => undefined);
    await rmdir(paths.cacheDir).catch(() => undefined);
  });

  environment.write("agent waker removed.\n");

  return EXIT.ok;
}
