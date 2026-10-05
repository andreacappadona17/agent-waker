import {
  access,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  ProcessResult,
  ProcessRunner,
  ProcessSpec,
} from "#src/process/runner.js";
import { createSystemdUserScheduler } from "#src/schedulers/systemd-user.js";
import {
  createSystemdUserManager,
  systemdUnitPathOutput,
} from "../../support/systemd-user-manager.js";

const exec = promisify(execFile);
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agent-waker-systemd-"));
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
  durationMs: 1,
  ...overrides,
});

it("refreshes a timer already active in the user manager when reinstalling", async () => {
  let activeTimer = "";
  const runner: ProcessRunner = {
    async run(spec) {
      if (spec.args.includes("--property=UnitPath")) return managerPaths();
      if (spec.args.includes("is-system-running"))
        return ok({ stdout: "degraded\n", exitCode: 1 });
      if (
        spec.args.includes("restart") ||
        (spec.args.includes("enable") && activeTimer === "")
      )
        activeTimer = await readFile(timerPath(), "utf8");
      return Promise.resolve(ok());
    },
  };
  const driver = scheduler(runner);
  await driver.install(config());
  activeTimer = "OnCalendar=minutely\n";
  await driver.install(config());
  expect(activeTimer).toContain("OnCalendar=*-*-* *:0/5:00");
  expect(activeTimer).toContain("Persistent=true");
  expect(activeTimer).not.toContain("OnCalendar=minutely");
});
const config = () => ({
  nodePath: process.execPath,
  entrypoint: join(home, "entry.js"),
  intervalSeconds: 300,
  logDirectory: join(home, "logs"),
});
const managerPaths = (): ProcessResult =>
  ok({
    stdout: systemdUnitPathOutput([
      `${unitDirectory()}.control`,
      unitDirectory(),
    ]),
  });
const unitDirectory = () => join(home, ".config", "systemd", "user");
const timerPath = () => join(unitDirectory(), "agent-waker.timer");
const launcherPath = () => join(home, "data", "agent-waker-runner");
const scheduler = (
  runner: ProcessRunner,
  env: Readonly<Record<string, string | undefined>> = {
    XDG_RUNTIME_DIR: join(home, "runtime"),
  },
) =>
  createSystemdUserScheduler({
    runner,
    unitDirectory: unitDirectory(),
    launcherPath: launcherPath(),
    env,
  });

function recording(
  answer: (spec: ProcessSpec) => ProcessResult = (spec) =>
    ok({
      stdout: spec.args.includes("is-system-running")
        ? "running\n"
        : "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n",
    }),
) {
  const specs: ProcessSpec[] = [];
  return {
    specs,
    runner: {
      run: (spec: ProcessSpec) => {
        specs.push(spec);
        if (spec.args.includes("--property=UnitPath"))
          return Promise.resolve(managerPaths());
        return Promise.resolve(answer(spec));
      },
    },
  };
}

it.each(["linked custom root", "manager lexical alias"])(
  "verifies the native fragment identity after install and repair with a %s",
  async (layout) => {
    await writeFile(config().entrypoint, "");
    const root = join(home, "manager");
    await mkdir(join(root, "systemd", "user"), { recursive: true });
    const alias = join(home, "manager-alias");
    await symlink(root, alias);
    const managerDirectory = join(
      layout === "manager lexical alias" ? alias : root,
      "systemd",
      "user",
    );
    const ownedDirectory =
      layout === "manager lexical alias"
        ? join(root, "systemd", "user")
        : unitDirectory();
    const driver = createSystemdUserScheduler({
      runner: createSystemdUserManager(managerDirectory),
      unitDirectory: ownedDirectory,
      launcherPath: launcherPath(),
      env: { XDG_RUNTIME_DIR: join(home, "runtime") },
    });
    for (const phase of ["install", "repair"]) {
      await driver.install(config());
      expect.soft(await driver.inspect(), phase).toMatchObject({
        installed: true,
        loaded: true,
        stalePath: false,
        definitionDrift: false,
        intervalSeconds: 300,
      });
    }
  },
);

