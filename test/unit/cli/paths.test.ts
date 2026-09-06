import { describe, expect, it } from "vitest";

import { resolvePaths } from "#src/cli/paths.js";

const home = "/home/dev";

describe("resolvePaths", () => {
  it("follows the XDG layout by default", () => {
    expect(resolvePaths({}, home)).toEqual({
      config: "/home/dev/.config/agent-waker/config.yaml",
      configDir: "/home/dev/.config/agent-waker",
      stateDir: "/home/dev/.local/state/agent-waker",
      logDir: "/home/dev/.local/state/agent-waker/logs",
      cacheDir: "/home/dev/.cache/agent-waker",
      workDir: "/home/dev/.cache/agent-waker/work",
      launcherDir: "/home/dev/.local/share/agent-waker/bin",
    });
  });

  it("honours the XDG variables when they are set", () => {
    const paths = resolvePaths(
      {
        XDG_CONFIG_HOME: "/etc/xdg-config",
        XDG_STATE_HOME: "/var/xdg-state",
        XDG_CACHE_HOME: "/var/xdg-cache",
        XDG_DATA_HOME: "/usr/xdg-data",
      },
      home,
    );

    expect(paths).toMatchObject({
      config: "/etc/xdg-config/agent-waker/config.yaml",
      stateDir: "/var/xdg-state/agent-waker",
      cacheDir: "/var/xdg-cache/agent-waker",
      launcherDir: "/usr/xdg-data/agent-waker/bin",
    });
  });

  it("ignores a relative XDG value, as the specification requires", () => {
    // A relative path here would resolve against whatever directory the
    // scheduler happened to start the process in.
    expect(
      resolvePaths({ XDG_CONFIG_HOME: "relative/config" }, home).config,
    ).toBe("/home/dev/.config/agent-waker/config.yaml");
  });

  it("ignores an empty XDG value", () => {
    expect(resolvePaths({ XDG_STATE_HOME: "" }, home).stateDir).toBe(
      "/home/dev/.local/state/agent-waker",
    );
  });

  it("keeps the logs inside the state directory", () => {
    // One directory to inspect, and one to delete when starting over.
    const paths = resolvePaths({}, home);

    expect(paths.logDir.startsWith(paths.stateDir)).toBe(true);
  });

  it("keeps the working directory out of the state directory", () => {
    // Providers run in it, so it must be disposable without losing state.
    const paths = resolvePaths({}, home);

    expect(paths.workDir.startsWith(paths.stateDir)).toBe(false);
  });
});
