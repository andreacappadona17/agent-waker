/**
 * The seam, exercised through the gate.
 *
 * These treat the scheduler only as a `SchedulerDriver`: they install through
 * the interface, inspect it, and remove it, never reaching for anything
 * launchd-specific. That is the contract a second platform's driver has to
 * satisfy, so it is tested here against the one driver that exists rather than
 * against `createLaunchdScheduler` directly.
 */

import { access } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ProcessResult,
  ProcessRunner,
  ProcessSpec,
} from "#src/process/runner.js";
import type { SchedulerInstallConfig } from "#src/schedulers/contract.js";
import { LAUNCHER_NAME } from "#src/schedulers/launchd.js";
import {
  createScheduler,
  UnsupportedSchedulerError,
} from "#src/schedulers/select.js";

const ok = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  signal: null,
  timedOut: false,
  truncated: { stdout: false, stderr: false },
  durationMs: 5,
  ...overrides,
});

/** A runner that says yes to launchctl and plutil, and records the calls. */
const recording = (): { runner: ProcessRunner; specs: ProcessSpec[] } => {
  const specs: ProcessSpec[] = [];

  return {
    specs,
    runner: {
      run(spec: ProcessSpec): Promise<ProcessResult> {
        specs.push(spec);
        return Promise.resolve(ok());
      },
    },
  };
};

const config: SchedulerInstallConfig = {
  nodePath: "/opt/node/bin/node",
  entrypoint: "/opt/agent-waker/dist/cli.js",
  intervalSeconds: 60,
  logDirectory: "/var/log/agent-waker",
};

let home: string;
let launcherDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agent-waker-select-"));
  launcherDir = join(home, "state", "agent-waker");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe("createScheduler", () => {
  it("gives macOS a driver that installs, reports, and uninstalls", async () => {
    const { runner } = recording();
    const driver = createScheduler({
      platform: "darwin",
      runner,
      home,
      uid: 501,
      launcherDir,
    });
    const launcher = join(launcherDir, LAUNCHER_NAME);

    await driver.install(config);
    expect(await exists(launcher)).toBe(true);

    const installed = await driver.inspect();
    expect(installed.installed).toBe(true);
    expect(installed.loaded).toBe(true);
    expect(installed.stalePath).toBe(false);
    expect(installed.launcherPath).toBe(launcher);
    expect(installed.intervalSeconds).toBe(60);

    await driver.uninstall();
    expect(await exists(launcher)).toBe(false);
    expect((await driver.inspect()).installed).toBe(false);
  });

  it("wires the launcher under the directory it was given", async () => {
    const { runner } = recording();
    const driver = createScheduler({
      platform: "darwin",
      runner,
      home,
      uid: 501,
      launcherDir,
    });

    expect((await driver.inspect()).launcherPath).toBe(
      join(launcherDir, LAUNCHER_NAME),
    );
  });

  it("refuses a platform no build supports", () => {
    const { runner } = recording();
    const build = (): unknown =>
      createScheduler({
        platform: "linux",
        runner,
        home,
        uid: 1000,
        launcherDir,
      });

    expect(build).toThrow(UnsupportedSchedulerError);
    expect(build).toThrow("linux");
  });
});