it("installs, repairs, and removes units through an alias of the manager directory", async () => {
  await writeFile(config().entrypoint, "");
  const managerRoot = join(home, "real");
  const managerDirectory = join(managerRoot, "systemd", "user");
  await mkdir(managerDirectory, { recursive: true });
  const alias = join(home, "alias");
  await symlink(managerRoot, alias);
  const driver = createSystemdUserScheduler({
    runner: createSystemdUserManager(managerDirectory),
    unitDirectory: join(alias, "systemd", "user"),
    launcherPath: launcherPath(),
    env: { XDG_RUNTIME_DIR: join(home, "runtime") },
  });
  await expect(driver.install(config())).resolves.toBeUndefined();
  await expect(driver.install(config())).resolves.toBeUndefined();
  expect(await driver.inspect()).toMatchObject({
    installed: true,
    loaded: true,
    stalePath: false,
  });
  await driver.uninstall();
  expect(await driver.inspect()).toMatchObject({
    installed: false,
    loaded: false,
  });
  await expect(
    lstat(join(managerDirectory, "agent-waker.timer")),
  ).rejects.toThrow();
  await expect(
    lstat(join(managerDirectory, "timers.target.wants", "agent-waker.timer")),
  ).rejects.toThrow();
});

it("installs and repairs through the validated manager while the session bus has no systemd service", async () => {
  await writeFile(config().entrypoint, "");
  const manager = createSystemdUserManager(unitDirectory());
  const alternateBus = "unix:path=/alternate/session/bus";
  const runner: ProcessRunner = {
    run: (spec) =>
      spec.executable === "/usr/bin/busctl" &&
      spec.env?.DBUS_SESSION_BUS_ADDRESS === alternateBus
        ? Promise.resolve(
            ok({
              exitCode: 1,
              stderr:
                "The name org.freedesktop.systemd1 was not provided by any .service files",
            }),
          )
        : manager.run(spec),
  };
  const driver = scheduler(runner, {
    XDG_RUNTIME_DIR: join(home, "runtime"),
    DBUS_SESSION_BUS_ADDRESS: alternateBus,
  });
  await expect(driver.install(config())).resolves.toBeUndefined();
  await expect(driver.install(config())).resolves.toBeUndefined();
  expect(await driver.inspect()).toMatchObject({
    installed: true,
    loaded: true,
    stalePath: false,
  });
  await driver.uninstall();
});

it("retains literal manager paths from native v255 quoting examples", async () => {
  await writeFile(config().entrypoint, "");
  // Fixed expected strings from systemd v255 src/test/test-escape.c; not our formatter.
  const suffix =
    'foo "bar" waldo/foo$bar/a\nb\x01/głąb\x02\x03rząd/systemd/user';
  const nativeSuffix = String.raw`foo \"bar\" waldo/foo\$bar/a\nb\001/głąb\002\003rząd/systemd/user`;
  const managerDirectory = join(home, suffix);
  const manager = createSystemdUserManager(managerDirectory);
  const runner: ProcessRunner = {
    run: (spec) =>
      spec.args.includes("--property=UnitPath")
        ? Promise.resolve(
            ok({
              stdout: `"${home}/${nativeSuffix}.control" "${home}/${nativeSuffix}" /etc/systemd/user /usr/lib/systemd/user\n`,
            }),
          )
        : manager.run(spec),
  };
  const driver = scheduler(runner);
  await expect(driver.install(config())).resolves.toBeUndefined();
  expect(await driver.inspect()).toMatchObject({
    installed: true,
    loaded: true,
    stalePath: false,
  });
  expect(await realpath(join(managerDirectory, "agent-waker.timer"))).toBe(
    await realpath(timerPath()),
  );
  await driver.uninstall();
});

it.each(["\u00a0", "\u2003"])(
  "installs and repairs native bare manager paths containing %j",
  async (space) => {
    await writeFile(config().entrypoint, "");
    const directory = join(home, `config${space}root`, "systemd", "user");
    const manager = createSystemdUserManager(directory);
    const driver = scheduler({
      run: (spec) =>
        spec.args.includes("--property=UnitPath")
          ? Promise.resolve(
              ok({
                // Native v255 WHITESPACE is ASCII; these UTF-8 paths are bare.
                stdout: `${directory}.control ${directory} /etc/systemd/user\n`,
              }),
            )
          : manager.run(spec),
    });
    await driver.install(config());
    await driver.install(config());
    expect(await driver.inspect()).toMatchObject({
      installed: true,
      loaded: true,
    });
    await driver.uninstall();
  },
);

it("reports a daily timer as configuration drift without inventing a five-minute cadence", async () => {
  await writeFile(config().entrypoint, "");
  const driver = scheduler(createSystemdUserManager(unitDirectory()));
  await driver.install(config());
  await writeFile(timerPath(), "[Timer]\nOnCalendar=daily\nPersistent=true\n");
  const status = await driver.inspect();
  expect(status).toMatchObject({
    installed: true,
    loaded: true,
    stalePath: false,
    definitionDrift: true,
  });
  expect(status.intervalSeconds).toBeUndefined();
  await driver.install(config());
  expect(await driver.inspect()).toMatchObject({
    definitionDrift: false,
    intervalSeconds: 300,
  });
});

