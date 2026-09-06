import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRegistry } from "#src/adapters/registry.js";
import type { CliEnvironment } from "#src/cli/context.js";
import { EXIT } from "#src/cli/exit.js";
import { run } from "#src/cli/main.js";
import { DEFAULT_LABEL } from "#src/schedulers/launchd.js";
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
  /** What the command asked, which never appears in its output. */
  questions: string[];
}

const invoke = async (
  argv: string[],
  options: {
    scripts?: Partial<Record<"claude" | "codex", FakeScript>>;
    now?: number;
    env?: Record<string, string | undefined>;
    isTty?: boolean;
    /** Answers for the prompts, in order; absent means nobody is there. */
    answers?: string[];
    runner?: ProcessRunner;
  } = {},
): Promise<Invocation> => {
  let out = "";
  let err = "";
  const questions: string[] = [];
  const environment: CliEnvironment = {
    argv,
    env: { HOME: home, LANG: "en_GB.UTF-8", ...options.env },
    home,
    platform: "darwin",
    uid: 501,
    isTty: options.isTty ?? false,
    execPath: "/opt/node/bin/node",
    entrypoint: "/opt/agent-waker/dist/cli/bin.js",
    systemTimezone: "Europe/Rome",
    now: () => options.now ?? at("09:00"),
    ...(options.answers === undefined
      ? {}
      : {
          ask: (question: string, fallback: string): Promise<string> => {
            questions.push(question);

            return Promise.resolve(options.answers?.shift() ?? fallback);
          },
        }),
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
    runner: options.runner ?? quietRunner,
  };

  return { code: await run(environment), out, err, questions };
};

const stateFile = (): Promise<string> =>
  readFile(join(home, ".local", "state", "agent-waker", "state.json"), "utf8");

const configFile = (): Promise<string> =>
  readFile(join(home, ".config", "agent-waker", "config.yaml"), "utf8");

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

