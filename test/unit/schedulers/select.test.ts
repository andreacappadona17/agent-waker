/**
 * The seam, exercised through the gate.
 *
 * These treat the scheduler only as a `SchedulerDriver`: they install through
 * the interface, inspect it, and remove it, never reaching for anything
 * launchd-specific. That is the contract a second platform's driver has to
 * satisfy, so it is tested here against the one driver that exists rather than
 * against `createLaunchdScheduler` directly.
 */

import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProcessResult, ProcessRunner } from "#src/process/runner.js";
import type { SchedulerInstallConfig } from "#src/schedulers/contract.js";
import { LAUNCHER_NAME } from "#src/schedulers/launchd.js";
import {
  createScheduler,
  UnsupportedSchedulerError,
} from "#src/schedulers/select.js";

const ok = (): ProcessResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  signal: null,
  timedOut: false,
  truncated: { stdout: false, stderr: false },
  durationMs: 5,
});

/** Says yes to launchctl and plutil; stateless, so one is shared. */
const runner: ProcessRunner = { run: () => Promise.resolve(ok()) };

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
  it("gives macOS a driver that installs, composes the launcher path, and uninstalls", async () => {
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
    // The launcher path is composed by the gate from launcherDir; the rest of
    // the status shape is the launchd driver's own, covered next door.
    expect(installed.launcherPath).toBe(launcher);

    await driver.uninstall();
    expect(await exists(launcher)).toBe(false);
    expect((await driver.inspect()).installed).toBe(false);
  });

  it("refuses a platform no build supports", () => {
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