it.each([
  {
    name: "timer drop-in",
    unit: "agent-waker.timer",
    metadata:
      "DropInPaths=/etc/systemd/user/agent-waker.timer.d/override.conf\nNeedDaemonReload=no\n",
  },
  {
    name: "service drop-in",
    unit: "agent-waker.service",
    metadata:
      "DropInPaths=/run/user/1000/systemd/user/agent-waker.service.d/override.conf\nNeedDaemonReload=no\n",
  },
  {
    name: "pending manager reload",
    unit: "agent-waker.timer",
    metadata: "DropInPaths=\nNeedDaemonReload=yes\n",
  },
  {
    name: "different manager fragment",
    unit: "agent-waker.service",
    metadata:
      "FragmentPath=/etc/systemd/user/agent-waker.service\nDropInPaths=\nNeedDaemonReload=no\n",
  },
  {
    name: "unavailable reload metadata",
    unit: "agent-waker.timer",
    metadata: "DropInPaths=\n",
  },
])(
  "does not claim a verified schedule with $name",
  async ({ unit, metadata }) => {
    await writeFile(config().entrypoint, "");
    const manager = createSystemdUserManager(unitDirectory());
    const driver = scheduler({
      async run(spec) {
        if (
          spec.args.includes(
            "--property=FragmentPath,DropInPaths,NeedDaemonReload",
          ) &&
          spec.args.includes(unit)
        )
          return ok({
            stdout: `${metadata.startsWith("FragmentPath=") ? "" : `FragmentPath=${join(unitDirectory(), unit)}\n`}${metadata}`,
          });
        return manager.run(spec);
      },
    });
    await driver.install(config());
    const status = await driver.inspect();
    expect(status).toMatchObject({
      installed: true,
      loaded: true,
      stalePath: false,
      definitionDrift: true,
    });
    expect(status.intervalSeconds).toBeUndefined();
  },
);

it.each([
  "missing",
  "unprintable",
  "relative",
  "control byte",
  "duplicate",
  "different existing target",
  "missing target",
] as const)(
  "keeps a %s FragmentPath unverified without reading metadata-selected contents",
  async (kind) => {
    await writeFile(config().entrypoint, "");
    const manager = createSystemdUserManager(unitDirectory());
    const fragment = {
      missing: "",
      unprintable: "FragmentPath=[unprintable]\n",
      relative: "FragmentPath=agent-waker.timer\n",
      "control byte": `FragmentPath=${timerPath()}\0\n`,
      duplicate: `FragmentPath=${timerPath()}\nFragmentPath=${timerPath()}\n`,
      // readFile(home) would throw EISDIR; metadata may identify, never select contents.
      "different existing target": `FragmentPath=${home}\n`,
      "missing target": `FragmentPath=${join(home, "absent.timer")}\n`,
    }[kind];
    const driver = scheduler({
      run: (spec) =>
        spec.args.includes(
          "--property=FragmentPath,DropInPaths,NeedDaemonReload",
        ) && spec.args.includes("agent-waker.timer")
          ? Promise.resolve(
              ok({
                stdout: `${fragment}DropInPaths=\nNeedDaemonReload=no\n`,
              }),
            )
          : manager.run(spec),
    });
    await driver.install(config());
    const status = await driver.inspect();
    expect(status).toMatchObject({
      installed: true,
      loaded: true,
      definitionDrift: true,
    });
    expect(status.intervalSeconds).toBeUndefined();
  },
);

it("preserves the working manager definitions if the replacement launcher parent is a file", async () => {
  await writeFile(config().entrypoint, "");
  const runner = createSystemdUserManager(unitDirectory());
  const original = scheduler(runner);
  await original.install(config());
  const names = ["agent-waker.service", "agent-waker.timer"];
  const contents = await Promise.all(
    names.map((name) => readFile(join(unitDirectory(), name), "utf8")),
  );
  const blocked = join(home, "blocked");
  await writeFile(blocked, "regular file");
  const replacement = createSystemdUserScheduler({
    runner,
    unitDirectory: join(home, "replacement", "systemd", "user"),
    launcherPath: join(blocked, "runner"),
    env: { XDG_RUNTIME_DIR: join(home, "runtime") },
  });
  await expect(replacement.install(config())).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(
    await Promise.all(
      names.map((name) => readFile(join(unitDirectory(), name), "utf8")),
    ),
  ).toEqual(contents);
  expect(await original.inspect()).toMatchObject({
    installed: true,
    loaded: true,
    stalePath: false,
  });
});

