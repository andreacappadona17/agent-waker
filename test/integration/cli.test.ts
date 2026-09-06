import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRegistry } from "#src/adapters/registry.js";
import type { CliEnvironment } from "#src/cli/context.js";
import { EXIT } from "#src/cli/exit.js";
import { run } from "#src/cli/main.js";
import type { AgentObservation } from "#src/core/observation.js";
import type { ProcessResult, ProcessRunner } from "#src/process/runner.js";
import { createStateStore } from "#src/state/store.js";
import { createFakeAdapter, type FakeScript } from "../support/fake-adapter.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agent-waker-cli-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const CONFIG = `version: 1
timezone: Europe/Rome
`;

// eslint-disable-next-line no-control-regex -- matching escape sequences is the point
const ANSI = /\u001b\[/;

const utc = (iso: string): number => Date.parse(iso);
const at = (localTime: string, day = "07"): number =>
  utc(`2026-09-${day}T${localTime}:00.000Z`) - 2 * 3_600_000;

const writeConfig = async (contents = CONFIG): Promise<void> => {
  await mkdir(join(home, ".config", "agent-waker"), { recursive: true });
  await writeFile(
    join(home, ".config", "agent-waker", "config.yaml"),
    contents,
  );
};

/** launchctl and plutil answer as if nothing is installed. */
const quietRunner: ProcessRunner = {
  run: (): Promise<ProcessResult> =>
    Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: 1,
      signal: null,
      timedOut: false,
      truncated: { stdout: false, stderr: false },
      durationMs: 1,
    }),
};

interface Invocation {
  code: number;
  out: string;
  err: string;
}

const invoke = async (
  argv: string[],
  options: {
    scripts?: Partial<Record<"claude" | "codex", FakeScript>>;
    now?: number;
    env?: Record<string, string | undefined>;
    isTty?: boolean;
  } = {},
): Promise<Invocation> => {
  let out = "";
  let err = "";
  const environment: CliEnvironment = {
    argv,
    env: { HOME: home, LANG: "en_GB.UTF-8", ...options.env },
    home,
    platform: "darwin",
    uid: 501,
    isTty: options.isTty ?? false,
    now: () => options.now ?? at("09:00"),
    write: (text) => {
      out += text;
    },
    writeError: (text) => {
      err += text;
    },
    registry: createRegistry([
      createFakeAdapter("claude", options.scripts?.claude ?? {}),
      createFakeAdapter("codex", options.scripts?.codex ?? {}),
    ]),
    runner: quietRunner,
  };

  return { code: await run(environment), out, err };
};

const stateFile = (): Promise<string> =>
  readFile(join(home, ".local", "state", "agent-waker", "state.json"), "utf8");

describe("help", () => {
  it("is what an empty command line gets", async () => {
    const { code, out } = await invoke([]);

    expect(code).toBe(EXIT.ok);
    expect(out).toContain("Usage:");
  });

  it.each(["-h", "--help"])("is what %s gets", async (flag) => {
    expect((await invoke(["status", flag])).out).toContain("Usage:");
  });

  it("documents the exit codes, since scripts depend on them", async () => {
    expect((await invoke(["help"])).out).toContain("Exit codes:");
  });

  it("reports the version", async () => {
    const { code, out } = await invoke(["--version"]);

    expect(code).toBe(EXIT.ok);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("bad usage", () => {
  it("refuses a command it does not have", async () => {
    const { code, err } = await invoke(["frobnicate"]);

    expect(code).toBe(EXIT.usage);
    expect(err).toContain("Unknown command");
  });

  it("refuses an agent it does not have", async () => {
    const { code, err } = await invoke(["run", "gemini"]);

    expect(code).toBe(EXIT.usage);
    expect(err).toContain("gemini");
  });

  it("says how to start when there is no configuration", async () => {
    const { code, err } = await invoke(["status"]);

    expect(code).toBe(EXIT.usage);
    expect(err).toContain("agent-waker init");
  });

  it("points at the line when the configuration is wrong", async () => {
    await writeConfig("version: 1\ntimezone: Europe/Roma\n");

    const { code, err } = await invoke(["status"]);

    expect(code).toBe(EXIT.usage);
    expect(err).toMatch(/config\.yaml:2:11/);
  });
});

describe("tick", () => {
  it("activates and reports success", async () => {
    await writeConfig();

    expect((await invoke(["tick"])).code).toBe(EXIT.ok);
    expect(await stateFile()).toContain('"phase": "activated"');
  });

  it("says nothing when nothing is due", async () => {
    await writeConfig();

    const { code, out } = await invoke(["tick"], { now: at("06:00") });

    expect(code).toBe(EXIT.ok);
    expect(out).toBe("");
  });

  it("treats a deferred agent as success, because deferment is state", async () => {
    const blocked: AgentObservation = {
      kind: "blocked",
      reason: "rolling_window",
      constraints: [{ type: "rolling_window", confidence: "high" }],
    };

    await writeConfig();

    expect(
      (await invoke(["tick"], { scripts: { codex: { probe: [blocked] } } }))
        .code,
    ).toBe(EXIT.ok);
  });

  it("reports a partial failure when something needs a person", async () => {
    await writeConfig();

    const { code } = await invoke(["tick"], {
      scripts: { codex: { detect: [{ installed: false, health: "unknown" }] } },
    });

    expect(code).toBe(EXIT.partial);
  });

  it("steps aside without complaint when another run holds the lock", async () => {
    // launchd fires every minute. A slow run must not make the next minute
    // log a failure.
    await writeConfig();

    const store = createStateStore(
      join(home, ".local", "state", "agent-waker"),
    );

    await store.withLock(async () => {
      const { code, err } = await invoke(["tick"]);

      expect(code).toBe(EXIT.ok);
      expect(err).toBe("");
    });
  });

  it("writes a log the user can read afterwards", async () => {
    await writeConfig();
    await invoke(["tick"]);

    const log = await readFile(
      join(
        home,
        ".local",
        "state",
        "agent-waker",
        "logs",
        "events-2026-09-07.jsonl",
      ),
      "utf8",
    );

    expect(log).toContain("scheduler.tick");
    expect(log).toContain("agent.activated");
  });
});

describe("run", () => {
  it("evaluates now rather than waiting for the schedule", async () => {
    await writeConfig();

    const { code } = await invoke(["run"], { now: at("05:00") });

    expect(code).toBe(EXIT.ok);
    expect(await stateFile()).toContain('"phase": "activated"');
  });

  it("can be pointed at one agent", async () => {
    await writeConfig();
    await invoke(["run", "claude"], { now: at("05:00") });

    const parsed = JSON.parse(await stateFile()) as {
      agents: Record<string, { phase: string }>;
    };

    expect(parsed.agents.claude?.phase).toBe("activated");
    expect(parsed.agents.codex?.phase).toBe("idle");
  });
});

describe("status", () => {
  it("describes a machine that has not run yet", async () => {
    await writeConfig();

    const { code, out } = await invoke(["status"]);

    expect(code).toBe(EXIT.ok);
    expect(out).toContain("Desired activation: 07:00 Europe/Rome");
    expect(out).toContain("Waiting for 07:00");
    expect(out).toContain("not installed");
    expect(out).toContain("macOS");
  });

  it("says today while today's cycle has not opened yet", async () => {
    await writeConfig();

    const { out } = await invoke(["status"], { now: at("06:00") });

    expect(out).toContain("today 07:00");
    expect(out).not.toContain("tomorrow");
  });

  it("describes a morning that went well", async () => {
    await writeConfig();
    await invoke(["tick"], { now: at("07:00") });

    const { out } = await invoke(["status"], { now: at("09:00") });

    expect(out).toContain("Activated");
    expect(out).toContain("today 07:00");
    expect(out).toContain("tomorrow 07:00");
  });

  it("explains a deferred agent without calling it an error", async () => {
    await writeConfig();
    await invoke(["tick"], {
      now: at("07:00"),
      scripts: {
        codex: {
          probe: [
            {
              kind: "blocked",
              reason: "rolling_window",
              constraints: [
                {
                  type: "rolling_window",
                  resetAt: at("08:23"),
                  confidence: "high",
                },
              ],
            },
          ],
        },
      },
    });

    const { code, out } = await invoke(["status"], { now: at("07:30") });

    expect(code).toBe(EXIT.ok);
    expect(out).toContain("Usage window limited");
    expect(out).toContain("resets at today 08:23");
  });

  it("still exits zero when an agent needs attention", async () => {
    // Reporting is not failing; `doctor` is the command that grades health.
    await writeConfig();
    await invoke(["tick"], {
      now: at("07:00"),
      scripts: { codex: { detect: [{ installed: false, health: "unknown" }] } },
    });

    const { code, out } = await invoke(["status"], { now: at("07:30") });

    expect(code).toBe(EXIT.ok);
    expect(out).toContain("needs attention");
  });

  it("honours NO_COLOR", async () => {
    await writeConfig();

    const { out } = await invoke(["status"], {
      env: { NO_COLOR: "1" },
      isTty: true,
    });

    expect(out).not.toMatch(ANSI);
  });

  it("drops to ASCII when the locale cannot promise more", async () => {
    await writeConfig();

    const { out } = await invoke(["status"], { env: { LANG: "C" } });

    expect(/^[ -~\n]*$/.test(out)).toBe(true);
  });
});
