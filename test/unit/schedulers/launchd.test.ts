import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createLaunchdScheduler,
  DEFAULT_LABEL,
  renderLauncher,
  renderPlist,
} from "#src/schedulers/launchd.js";
import type {
  ProcessResult,
  ProcessRunner,
  ProcessSpec,
} from "#src/process/runner.js";

const run = promisify(execFile);

/** Present on macOS, absent on the Linux half of the CI matrix. */
const PLUTIL = "/usr/bin/plutil";

interface ShellFailure {
  code: number;
  stderr: string;
}

/** Runs a script that is expected to refuse, and returns how it refused. */
const failed = async (path: string): Promise<ShellFailure> =>
  run("/bin/sh", [path]).then(
    () => {
      throw new Error("expected the launcher to exit non-zero");
    },
    (error: unknown) => error as ShellFailure,
  );

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agent-waker-launchd-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

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

/** Records what was run, and answers from a per-command script. */
const recording = (
  answers: (spec: ProcessSpec) => ProcessResult = () => ok(),
): { runner: ProcessRunner; specs: ProcessSpec[] } => {
  const specs: ProcessSpec[] = [];

  return {
    specs,
    runner: {
      run(spec: ProcessSpec): Promise<ProcessResult> {
        specs.push(spec);
        return Promise.resolve(answers(spec));
      },
    },
  };
};

const installConfig = {
  nodePath: "/opt/node/bin/node",
  entrypoint: "/opt/agent-waker/dist/cli.js",
  intervalSeconds: 60,
  logDirectory: "/var/log/agent-waker",
};

const plistPath = (): string =>
  join(home, "Library", "LaunchAgents", `${DEFAULT_LABEL}.plist`);
const launcherPath = (): string =>
  join(home, "somewhere", "else", "agent-waker-runner");