it.each(["agent-waker.service", "agent-waker.timer"])(
  "preserves the working manager definitions if preparing replacement %s fails",
  async (blockedUnit) => {
    await writeFile(config().entrypoint, "");
    const runner = createSystemdUserManager(unitDirectory());
    const original = scheduler(runner);
    await original.install(config());
    const names = ["agent-waker.service", "agent-waker.timer"];
    const contents = await Promise.all(
      names.map((name) => readFile(join(unitDirectory(), name), "utf8")),
    );
    const destination = join(home, "replacement", "systemd", "user");
    await mkdir(join(destination, blockedUnit), { recursive: true });
    const replacement = createSystemdUserScheduler({
      runner,
      unitDirectory: destination,
      launcherPath: join(home, "replacement", "runner"),
      env: { XDG_RUNTIME_DIR: join(home, "runtime") },
    });
    await expect(replacement.install(config())).rejects.toMatchObject({
      code: "EISDIR",
    });
    expect(
      await Promise.all(
        names.map((name) => readFile(join(unitDirectory(), name), "utf8")),
      ),
    ).toEqual(contents);
    expect(await original.inspect()).toMatchObject({
      installed: true,
      loaded: true,
      stalePath: false,
    });
  },
);

it("reinstalls custom units at the default root without modifying the old link targets", async () => {
  await writeFile(config().entrypoint, "");
  const customDirectory = join(home, "custom", "systemd", "user");
  const runner = createSystemdUserManager(unitDirectory());
  const custom = createSystemdUserScheduler({
    runner,
    unitDirectory: customDirectory,
    launcherPath: launcherPath(),
    env: { XDG_RUNTIME_DIR: join(home, "runtime") },
  });
  await custom.install(config());
  const oldTimer = join(customDirectory, "agent-waker.timer");
  await writeFile(oldTimer, "[Timer]\nOnCalendar=daily\n");
  const original = await readFile(oldTimer, "utf8");
  const driver = scheduler(runner);
  await expect(driver.install(config())).resolves.toBeUndefined();
  expect(await readFile(oldTimer, "utf8")).toBe(original);
  expect((await lstat(timerPath())).isFile()).toBe(true);
  expect(
    await realpath(
      join(unitDirectory(), "timers.target.wants", "agent-waker.timer"),
    ),
  ).toBe(await realpath(timerPath()));
  expect(await driver.inspect()).toMatchObject({
    installed: true,
    loaded: true,
    stalePath: false,
  });
  await driver.install(config());
  await driver.uninstall();
  await driver.uninstall();
  expect(await driver.inspect()).toMatchObject({
    installed: false,
    loaded: false,
  });
  await expect(
    lstat(join(unitDirectory(), "timers.target.wants", "agent-waker.timer")),
  ).rejects.toThrow();
  expect(await readFile(oldTimer, "utf8")).toBe(original);
});

it("relocates default units to a custom root and removes the new manager links on uninstall", async () => {
  await writeFile(config().entrypoint, "");
  const runner = createSystemdUserManager(unitDirectory());
  await scheduler(runner).install(config());
  const customDirectory = join(home, "custom", "systemd", "user");
  const driver = createSystemdUserScheduler({
    runner,
    unitDirectory: customDirectory,
    launcherPath: launcherPath(),
    env: { XDG_RUNTIME_DIR: join(home, "runtime") },
  });
  await expect(driver.install(config())).resolves.toBeUndefined();
  const customTimer = join(customDirectory, "agent-waker.timer");
  expect(await realpath(timerPath())).toBe(await realpath(customTimer));
  expect(
    await realpath(
      join(unitDirectory(), "timers.target.wants", "agent-waker.timer"),
    ),
  ).toBe(await realpath(customTimer));
  expect(await driver.inspect()).toMatchObject({
    installed: true,
    loaded: true,
    stalePath: false,
  });
  await driver.install(config());
  await driver.uninstall();
  await expect(lstat(timerPath())).rejects.toThrow();
  await expect(
    lstat(join(unitDirectory(), "agent-waker.service")),
  ).rejects.toThrow();
  expect(await driver.inspect()).toMatchObject({
    installed: false,
    loaded: false,
  });
});