describe("telemetry", () => {
  let server: Server;
  let received: { url: string; body: string }[];
  let endpoint: string;

  beforeEach(async () => {
    received = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];

      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          url: request.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200).end();
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );

    const address = server.address();

    endpoint = `http://127.0.0.1:${String(
      typeof address === "object" && address !== null ? address.port : 0,
    )}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  const withCollector = async (): Promise<void> => {
    await writeConfig(`${CONFIG}telemetry:\n  endpoint: ${endpoint}\n`);
  };

  it("exports a trace and its logs to the collector", async () => {
    await withCollector();
    await invoke(["tick"], { now: at("07:00") });

    expect(received.map((request) => request.url).toSorted()).toEqual([
      "/v1/logs",
      "/v1/traces",
    ]);

    const traces = received.find((request) => request.url === "/v1/traces");

    expect(traces?.body).toContain("agent_waker.tick");
    expect(traces?.body).toContain("agent.activation");
    expect(traces?.body).toContain("service.name");
  });

  it("stays off the network when nothing was due", async () => {
    await withCollector();
    await invoke(["tick"], { now: at("05:00") });

    // A minute-level scheduler cannot afford a connection attempt per tick,
    // and a no-op has nothing to say (ARCHITECTURE §34).
    expect(received).toEqual([]);
  });

  it("sends nothing at all when no endpoint is configured", async () => {
    await writeConfig();
    await invoke(["tick"], { now: at("07:00") });

    expect(received).toEqual([]);
  });

  it("completes the tick when the collector refuses everything", async () => {
    await writeConfig(
      `${CONFIG}telemetry:\n  endpoint: http://127.0.0.1:1\n  timeout: 1s\n`,
    );

    const { code } = await invoke(["tick"], { now: at("07:00") });

    expect(code).toBe(EXIT.ok);
    expect(await stateFile()).toContain('"phase": "activated"');
  });

  it("records the export failure once debug logging is on", async () => {
    await writeConfig(
      `${CONFIG}logging:\n  level: debug\ntelemetry:\n  endpoint: http://127.0.0.1:1\n  timeout: 1s\n`,
    );
    await invoke(["tick"], { now: at("07:00") });

    const { out } = await invoke(["logs"]);

    expect(out).toContain("telemetry.export_failed");
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

describe("the working directory providers run in", () => {
  it("exists before any adapter is asked to run", async () => {
    // Spawning into a directory that is not there fails with ENOENT, which
    // looks exactly like a missing executable. Every command was reporting
    // every agent as signed out until this was created.
    await writeConfig();
    await invoke(["status"]);

    for (const agentId of ["claude", "codex"]) {
      await expect(
        stat(join(home, ".cache", "agent-waker", "work", agentId)),
      ).resolves.toBeDefined();
    }
  });
});

describe("detect", () => {
  it("lists what is installed and how it is authenticated", async () => {
    await writeConfig();

    const { code, out } = await invoke(["detect"]);

    expect(code).toBe(EXIT.ok);
    expect(out).toContain("Supported coding agents");
    expect(out).toContain("Fake claude");
    expect(out).toContain("healthy");
    expect(out).toContain("subscription");
  });

  it("changes nothing", async () => {
    // A diagnostic that repairs things cannot be trusted to report state.
    await writeConfig();
    await invoke(["detect"]);

    await expect(stateFile()).rejects.toThrow();
  });

  it("says when an agent is not installed", async () => {
    await writeConfig();

    const { code, out } = await invoke(["detect"], {
      scripts: { codex: { detect: [{ installed: false, health: "unknown" }] } },
    });

    expect(code).toBe(EXIT.partial);
    expect(out).toContain("not installed");
  });

  it("separates a found-but-unrunnable install from a missing one", async () => {
    await writeConfig();

    const { out } = await invoke(["detect"], {
      scripts: {
        codex: {
          detect: [
            { installed: true, health: "broken", executable: "/usr/bin/codex" },
          ],
        },
      },
    });

    expect(out).toContain("found, but will not run");
  });

  it("names an API key as unusable rather than as signed in", async () => {
    await writeConfig();

    const { code, out } = await invoke(["detect"], {
      scripts: {
        codex: {
          auth: [
            { authenticated: true, mode: "api_key", supportsIntent: false },
          ],
        },
      },
    });

    expect(code).toBe(EXIT.partial);
    expect(out).toContain("cannot be used for subscription activation");
  });
});

describe("logs", () => {
  it("says so when there is nothing yet", async () => {
    await writeConfig();

    const { code, out } = await invoke(["logs"]);

    expect(code).toBe(EXIT.ok);
    expect(out).toContain("No events yet");
  });

  it("shows what happened", async () => {
    await writeConfig();
    await invoke(["tick"], { now: at("07:00") });

    const { out } = await invoke(["logs"]);

    expect(out).toContain("scheduler.tick");
    expect(out).toContain("agent.activated");
    expect(out).toContain("07:00");
  });

  it("takes a limit", async () => {
    await writeConfig();
    await invoke(["tick"], { now: at("07:00") });

    const { out } = await invoke(["logs", "--limit", "1"]);

    expect(out.trim().split("\n")).toHaveLength(1);
  });

  it("refuses a limit that is not a number", async () => {
    await writeConfig();

    expect((await invoke(["logs", "--limit", "lots"])).code).toBe(EXIT.usage);
  });

  it("strips control characters out of provider text", async () => {
    // A log line is untrusted content on its way to a terminal.
    await writeConfig();
    await invoke(["tick"], {
      now: at("07:00"),
      scripts: {
        codex: {
          probe: [
            {
              kind: "unknown",
              detail: "\u001b[2Jcleared your screen",
            },
          ],
        },
      },
    });

    const { out } = await invoke(["logs"]);

    expect(out).toContain("cleared your screen");
    expect(out).not.toMatch(ANSI);
  });
});

describe("schedule set", () => {
  it("changes the time and says what changed", async () => {
    await writeConfig();

    const { code, out } = await invoke(["schedule", "set", "06:45"]);

    expect(code).toBe(EXIT.ok);
    expect(out).toContain("from  07:00");
    expect(out).toContain("to    06:45");
    expect((await invoke(["status"])).out).toContain(
      "Desired activation: 06:45",
    );
  });

  it("can change the timezone at the same time", async () => {
    await writeConfig();
    await invoke([
      "schedule",
      "set",
      "06:45",
      "--timezone",
      "America/New_York",
    ]);

    expect((await invoke(["status"])).out).toContain("America/New_York");
  });

  it("keeps the comments in the file", async () => {
    await writeConfig("# my notes\nversion: 1\ntimezone: Europe/Rome\n");
    await invoke(["schedule", "set", "06:45"]);

    expect(await configFile()).toContain("# my notes");
  });

  it("keeps the previous version alongside", async () => {
    await writeConfig();
    await invoke(["schedule", "set", "06:45"]);

    expect(
      await readFile(
        join(home, ".config", "agent-waker", "config.yaml.bak"),
        "utf8",
      ),
    ).toContain("version: 1");
  });

  it("refuses a time that is not a time, without touching the file", async () => {
    await writeConfig();

    const before = await configFile();
    const { code } = await invoke(["schedule", "set", "quarter past seven"]);

    expect(code).toBe(EXIT.failed);
    expect(await configFile()).toBe(before);
  });

  it("refuses a timezone that is not one", async () => {
    await writeConfig();

    expect(
      (await invoke(["schedule", "set", "07:00", "--timezone", "Europe/Roma"]))
        .code,
    ).toBe(EXIT.failed);
  });

  it("asks for a time when none was given", async () => {
    await writeConfig();

    const { code, err } = await invoke(["schedule", "set"]);

    expect(code).toBe(EXIT.usage);
    expect(err).toContain("07:00");
  });

  it("refuses a schedule subcommand it does not have", async () => {
    await writeConfig();

    expect((await invoke(["schedule", "clear"])).code).toBe(EXIT.usage);
  });
});

describe("enable and disable", () => {
  it("leaves a disabled agent out of the daily cycle", async () => {
    await writeConfig();

    const { code, out } = await invoke(["disable", "codex"]);

    expect(code).toBe(EXIT.ok);
    expect(out).toContain("Fake codex disabled");
    expect(out).toContain("agent-waker enable codex");

    await invoke(["tick"], { now: at("07:00") });

    const parsed = JSON.parse(await stateFile()) as {
      agents: Record<string, { phase: string }>;
    };

    expect(parsed.agents.claude?.phase).toBe("activated");
    expect(parsed.agents.codex?.phase).toBe("idle");
  });

  it("keeps what already happened, so status still explains itself", async () => {
    await writeConfig();
    await invoke(["tick"], { now: at("07:00") });
    await invoke(["disable", "codex"]);

    const { out } = await invoke(["status"], { now: at("09:00") });

    expect(out).toContain("Disabled");
    expect(out).toContain("today 07:00");
  });

  it("brings an agent back", async () => {
    await writeConfig();
    await invoke(["disable", "codex"]);

    expect((await invoke(["enable", "codex"])).out).toContain(
      "Fake codex enabled",
    );
    expect(await configFile()).toContain("enabled: true");
  });

  it("asks which agent when none was named", async () => {
    await writeConfig();

    const { code, err } = await invoke(["disable"]);

    expect(code).toBe(EXIT.usage);
    expect(err).toContain("agent-waker disable codex");
  });
});

describe("unknown options", () => {
  it("are refused rather than ignored", async () => {
    await writeConfig();

    const { code, err } = await invoke(["status", "--verbose"]);

    expect(code).toBe(EXIT.usage);
    expect(err).toContain("--verbose");
  });

  it("say so when a value is missing", async () => {
    await writeConfig();

    const { code, err } = await invoke([
      "schedule",
      "set",
      "07:00",
      "--timezone",
    ]);

    expect(code).toBe(EXIT.usage);
    expect(err).toContain("needs a value");
  });
});

describe("doctor", () => {
  it("reports a healthy machine as healthy", async () => {
    await writeConfig();

    const { code, out } = await invoke(["doctor"]);

    expect(out).toContain("agent waker doctor");
    expect(out).toContain("configuration is valid");
    expect(out).toContain("subscription authentication detected");
    // The scheduler is not installed in this fixture, so it is not healthy.
    expect(code).toBe(EXIT.partial);
    expect(out).toContain("1 thing needs attention");
  });

  it("counts more than one problem in the plural", async () => {
    await writeConfig();

    const { out } = await invoke(["doctor"], {
      scripts: { codex: { detect: [{ installed: false, health: "unknown" }] } },
    });

    expect(out).toContain("2 things need attention");
  });

  it("names a failed check by the problem, not by the hope", async () => {
    await writeConfig();

    expect((await invoke(["doctor"])).out).toContain(
      "scheduler is not installed",
    );
  });

  it("says nothing is waking it when the scheduler is missing", async () => {
    await writeConfig();

    const { out } = await invoke(["doctor"]);

    expect(out).toContain("Nothing is waking agent waker");
    expect(out).toContain("agent-waker init");
  });

  it("can be asked about one agent", async () => {
    await writeConfig();

    const { out } = await invoke(["doctor", "codex"]);

    expect(out).toContain("Fake codex");
    expect(out).not.toContain("Fake claude");
    // Asked about an agent, it answers about that agent.
    expect(out).not.toContain("Scheduler");
  });

  it("changes nothing", async () => {
    await writeConfig();

    const before = await configFile();

    await invoke(["doctor"]);

    expect(await configFile()).toBe(before);
  });

  it("separates a wrapper that will not start from a missing install", async () => {
    await writeConfig();

    const { out } = await invoke(["doctor", "codex"], {
      scripts: {
        codex: {
          detect: [
            { installed: true, health: "broken", executable: "/usr/bin/codex" },
          ],
        },
      },
    });

    expect(out).toContain("could not start");
    expect(out).toContain("/usr/bin/codex");
    expect(out).toContain("Reinstall through an official method");
  });

  it("refuses to offer a way around a security control", async () => {
    // macOS removing part of an install is a real case, and working around it
    // is not agent waker's business.
    await writeConfig();

    const { out } = await invoke(["doctor", "codex"], {
      scripts: {
        codex: {
          detect: [
            { installed: true, health: "broken", executable: "/usr/bin/codex" },
          ],
        },
      },
    });

    expect(out).toContain("will not restore the installation or bypass");
  });

  it("tells a signed-out user where to sign in", async () => {
    await writeConfig();

    const { out } = await invoke(["doctor", "claude"], {
      scripts: {
        claude: {
          auth: [{ authenticated: false, mode: "none", supportsIntent: false }],
        },
      },
    });

    expect(out).toContain("not authenticated");
    expect(out).toContain("sign in with your subscription");
  });

  it("explains an API key as a mismatch rather than a fault", async () => {
    await writeConfig();

    const { code, out } = await invoke(["doctor", "claude"], {
      scripts: {
        claude: {
          auth: [
            { authenticated: true, mode: "api_key", supportsIntent: false },
          ],
        },
      },
    });

    expect(code).toBe(EXIT.partial);
    expect(out).toContain("API-key authentication detected");
    expect(out).toContain("bill separately per token");
  });

  it("says an agent that is not installed is not installed", async () => {
    await writeConfig();

    const { out } = await invoke(["doctor", "codex"], {
      scripts: { codex: { detect: [{ installed: false, health: "unknown" }] } },
    });

    expect(out).toContain("is not installed");
    expect(out).not.toContain("could not start");
  });
});

describe("init", () => {
  /** launchctl and plutil succeed, so the scheduler installs. */
  const installs: ProcessRunner = {
    run: (): Promise<ProcessResult> =>
      Promise.resolve({
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: { stdout: false, stderr: false },
        durationMs: 1,
      }),
  };

  const setUp = (
    argv: string[],
    options: Parameters<typeof invoke>[1] = {},
  ): Promise<Invocation> => invoke(argv, { ...options, runner: installs });

  it("writes a configuration and installs the scheduler", async () => {
    const { code, out } = await setUp(["init"], { now: at("06:00") });

    expect(code).toBe(EXIT.ok);
    expect(out).toContain("agent waker is ready");
    expect(await configFile()).toContain("version: 1");
    expect(
      await readFile(
        join(home, "Library", "LaunchAgents", `${DEFAULT_LABEL}.plist`),
        "utf8",
      ),
    ).toContain("StartInterval");
  });

  it("writes a file that explains itself", async () => {
    // The next thing a user does is open it.
    await setUp(["init"], { now: at("06:00") });

    const written = await configFile();

    expect(written).toContain("# agent waker configuration.");
    expect(written).toContain("agent-waker schedule set");
  });

  it("defaults to the machine's timezone and a sensible hour", async () => {
    await setUp(["init"], { now: at("06:00") });

    expect(await configFile()).toContain("timezone: Europe/Rome");
    expect(await configFile()).toContain('notBefore: "07:00"');
  });

  it("takes the time and zone from the command line", async () => {
    await setUp(["init", "--time", "06:45", "--timezone", "America/New_York"], {
      now: at("03:00"),
    });

    const written = await configFile();

    expect(written).toContain('notBefore: "06:45"');
    expect(written).toContain("timezone: America/New_York");
  });

  it("asks when somebody is there to answer", async () => {
    await setUp(["init"], {
      now: at("06:00"),
      answers: ["America/New_York", "06:30"],
    });

    const written = await configFile();

    expect(written).toContain("timezone: America/New_York");
    expect(written).toContain('notBefore: "06:30"');
  });

  it("keeps a setting the user already had", async () => {
    await writeConfig(
      "# mine\nversion: 1\ntimezone: Europe/Rome\nagents:\n  codex:\n    enabled: false\n",
    );
    await setUp(["init", "--time", "06:45"], { now: at("03:00") });

    const written = await configFile();

    expect(written).toContain("# mine");
    expect(written).toContain("enabled: false");
    expect(written).toContain('notBefore: "06:45"');
  });

  it("says when the next decision point is", async () => {
    const { out } = await setUp(["init", "--time", "07:00"], {
      now: at("06:00"),
    });

    expect(out).toContain("Next decision point:");
    expect(out).toContain("today 07:00");
  });

  it("offers to catch up when the morning has already passed", async () => {
    const { questions } = await setUp(["init", "--time", "07:00"], {
      now: at("09:00"),
      answers: ["Europe/Rome", "y"],
    });

    expect(questions.at(-1)).toContain("already past today's activation time");
    expect(await stateFile()).toContain('"phase": "activated"');
  });

  it("leaves the morning alone when the answer is no", async () => {
    await setUp(["init", "--time", "07:00"], {
      now: at("09:00"),
      answers: ["Europe/Rome", "n"],
    });

    await expect(stateFile()).rejects.toThrow();
  });

  it("does not catch up when nobody is there to say so", async () => {
    // A scripted install must not start talking to providers on its own.
    await setUp(["init", "--time", "07:00"], { now: at("09:00") });

    await expect(stateFile()).rejects.toThrow();
  });

  it("rebuilds only the scheduler with --repair", async () => {
    // The Node-upgrade case: the configuration is fine, the launcher is not.
    await writeConfig("# untouched\nversion: 1\ntimezone: Europe/Rome\n");

    const { code, out } = await setUp(["init", "--repair"]);

    expect(code).toBe(EXIT.ok);
    expect(out).toContain("Scheduler reinstalled");
    expect(await configFile()).toContain("# untouched");
  });

  it("refuses a time that is not a time", async () => {
    expect((await setUp(["init", "--time", "breakfast"])).code).toBe(
      EXIT.failed,
    );
  });
});

describe("uninstall", () => {
  const removes: ProcessRunner = {
    run: (): Promise<ProcessResult> =>
      Promise.resolve({
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: { stdout: false, stderr: false },
        durationMs: 1,
      }),
  };

  it("says what it will remove before removing it", async () => {
    await writeConfig();

    const { out } = await invoke(["uninstall"], { runner: removes });

    expect(out).toContain("This will remove:");
    expect(out).toContain("Nothing was removed.");
    expect(await configFile()).toContain("version: 1");
  });

  it("promises not to touch the agents themselves", async () => {
    await writeConfig();

    expect((await invoke(["uninstall"], { runner: removes })).out).toContain(
      "Claude Code and Codex are left alone",
    );
  });

  it("removes what it owns once confirmed", async () => {
    await writeConfig();
    await invoke(["tick"], { now: at("07:00") });
    await invoke(["uninstall", "--yes"], { runner: removes });

    await expect(configFile()).rejects.toThrow();
    await expect(stateFile()).rejects.toThrow();
  });

  it("keeps the logs unless asked", async () => {
    // They are the record of what happened, and they outlive the tool.
    await writeConfig();
    await invoke(["tick"], { now: at("07:00") });
    await invoke(["uninstall", "--yes"], { runner: removes });

    await expect(
      stat(join(home, ".local", "state", "agent-waker", "logs")),
    ).resolves.toBeDefined();
  });

  it("removes the logs when asked", async () => {
    await writeConfig();
    await invoke(["tick"], { now: at("07:00") });
    await invoke(["uninstall", "--yes", "--logs"], { runner: removes });

    await expect(
      stat(join(home, ".local", "state", "agent-waker", "logs")),
    ).rejects.toThrow();
  });

  it("takes an answer from whoever is there", async () => {
    await writeConfig();
    await invoke(["uninstall"], { runner: removes, answers: ["y"] });

    await expect(configFile()).rejects.toThrow();
  });

  it("works when there was never a configuration", async () => {
    const { code } = await invoke(["uninstall", "--yes"], { runner: removes });

    expect(code).toBe(EXIT.ok);
  });
});
