/** A user timer wakes short-lived ticks; no root or resident process is needed. */
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { TIMEOUTS, type ProcessRunner } from "#src/process/runner.js";
import type {
  SchedulerDriver,
  SchedulerInstallConfig,
} from "#src/schedulers/contract.js";
import { inspectLauncher, renderLauncher } from "#src/schedulers/launcher.js";
import { writeAtomic } from "#src/state/atomic.js";

export const SYSTEMD_UNIT = "agent-waker";

export interface SystemdUserOptions {
  readonly runner: ProcessRunner;
  readonly unitDirectory: string;
  readonly launcherPath: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** systemd quoting is not shell quoting: specifiers and dollar expansion also apply. */
function execArgument(value: string): string {
  return JSON.stringify(value)
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$");
}

const timerDefinition = `[Unit]
Description=agent waker five-minute schedule

[Timer]
OnCalendar=*-*-* *:0/5:00
Persistent=true
AccuracySec=1s
RandomizedDelaySec=0

[Install]
WantedBy=timers.target
`;

const serviceDefinition = (launcherPath: string) => `[Unit]
Description=agent waker scheduling tick

[Service]
Type=oneshot
ExecStart=/bin/sh ${execArgument(launcherPath)}
`;

/** Decode systemctl's shell_maybe_quote(str, 0) string array without shell evaluation. */
function unitPaths(output: string): string[] {
  const value = output.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  const tokens =
    value.match(
      // eslint-disable-next-line no-control-regex -- Native systemctl escapes raw control bytes.
      /"(?:[^"\\\u0000-\u001f\u007f]|\\(?:["\\`$abfnrtv]|[0-3][0-7]{2}))*"|[^ "\\\u0000-\u001f\u007f]+/g,
    ) ?? [];
  if (tokens.join(" ") !== value) return [];
  const escapes: Record<string, string> = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
  };
  return tokens.map((token) =>
    token.startsWith('"')
      ? token
          .slice(1, -1)
          .replace(
            /\\(["\\`$abfnrtv]|[0-3][0-7]{2})/g,
            (_match, escape: string) =>
              escapes[escape] ??
              (escape.length === 3
                ? String.fromCharCode(parseInt(escape, 8))
                : escape),
          )
      : token,
  );
}

export function createSystemdUserScheduler(
  options: SystemdUserOptions,
): SchedulerDriver {
  const { runner, unitDirectory, launcherPath } = options;
  const timer = `${SYSTEMD_UNIT}.timer`;
  const service = `${SYSTEMD_UNIT}.service`;
  const jobPath = join(unitDirectory, timer);
  const servicePath = join(unitDirectory, service);
  const command = (args: readonly string[]) =>
    runner.run({
      executable: "/usr/bin/systemctl",
      args: ["--user", ...args],
      timeoutMs: TIMEOUTS.detect,
      env: Object.fromEntries(
        Object.entries(options.env ?? {}).filter(
          ([name, value]) =>
            [
              "XDG_RUNTIME_DIR",
              "DBUS_SESSION_BUS_ADDRESS",
              "XDG_CONFIG_HOME",
            ].includes(name) && value !== undefined,
        ),
      ) as Record<string, string>,
    });

  const requireManager = async (): Promise<void> => {
    if (options.env?.XDG_RUNTIME_DIR?.startsWith("/") !== true) {
      throw new Error(
        "systemd --user needs an absolute XDG_RUNTIME_DIR and a running user manager. Run from a logged-in Linux session; WSL must have systemd enabled.",
      );
    }
    const result = await command(["is-system-running"]);
    if (
      result.startFailure !== undefined ||
      result.timedOut ||
      result.signal !== null ||
      result.truncated.stdout ||
      !["running", "degraded"].includes(result.stdout.trim())
    ) {
      throw new Error(
        `The systemd --user manager is unavailable: ${result.stderr.trim() || result.stdout.trim() || (result.startFailure ?? "systemctl could not start")}. Check the user session and systemd support.`,
      );
    }
  };

  const checked = async (
    args: readonly string[],
  ): ReturnType<ProcessRunner["run"]> => {
    const result = await command(args);
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.signal !== null ||
      result.startFailure !== undefined
    ) {
      throw new Error(
        `systemctl --user ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || (result.startFailure ?? (result.timedOut ? "timed out" : `exit status ${String(result.exitCode)}`))}`,
      );
    }
    return result;
  };

  const managerUnitDirectory = async (): Promise<string> => {
    // Query only paths through the same private-manager transport as validation.
    const paths = await checked(["show", "--property=UnitPath", "--value"]);
    const metadata = unitPaths(paths.stdout);
    const control = metadata.find(
      (path) => isAbsolute(path) && path.endsWith("/systemd/user.control"),
    );
    const directory = control?.slice(0, -".control".length);
    if (
      paths.truncated.stdout ||
      metadata.some((path) => path.includes("\0")) ||
      directory === undefined ||
      !metadata.includes(directory)
    )
      throw new Error(
        "systemctl did not return the systemd user manager's unit configuration path.",
      );
    return directory;
  };

  return {
    async install(config: SchedulerInstallConfig): Promise<void> {
      if (config.intervalSeconds !== 300)
        throw new Error(
          "The systemd user timer uses a fixed five-minute (300 second) cadence.",
        );
      await requireManager();
      const managerDirectory = await managerUnitDirectory();
      await mkdir(dirname(launcherPath), { recursive: true });
      await writeFile(launcherPath, renderLauncher(config), "utf8");
      await chmod(launcherPath, 0o755);
      await mkdir(unitDirectory, { recursive: true });
      await writeAtomic(servicePath, serviceDefinition(launcherPath), {
        mode: 0o644,
      });
      await writeAtomic(jobPath, timerDefinition, { mode: 0o644 });
      const sameDirectory =
        unitDirectory === managerDirectory ||
        (await realpath(unitDirectory).catch(() => undefined)) ===
          (await realpath(managerDirectory).catch(() => managerDirectory));
      if (!sameDirectory) {
        // link --force replaces symlinks, but cannot replace our old regular units.
        // Unlink only owned names; never delete the files their links point to.
        await rm(join(managerDirectory, service), { force: true });
        await rm(join(managerDirectory, timer), { force: true });
      }
      await checked(["daemon-reload"]);
      // The running manager may have a different XDG_CONFIG_HOME from this shell.
      await checked([
        "link",
        "--force",
        ...(sameDirectory
          ? [join(managerDirectory, service), join(managerDirectory, timer)]
          : [servicePath, jobPath]),
      ]);
      await checked(["enable", "--force", timer]);
      await checked(["restart", timer]);
    },
    async inspect() {
      await requireManager();
      const definitions = await Promise.all(
        [jobPath, servicePath].map((path) =>
          readFile(path, "utf8").then(
            (contents) => contents,
            (error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return undefined;
              throw error;
            },
          ),
        ),
      );
      const installed = definitions.every((contents) => contents !== undefined);
      const state = installed
        ? await checked([
            "show",
            timer,
            "--property=LoadState,ActiveState,UnitFileState",
          ])
        : undefined;
      // Verify only our definitions. Unknown overrides are diagnostic data,
      // never files to read or delete. A loaded unit alone proves no cadence.
      const verified =
        installed &&
        (
          await Promise.all(
            [
              { unit: timer, path: jobPath },
              { unit: service, path: servicePath },
            ].map(async ({ unit, path }) => {
              const metadata = await checked([
                "show",
                unit,
                "--all",
                "--property=FragmentPath,DropInPaths,NeedDaemonReload",
              ]);
              const lines = metadata.stdout.split("\n");
              const expectedPath = await realpath(path);
              const fragments = lines.filter((line) =>
                line.startsWith("FragmentPath="),
              );
              const fragment = fragments[0]?.slice("FragmentPath=".length);
              // Native v255 may report a manager-side link or lexical parent alias.
              return (
                !metadata.truncated.stdout &&
                fragments.length === 1 &&
                fragment !== undefined &&
                isAbsolute(fragment) &&
                // eslint-disable-next-line no-control-regex -- Reject malformed native path metadata.
                !/[\u0000-\u001f\u007f]/.test(fragment) &&
                (await realpath(fragment).catch(() => undefined)) ===
                  expectedPath &&
                lines.includes("DropInPaths=") &&
                lines.includes("NeedDaemonReload=no")
              );
            }),
          )
        ).every(Boolean);
      const definitionDrift =
        installed &&
        (!verified ||
          definitions[0] !== timerDefinition ||
          definitions[1] !== serviceDefinition(launcherPath));
      return {
        installed,
        definitionDrift,
        loaded:
          state !== undefined &&
          [
            "LoadState=loaded",
            "ActiveState=active",
            "UnitFileState=enabled",
          ].every((line) => state.stdout.split("\n").includes(line)),
        ...(installed
          ? await inspectLauncher(launcherPath)
          : { stalePath: false }),
        jobPath,
        launcherPath,
        ...(installed && !definitionDrift ? { intervalSeconds: 300 } : {}),
      };
    },
    async uninstall(): Promise<void> {
      await requireManager();
      const timerState = await checked(["show", timer, "--property=LoadState"]);
      const hasTimer = timerState.stdout
        .split("\n")
        .includes("LoadState=loaded");
      if (hasTimer) await checked(["stop", timer]);
      const serviceState = await checked([
        "show",
        service,
        "--property=LoadState",
      ]);
      const hasService = serviceState.stdout
        .split("\n")
        .includes("LoadState=loaded");
      if (hasService) await checked(["stop", service]);
      if (hasTimer) await checked(["clean", "--what=state", timer]);
      // Keep links until clean has found the stopped persistent timer.
      const directory = await managerUnitDirectory();
      const missing: string[] = [];
      for (const { unit, state } of [
        { unit: timer, state: timerState },
        { unit: service, state: serviceState },
      ]) {
        const lines = state.stdout.split("\n");
        const absent = await stat(join(directory, unit)).then(
          () => false,
          (error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
            throw error;
          },
        );
        if (
          !state.truncated.stdout &&
          (lines.includes("LoadState=not-found") ||
            (lines.includes("LoadState=loaded") && absent))
        )
          missing.push(unit);
      }
      if (missing.length > 0) {
        // v255 refuses disable for missing definitions. Remove only dangling
        // owned links in the validated manager root, never their referents.
        for (const unit of missing) {
          const names =
            unit === timer ? [unit, `timers.target.wants/${unit}`] : [unit];
          for (const name of names) {
            const path = join(directory, name);
            const link = await lstat(path).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return undefined;
              throw error;
            });
            if (!link?.isSymbolicLink()) continue;
            const dangling = await stat(path).then(
              () => false,
              (error: unknown) => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT")
                  return true;
                throw error;
              },
            );
            if (dangling) await rm(path);
          }
        }
      }
      const disable = [timer, service].filter(
        (unit) => !missing.includes(unit),
      );
      if (disable.length > 0) await checked(["disable", ...disable]);
      await rm(jobPath, { force: true });
      await rm(servicePath, { force: true });
      await rm(launcherPath, { force: true });
      await checked(["daemon-reload"]);
    },
  };
}