it.each([
  { missing: ["agent-waker.service"] },
  { missing: ["agent-waker.timer"] },
  { missing: ["agent-waker.service", "agent-waker.timer"] },
])(
  "removes dangling owned links when external definitions are missing: $missing",
  async ({ missing }) => {
    await writeFile(config().entrypoint, "");
    const directory = join(home, "external", "systemd", "user");
    const driver = createSystemdUserScheduler({
      runner: createSystemdUserManager(unitDirectory()),
      unitDirectory: directory,
      launcherPath: launcherPath(),
      env: { XDG_RUNTIME_DIR: join(home, "runtime") },
    });
    await driver.install(config());
    await Promise.all(missing.map((name) => rm(join(directory, name))));
    await driver.uninstall();
    for (const name of [
      "agent-waker.service",
      "agent-waker.timer",
      "timers.target.wants/agent-waker.timer",
    ])
      await expect(lstat(join(unitDirectory(), name))).rejects.toThrow();
    await driver.uninstall();
    await driver.install(config());
    expect(await driver.inspect()).toMatchObject({
      installed: true,
      loaded: true,
      definitionDrift: false,
      intervalSeconds: 300,
    });
  },
);

it.each([false, true])(
  "removes missing external units idempotently on a v255 manager that refuses native disable (cached loaded state: %j)",
  async (retainLoadedUnits) => {
    await writeFile(config().entrypoint, "");
    const directory = join(home, "external", "systemd", "user");
    const driver = createSystemdUserScheduler({
      runner: createSystemdUserManager(unitDirectory(), {
        missingDisableFails: true,
        retainLoadedUnits,
      }),
      unitDirectory: directory,
      launcherPath: launcherPath(),
      env: { XDG_RUNTIME_DIR: join(home, "runtime") },
    });
    await driver.install(config());
    for (const name of ["agent-waker.service", "agent-waker.timer"])
      await rm(join(directory, name));
    await driver.uninstall();
    await driver.uninstall();
    for (const name of [
      "agent-waker.service",
      "agent-waker.timer",
      "timers.target.wants/agent-waker.timer",
    ])
      await expect(lstat(join(unitDirectory(), name))).rejects.toThrow();
    await driver.install(config());
    expect(await driver.inspect()).toMatchObject({
      loaded: true,
      definitionDrift: false,
    });
  },
);

it("relocates regular units from a manager's custom root without leaving conflicting definitions", async () => {
  await writeFile(config().entrypoint, "");
  const managerDirectory = join(
    home,
    "manager config \"with $ and quotes'",
    "systemd",
    "user",
  );
  const runner = createSystemdUserManager(managerDirectory);
  const original = createSystemdUserScheduler({
    runner,
    unitDirectory: managerDirectory,
    launcherPath: launcherPath(),
    env: { XDG_RUNTIME_DIR: join(home, "runtime") },
  });
  await original.install(config());
  const relocated = scheduler(runner);
  await expect(relocated.install(config())).resolves.toBeUndefined();
  expect(await realpath(join(managerDirectory, "agent-waker.timer"))).toBe(
    await realpath(timerPath()),
  );
  expect(
    await realpath(
      join(managerDirectory, "timers.target.wants", "agent-waker.timer"),
    ),
  ).toBe(await realpath(timerPath()));
  expect(await relocated.inspect()).toMatchObject({
    installed: true,
    loaded: true,
    stalePath: false,
  });
  await relocated.uninstall();
  await expect(
    lstat(join(managerDirectory, "agent-waker.timer")),
  ).rejects.toThrow();
  await expect(
    lstat(join(managerDirectory, "agent-waker.service")),
  ).rejects.toThrow();
  await expect(
    lstat(join(managerDirectory, "timers.target.wants", "agent-waker.timer")),
  ).rejects.toThrow();
});