describe("renderPlist", () => {
  const plist = renderPlist({
    label: DEFAULT_LABEL,
    programArguments: ["/stable/launcher", "tick"],
    intervalSeconds: 60,
    logDirectory: "/tmp/logs",
  });

  it.skipIf(!existsSync(PLUTIL))(
    "is a property list macOS itself accepts",
    async () => {
      // Generated XML that only we can parse is a plist that fails at load
      // time, in the background, on somebody else's machine.
      const path = join(home, "check.plist");

      await writeFile(path, plist, "utf8");
      await expect(run(PLUTIL, ["-lint", path])).resolves.toBeDefined();
    },
  );

  it("names the job and what to run", () => {
    expect(plist).toContain(`<string>${DEFAULT_LABEL}</string>`);
    expect(plist).toContain("<string>/stable/launcher</string>");
    expect(plist).toContain("<string>tick</string>");
  });

  it("wakes on the configured interval", () => {
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>60</integer>");
  });

  it("also runs at load, so a fresh install does not wait", () => {
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it("sends output somewhere the user can find it", () => {
    expect(plist).toContain("/tmp/logs/launchd.out.log");
    expect(plist).toContain("/tmp/logs/launchd.err.log");
  });

  it("escapes a path that would otherwise break the XML", async () => {
    // "Tom & Jerry" is a legal directory name and an illegal XML fragment.
    const awkward = renderPlist({
      label: DEFAULT_LABEL,
      programArguments: ["/Users/Tom & Jerry/bin/run", "tick"],
      intervalSeconds: 60,
      logDirectory: "/tmp/<logs>",
    });

    expect(awkward).toContain("Tom &amp; Jerry");
    expect(awkward).not.toContain("Tom & Jerry");

    const path = join(home, "awkward.plist");

    await writeFile(path, awkward, "utf8");

    if (existsSync(PLUTIL)) {
      await expect(run(PLUTIL, ["-lint", path])).resolves.toBeDefined();
    }
  });
});

describe("renderLauncher", () => {
  const launcher = renderLauncher(installConfig);

  it("runs the recorded interpreter and entrypoint directly", () => {
    expect(launcher).toContain("/opt/node/bin/node");
    expect(launcher).toContain("/opt/agent-waker/dist/cli.js");
    expect(launcher).toContain("exec ");
  });

  it("does not depend on an interactive shell", () => {
    // launchd gives a job no profile, no rc file and no user PATH.
    expect(launcher.startsWith("#!/bin/sh\n")).toBe(true);
    expect(launcher).not.toMatch(/source |\. ~\/\.|bash_profile|zshrc/);
  });

  it("checks both recorded paths before running anything", () => {
    // A Node upgrade moves the interpreter out from under an nvm install.
    expect(launcher).toContain('[ ! -x "$NODE" ]');
    expect(launcher).toContain('[ ! -f "$ENTRY" ]');
  });

  it("is a script /bin/sh actually accepts", async () => {
    const path = join(home, "runner");

    await writeFile(path, launcher, "utf8");
    await expect(run("/bin/sh", ["-n", path])).resolves.toBeDefined();
  });

  it("names the missing path instead of failing silently", async () => {
    // The job runs every minute with nobody watching, so the one line it
    // leaves behind has to be enough to act on.
    const path = join(home, "runner-stale");
    const missing = join(home, "absent-node");

    await writeFile(
      path,
      renderLauncher({ ...installConfig, nodePath: missing }),
      "utf8",
    );

    // EX_CONFIG: the configuration is wrong, not the provider.
    const failure = await failed(path);

    expect(failure.code).toBe(78);
    expect(failure.stderr).toContain(missing);
  });

  it("reports a missing entry point separately from a missing interpreter", async () => {
    const path = join(home, "runner-no-entry");
    const missing = join(home, "absent-entry.js");

    await writeFile(
      path,
      renderLauncher({
        ...installConfig,
        nodePath: "/bin/sh",
        entrypoint: missing,
      }),
      "utf8",
    );

    const failure = await failed(path);

    expect(failure.code).toBe(78);
    expect(failure.stderr).toContain("entry point");
  });
});

describe("install", () => {
  it("writes the launcher and the plist, then loads the job", async () => {
    const { runner, specs } = recording();

    await createLaunchdScheduler({
      runner,
      home,
      uid: 501,
      launcherPath: launcherPath(),
    }).install(installConfig);

    expect(await readFile(launcherPath(), "utf8")).toContain(
      "/opt/node/bin/node",
    );
    expect(await readFile(plistPath(), "utf8")).toContain(DEFAULT_LABEL);

    const commands = specs.map((spec) => spec.args.join(" "));

    expect(commands.some((command) => command.startsWith("-lint"))).toBe(true);
    expect(commands.some((command) => command.includes("bootstrap"))).toBe(
      true,
    );
  });

  it("makes the launcher executable and the plist not", async () => {
    const { runner } = recording();

    await createLaunchdScheduler({
      runner,
      home,
      uid: 501,
      launcherPath: launcherPath(),
    }).install(installConfig);

    expect((await stat(launcherPath())).mode & 0o777).toBe(0o755);
    expect((await stat(plistPath())).mode & 0o777).toBe(0o644);
  });

  it("writes the launcher where it was told to, not where it guessed", async () => {
    // It follows the same XDG resolution as everything else this program owns;
    // deriving it from the home directory ignored XDG_DATA_HOME entirely.
    const { runner } = recording();

    await createLaunchdScheduler({
      runner,
      home,
      uid: 501,
      launcherPath: launcherPath(),
    }).install(installConfig);

    expect(await readFile(launcherPath(), "utf8")).toContain("exec ");
  });

  it("points launchd at the stable launcher, never at Node directly", async () => {
    // Embedding an nvm path in a plist is how this breaks six weeks later.
    const { runner } = recording();

    await createLaunchdScheduler({
      runner,
      home,
      uid: 501,
      launcherPath: launcherPath(),
    }).install(installConfig);

    const plist = await readFile(plistPath(), "utf8");

    expect(plist).toContain(launcherPath());
    expect(plist).not.toContain("/opt/node/bin/node");
  });

  it("unloads any previous job before loading the new one", async () => {
    const { runner, specs } = recording();

    await createLaunchdScheduler({
      runner,
      home,
      uid: 501,
      launcherPath: launcherPath(),
    }).install(installConfig);

    const commands = specs.map((spec) => spec.args.join(" "));
    const bootout = commands.findIndex((command) =>
      command.includes("bootout"),
    );
    const bootstrap = commands.findIndex((command) =>
      command.includes("bootstrap"),
    );

    expect(bootout).toBeGreaterThanOrEqual(0);
    expect(bootout).toBeLessThan(bootstrap);
  });

  it("can be run twice without complaint", async () => {
    // The second run is the update path, and updates must not need an uninstall.
    const { runner } = recording();
    const scheduler = createLaunchdScheduler({
      runner,
      home,
      uid: 501,
      launcherPath: launcherPath(),
    });

    await scheduler.install(installConfig);
    await scheduler.install({ ...installConfig, intervalSeconds: 120 });

    expect(await readFile(plistPath(), "utf8")).toContain(
      "<integer>120</integer>",
    );
  });

  it("refuses to load a plist macOS will not parse", async () => {
    // Better to fail the install than to leave a job that never runs.
    const { runner, specs } = recording((spec) =>
      spec.args[0] === "-lint"
        ? ok({ exitCode: 1, stdout: "malformed" })
        : ok(),
    );

    await expect(
      createLaunchdScheduler({
        runner,
        home,
        uid: 501,
        launcherPath: launcherPath(),
      }).install(installConfig),
    ).rejects.toThrow(/plist/i);

    expect(
      specs.some((spec) => spec.args.join(" ").includes("bootstrap")),
    ).toBe(false);
  });

  it("reports a launchctl refusal instead of claiming success", async () => {
    const { runner } = recording((spec) =>
      spec.args.includes("bootstrap")
        ? ok({ exitCode: 5, stderr: "Load failed: 5: Input/output error" })
        : ok(),
    );

    await expect(
      createLaunchdScheduler({
        runner,
        home,
        uid: 501,
        launcherPath: launcherPath(),
      }).install(installConfig),
    ).rejects.toThrow(/launchctl/i);
  });
});

describe("inspect", () => {
  it("reports nothing installed on a clean machine", async () => {
    const { runner } = recording();

    expect(
      await createLaunchdScheduler({
        runner,
        home,
        uid: 501,
        launcherPath: launcherPath(),
      }).inspect(),
    ).toMatchObject({ installed: false, loaded: false });
  });

  it("reports an installed and loaded job", async () => {
    const { runner } = recording();
    const scheduler = createLaunchdScheduler({
      runner,
      home,
      uid: 501,
      launcherPath: launcherPath(),
    });

    await scheduler.install(installConfig);
    await mkdir(join(home, "opt"), { recursive: true });

    expect(await scheduler.inspect()).toMatchObject({
      installed: true,
      loaded: true,
      intervalSeconds: 60,
    });
  });

  it("reports a job launchd does not know about", async () => {
    const { runner } = recording((spec) =>
      spec.args.includes("print") ? ok({ exitCode: 113 }) : ok(),
    );
    const scheduler = createLaunchdScheduler({
      runner,
      home,
      uid: 501,
      launcherPath: launcherPath(),
    });

    await scheduler.install(installConfig);

    expect(await scheduler.inspect()).toMatchObject({
      installed: true,
      loaded: false,
    });
  });

  it("notices when the launcher the plist names has been removed", async () => {
    // The uninstall that only removed half of itself, or a cleaned-up home.
    const { runner } = recording();
    const scheduler = createLaunchdScheduler({
      runner,
      home,
      uid: 501,
      launcherPath: launcherPath(),
    });

    await scheduler.install(installConfig);
    await rm(launcherPath());

    expect(await scheduler.inspect()).toMatchObject({ stalePath: true });
  });

  it("does not call a working install stale", async () => {
    const { runner } = recording();
    const scheduler = createLaunchdScheduler({
      runner,
      home,
      uid: 501,
      launcherPath: launcherPath(),
    });

    await scheduler.install(installConfig);

    expect((await scheduler.inspect()).stalePath).toBe(false);
  });
});

describe("uninstall", () => {
  it("unloads the job and removes what it wrote", async () => {
    const { runner, specs } = recording();
    const scheduler = createLaunchdScheduler({
      runner,
      home,
      uid: 501,
      launcherPath: launcherPath(),
    });

    await scheduler.install(installConfig);
    await scheduler.uninstall();

    expect(specs.some((spec) => spec.args.join(" ").includes("bootout"))).toBe(
      true,
    );
    await expect(readFile(plistPath(), "utf8")).rejects.toThrow();
    await expect(readFile(launcherPath(), "utf8")).rejects.toThrow();
  });

  it("reports a job it could not unload, having removed the files anyway", async () => {
    // Leaving a loaded job with no plist behind it is not something to discover
    // at the next reboot.
    let installed = false;
    const { runner } = recording((spec) =>
      installed && spec.args.includes("bootout")
        ? ok({
            exitCode: 1,
            stderr: "Boot-out failed: 1: Operation not permitted",
          })
        : ok(),
    );
    const scheduler = createLaunchdScheduler({
      runner,
      home,
      uid: 501,
      launcherPath: launcherPath(),
    });

    await scheduler.install(installConfig);
    installed = true;

    await expect(scheduler.uninstall()).rejects.toThrow(/could not unload/);
    await expect(readFile(plistPath(), "utf8")).rejects.toThrow();
  });

  it("is quiet when there is nothing to remove", async () => {
    const { runner } = recording(() => ok({ exitCode: 113 }));

    await expect(
      createLaunchdScheduler({
        runner,
        home,
        uid: 501,
        launcherPath: launcherPath(),
      }).uninstall(),
    ).resolves.toBeUndefined();
  });
});

it("preserves configured XDG directories in a clean scheduler environment", async () => {
  const xdg = {
    XDG_CONFIG_HOME: join(home, "config's space"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
  };
  const entry = join(home, "environment.mjs");
  const launcher = join(home, "runner");
  await writeFile(
    entry,
    `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(xdg))}.map(k => [k, process.env[k]]))))`,
  );
  await writeFile(
    launcher,
    renderLauncher({
      ...installConfig,
      nodePath: process.execPath,
      entrypoint: entry,
      xdg,
    }),
  );
  const { stdout } = await run("/bin/sh", [launcher], {
    env: { HOME: home, PATH: "/usr/bin:/bin" },
  });
  expect(JSON.parse(stdout)).toEqual(xdg);
});
