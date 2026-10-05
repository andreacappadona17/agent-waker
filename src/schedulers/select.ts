/**
 * The single platform gate: which scheduler driver this machine gets.
 *
 * The router refuses an unsupported platform before a command ever reaches
 * here, so this is where a supported one becomes a concrete driver — launchd
 * on macOS, systemd on Linux — and the one place that has to learn a new
 * platform's name. Core stays platform-agnostic: it asks for a driver and gets
 * one.
 */

import { join } from "node:path";

import type { ProcessRunner } from "#src/process/runner.js";
import type { SchedulerDriver } from "#src/schedulers/contract.js";
import {
  createLaunchdScheduler,
  LAUNCHER_NAME,
} from "#src/schedulers/launchd.js";
import { createSystemdUserScheduler } from "#src/schedulers/systemd-user.js";

export interface SchedulerOptions {
  /** `process.platform`; the one thing that decides the driver. */
  readonly platform: string;
  readonly runner: ProcessRunner;
  /** Only for the LaunchAgents directory, which macOS fixes at ~/Library. */
  readonly home: string;
  readonly uid: number;
  /** The directory this program owns for the launcher script. */
  readonly launcherDir: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Raised when asked for a driver on a platform no build supports. */
export class UnsupportedSchedulerError extends Error {
  readonly platform: string;

  constructor(platform: string) {
    super(`No scheduler driver for platform ${platform}.`);
    this.name = "UnsupportedSchedulerError";
    this.platform = platform;
  }
}

/** Picks the scheduler driver for this platform. */
export function createScheduler(options: SchedulerOptions): SchedulerDriver {
  if (options.platform === "darwin") {
    return createLaunchdScheduler({
      runner: options.runner,
      home: options.home,
      uid: options.uid,
      launcherPath: join(options.launcherDir, LAUNCHER_NAME),
    });
  }

  if (options.platform === "linux") {
    const configured = options.env?.XDG_CONFIG_HOME;
    const configHome =
      configured?.startsWith("/") === true
        ? configured
        : join(options.home, ".config");
    return createSystemdUserScheduler({
      runner: options.runner,
      unitDirectory: join(configHome, "systemd", "user"),
      launcherPath: join(options.launcherDir, LAUNCHER_NAME),
      env: { ...options.env, XDG_CONFIG_HOME: configHome },
    });
  }

  throw new UnsupportedSchedulerError(options.platform);
}