it.each([
  {
    name: "missing metadata command",
    metadata: () => ok({ exitCode: null, startFailure: "not_found" }),
  },
  {
    name: "failed metadata command",
    metadata: () => ok({ exitCode: 1, stderr: "Failed to connect to bus" }),
  },
  {
    name: "invalid string array",
    metadata: () => ok({ stdout: '"unterminated' }),
  },
  {
    name: "unsupported escape",
    metadata: () =>
      ok({ stdout: `"${unitDirectory()}.control" "${unitDirectory()}\\q"` }),
  },
  {
    name: "unsupported POSIX quoting",
    metadata: () =>
      ok({ stdout: `$'${unitDirectory()}.control' $'${unitDirectory()}'` }),
  },
  {
    name: "embedded NUL",
    metadata: () =>
      ok({
        stdout: `${systemdUnitPathOutput([`${unitDirectory()}.control`, unitDirectory()]).trim()} "\\000"\n`,
      }),
  },
  {
    name: "extra metadata line",
    metadata: () => ok({ stdout: `${managerPaths().stdout}other output\n` }),
  },
  {
    name: "missing config path",
    metadata: () =>
      ok({
        stdout: systemdUnitPathOutput([`${unitDirectory()}.control`]),
      }),
  },
  {
    name: "truncated metadata",
    metadata: () => ({
      ...managerPaths(),
      truncated: { stdout: true, stderr: false },
    }),
  },
])(
  "refuses $name before replacing any existing scheduler artifacts",
  async ({ metadata }) => {
    await writeFile(config().entrypoint, "");
    const manager = createSystemdUserManager(unitDirectory());
    await scheduler(manager).install(config());
    const originalTimer = await readFile(timerPath(), "utf8");
    const originalService = await readFile(
      join(unitDirectory(), "agent-waker.service"),
      "utf8",
    );
    const originalLauncher = await readFile(launcherPath(), "utf8");
    const driver = scheduler({
      run: (spec) =>
        spec.args.includes("--property=UnitPath")
          ? Promise.resolve(metadata())
          : manager.run(spec),
    });
    await expect(
      driver.install({ ...config(), entrypoint: join(home, "replacement.js") }),
    ).rejects.toThrow(/systemctl/);
    expect(await readFile(timerPath(), "utf8")).toBe(originalTimer);
    expect(
      await readFile(join(unitDirectory(), "agent-waker.service"), "utf8"),
    ).toBe(originalService);
    expect(await readFile(launcherPath(), "utf8")).toBe(originalLauncher);
    expect(await driver.inspect()).toMatchObject({
      installed: true,
      loaded: true,
      stalePath: false,
    });
  },
);

it.each([
  {
    name: "missing runtime directory",
    runtime: false,
    result: ok({ stdout: "running\n" }),
  },
  {
    name: "offline user manager",
    runtime: true,
    result: ok({ stdout: "offline\n", exitCode: 1 }),
  },
  {
    name: "missing systemctl",
    runtime: true,
    result: ok({ exitCode: null, startFailure: "not_found" }),
  },
  {
    name: "unreachable session bus",
    runtime: true,
    result: ok({ exitCode: 1, stderr: "Failed to connect to bus" }),
  },
])(
  "refuses $name before creating scheduler files",
  async ({ runtime, result }) => {
    const { runner } = recording(() => result);
    const driver = scheduler(
      runner,
      runtime
        ? { XDG_RUNTIME_DIR: join(home, "runtime") }
        : { XDG_RUNTIME_DIR: "" },
    );
    await expect(driver.install(config())).rejects.toThrow(
      /systemd.*user.*manager|XDG_RUNTIME_DIR/i,
    );
    await expect(access(timerPath())).rejects.toThrow();
    await expect(access(launcherPath())).rejects.toThrow();
  },
);

it.each(["daemon-reload", "link", "enable", "restart"])(
  "reports an install %s refusal instead of claiming success",
  async (command) => {
    const { runner } = recording((spec) =>
      spec.args.includes(command)
        ? ok({ exitCode: 1, stderr: "permission denied" })
        : ok({ stdout: "running\n" }),
    );
    await expect(scheduler(runner).install(config())).rejects.toThrow(
      new RegExp(`${command}.*permission denied`),
    );
  },
);

it("links custom XDG units into a manager with a different search path and removes those links after cleaning", async () => {
  const linked = new Set<string>();
  let active = false;
  let cleaned = false;
  const runtime = join(home, "runtime");
  const bus = "unix:path=/custom/runtime/bus";
  const runner: ProcessRunner = {
    async run(spec) {
      expect(spec.env).toMatchObject({
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: bus,
      });
      if (spec.args.includes("--property=UnitPath")) return managerPaths();
      if (spec.args.includes("is-system-running"))
        return ok({ stdout: "running\n" });
      if (spec.args.includes("link"))
        for (const path of spec.args
          .slice(2)
          .filter((arg) => arg.startsWith("/")))
          linked.add(path);
      if (spec.args.includes("enable") && !linked.has(timerPath()))
        return ok({
          exitCode: 1,
          stderr: "Unit is not in manager search path",
        });
      if (spec.args.includes("restart")) {
        if (!linked.has(join(unitDirectory(), "agent-waker.service")))
          return ok({
            exitCode: 1,
            stderr: "Service is not in manager search path",
          });
        active = true;
      }
      if (spec.args.includes("show"))
        return ok({
          stdout:
            "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n",
        });
      if (spec.args.includes("stop")) active = false;
      if (spec.args.includes("clean")) {
        if (!linked.has(timerPath()) || active)
          return ok({
            exitCode: 1,
            stderr: "Timer must remain available and stopped for cleanup",
          });
        cleaned = true;
      }
      if (spec.args.includes("disable"))
        for (const name of spec.args.slice(2))
          linked.delete(join(unitDirectory(), name));
      return Promise.resolve(ok());
    },
  };
  const driver = createSystemdUserScheduler({
    runner,
    unitDirectory: unitDirectory(),
    launcherPath: launcherPath(),
    env: {
      XDG_RUNTIME_DIR: runtime,
      DBUS_SESSION_BUS_ADDRESS: bus,
      XDG_CONFIG_HOME: join(home, ".config"),
    },
  });
  await driver.install(config());
  expect(await driver.inspect()).toMatchObject({
    installed: true,
    loaded: true,
    jobPath: timerPath(),
  });
  await driver.uninstall();
  expect(cleaned).toBe(true);
  expect(linked.size).toBe(0);
});

it.each(["node", "entrypoint", "launcher"] as const)(
  "identifies a missing recorded %s after an upgrade",
  async (missing) => {
    const nodePath = join(home, "node");
    await writeFile(nodePath, "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(config().entrypoint, "");
    const { runner } = recording();
    const driver = scheduler(runner);
    await driver.install({ ...config(), nodePath });
    const removed =
      missing === "node"
        ? nodePath
        : missing === "entrypoint"
          ? config().entrypoint
          : launcherPath();
    await rm(removed);
    expect(await driver.inspect()).toMatchObject({
      installed: true,
      loaded: true,
      stalePath: true,
      staleReason: missing,
    });
  },
);

it.each([
  {
    state: "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n",
    loaded: true,
  },
  {
    state: "LoadState=loaded\nActiveState=active\nUnitFileState=disabled\n",
    loaded: false,
  },
  {
    state: "LoadState=loaded\nActiveState=inactive\nUnitFileState=enabled\n",
    loaded: false,
  },
  {
    state: "LoadState=not-found\nActiveState=inactive\nUnitFileState=\n",
    loaded: false,
  },
])(
  "reports whether the installed timer will keep waking ticks: $state",
  async ({ state, loaded }) => {
    const { runner } = recording((spec) =>
      ok({
        stdout: spec.args.includes("is-system-running") ? "running\n" : state,
      }),
    );
    const driver = scheduler(runner);
    await driver.install(config());
    expect(await driver.inspect()).toMatchObject({ installed: true, loaded });
  },
);

it("reports missing service files and refuses a broken status query", async () => {
  let queryFails = false;
  const { runner } = recording((spec) =>
    spec.args.includes("show") && queryFails
      ? ok({ exitCode: 1, stderr: "Failed to connect to bus" })
      : ok({
          stdout: spec.args.includes("is-system-running")
            ? "running\n"
            : "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n",
        }),
  );
  const driver = scheduler(runner);
  await driver.install(config());
  queryFails = true;
  await expect(driver.inspect()).rejects.toThrow(/connect to bus/);
  queryFails = false;
  await rm(join(unitDirectory(), "agent-waker.service"));
  expect(await driver.inspect()).toMatchObject({
    installed: false,
    loaded: false,
  });
});

it("stops a running tick, cleans persistence, and can uninstall twice", async () => {
  let tickRunning = true;
  let persistence = true;
  let timerExists = true;
  const runner: ProcessRunner = {
    async run(spec) {
      if (spec.args.includes("--property=UnitPath")) return managerPaths();
      if (spec.args.includes("is-system-running"))
        return ok({ stdout: "running\n" });
      if (spec.args.includes("show"))
        return ok({
          stdout: timerExists ? "LoadState=loaded\n" : "LoadState=not-found\n",
        });
      if (spec.args.includes("stop")) tickRunning = false;
      if (spec.args.includes("clean")) {
        if (!timerExists) return ok({ exitCode: 5, stderr: "No such unit" });
        persistence = false;
      }
      return Promise.resolve(ok());
    },
  };
  const driver = scheduler(runner);
  await driver.install(config());
  await driver.uninstall();
  expect(tickRunning).toBe(false);
  expect(persistence).toBe(false);
  await expect(access(timerPath())).rejects.toThrow();
  await expect(
    access(join(unitDirectory(), "agent-waker.service")),
  ).rejects.toThrow();
  await expect(access(launcherPath())).rejects.toThrow();
  timerExists = false;
  await expect(driver.uninstall()).resolves.toBeUndefined();
});

it.each(["disable", "clean", "stop", "daemon-reload"])(
  "reports an uninstall %s failure",
  async (command) => {
    let uninstalling = false;
    const { runner } = recording((spec) =>
      uninstalling && spec.args.includes(command)
        ? ok({ exitCode: 1, stderr: "permission denied" })
        : ok({
            stdout: spec.args.includes("is-system-running")
              ? "running\n"
              : "LoadState=loaded\n",
          }),
    );
    const driver = scheduler(runner);
    await driver.install(config());
    uninstalling = true;
    await expect(driver.uninstall()).rejects.toThrow(
      new RegExp(`${command}.*permission denied`),
    );
  },
);

it("quotes generated unit arguments and runs the recorded tick without a user PATH", async () => {
  const awkwardLauncher = join(home, 'runner "%h" $HOME\\name');
  const entrypoint = join(home, "entry 'with spaces%$.js");
  const stateHome = join(home, "state 'with spaces%$");
  await writeFile(
    entrypoint,
    "console.log(JSON.stringify({ args: process.argv.slice(2), stateHome: process.env.XDG_STATE_HOME }));\n",
  );
  const { runner } = recording();
  const driver = createSystemdUserScheduler({
    runner,
    unitDirectory: unitDirectory(),
    launcherPath: awkwardLauncher,
    env: { XDG_RUNTIME_DIR: join(home, "runtime") },
  });
  await driver.install({
    ...config(),
    entrypoint,
    xdg: {
      XDG_CONFIG_HOME: home,
      XDG_STATE_HOME: stateHome,
      XDG_CACHE_HOME: home,
      XDG_DATA_HOME: home,
    },
  });
  const service = await readFile(
    join(unitDirectory(), "agent-waker.service"),
    "utf8",
  );
  expect(service).toContain(String.raw`runner \"%%h\" $$HOME\\name"`);
  expect(service).not.toContain("RemainAfterExit=true");
  const result = await exec("/bin/sh", [awkwardLauncher], {
    env: { HOME: home, PATH: "/no-user-path" },
  });
  expect(JSON.parse(result.stdout)).toEqual({ args: ["tick"], stateHome });
  expect(await driver.inspect()).toMatchObject({
    stalePath: false,
    nodePath: process.execPath,
    entrypoint,
  });
});

it("refuses an unsupported cadence instead of silently ignoring the install configuration", async () => {
  const { runner } = recording();
  await expect(
    scheduler(runner).install({ ...config(), intervalSeconds: 60 }),
  ).rejects.toThrow(/300|five.minute/i);
  await expect(access(timerPath())).rejects.toThrow();
});

it.skipIf(process.platform !== "linux")(
  "generates units and a five-minute calendar that native systemd accepts",
  async () => {
    expect(existsSync("/usr/bin/systemd-analyze")).toBe(true);
    const { runner } = recording();
    const runtime = join(home, "runtime");
    await mkdir(runtime, { mode: 0o700 });
    const driver = createSystemdUserScheduler({
      runner,
      unitDirectory: unitDirectory(),
      launcherPath: join(home, 'runner "%h" $HOME\\name'),
      env: { XDG_RUNTIME_DIR: runtime },
    });
    await driver.install(config());
    await expect(
      exec(
        "/usr/bin/systemd-analyze",
        [
          "--user",
          "verify",
          "--man=no",
          timerPath(),
          join(unitDirectory(), "agent-waker.service"),
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            XDG_RUNTIME_DIR: runtime,
            SYSTEMD_UNIT_PATH: `${unitDirectory()}:`,
          },
        },
      ),
    ).resolves.toBeDefined();
    const calendar = /^OnCalendar=(.+)$/m.exec(
      await readFile(timerPath(), "utf8"),
    )?.[1];
    expect(calendar).toBeDefined();
    const result = await exec(
      "/usr/bin/systemd-analyze",
      [
        "calendar",
        "--iterations=3",
        "--base-time=2026-09-07 06:02:00 UTC",
        calendar ?? "",
      ],
      { env: { ...process.env, TZ: "UTC" } },
    );
    expect(result.stdout).toContain("06:05:00");
    expect(result.stdout).toContain("06:10:00");
    expect(result.stdout).toContain("06:15:00");
  },
);
