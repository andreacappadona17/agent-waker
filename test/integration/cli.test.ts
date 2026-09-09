import {
  chmod,
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
import { parseConfig } from "#src/config/config.js";
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
    platform?: string;
  } = {},
): Promise<Invocation> => {
  let out = "";
  let err = "";
  const questions: string[] = [];
  const environment: CliEnvironment = {
    argv,
    env: { HOME: home, LANG: "en_GB.UTF-8", ...options.env },
    home,
    platform: options.platform ?? "darwin",
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
            // As `bin.ts` renders it, so a test can assert the default the
            // user is actually shown.
            questions.push(`${question} (${fallback})`);

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

  it("says what it is doing, and what it found", async () => {
    await writeConfig();

    const { out } = await invoke(["run"], { now: at("05:00") });

    // Two minutes is the activation budget, so silence until the end reads as
    // a hang.
    expect(out).toContain("Checking Fake claude...");
    expect(out).toContain("Checking Fake codex...");
    expect(out).toContain("Activation check complete");
    expect(out).toMatch(/Fake claude\s+Activated/);
    expect(out).toContain("Next scheduled decision: tomorrow 07:00");
  });

  it("reports only the agent it was pointed at", async () => {
    await writeConfig();

    const { out } = await invoke(["run", "codex"], { now: at("05:00") });

    expect(out).toContain("Checking Fake codex...");
    expect(out).not.toContain("claude");
  });

  it("leaves a completed cycle alone rather than spending another turn", async () => {
    await writeConfig();
    await invoke(["run"], { now: at("07:00") });

    const { out, code } = await invoke(["run"], { now: at("09:00") });

    expect(out).toContain("already activated today 07:00");
    expect(out).toContain("nothing was sent");
    expect(out).not.toContain("Checking");
    expect(code).toBe(EXIT.ok);
  });

  it("explains a usage limit rather than calling it a failure", async () => {
    await writeConfig();

    const { out, code } = await invoke(["run"], {
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

    // Deferment is normal, not an error (UX §2.3).
    expect(code).toBe(EXIT.ok);
    expect(out).toContain("Usage window limited");
    expect(out).toContain("The current window resets at today 08:23.");
  });

  it("points at tomorrow after finishing a cycle early", async () => {
    await writeConfig();
    await invoke(["run"], { now: at("05:00") });

    // The scheduled tick at 07:00 will find the cycle complete and do nothing,
    // so promising "today 07:00" would be promising nothing.
    const { out } = await invoke(["status"], { now: at("05:30") });

    expect(out).toContain("tomorrow 07:00");
    expect(out).not.toContain("today 07:00");
  });

  it("says what to do about an agent that needs a person", async () => {
    await writeConfig();

    const { out, code } = await invoke(["run", "codex"], {
      now: at("07:00"),
      scripts: {
        codex: { detect: [{ installed: true, health: "broken" }] },
      },
    });

    expect(code).toBe(EXIT.partial);
    expect(out).toContain("Installation problem");
    expect(out).toContain("agent-waker doctor codex");
  });

  it("agrees with tick about what counts as needing attention", async () => {
    await writeConfig(`${CONFIG}agents:\n  codex:\n    enabled: false\n`);

    const broken = {
      codex: { detect: [{ installed: true, health: "broken" as const }] },
    };

    // Disabling a broken agent used to leave every scheduled tick reporting
    // failure forever, because a disabled agent keeps the phase it had when it
    // was switched off.
    const ticked = await invoke(["tick"], {
      now: at("07:00"),
      scripts: broken,
    });
    const ran = await invoke(["run"], { now: at("07:30"), scripts: broken });

    expect(ticked.code).toBe(EXIT.ok);
    expect(ran.code).toBe(EXIT.ok);
  });

  it("says nothing about an agent that is switched off", async () => {
    await writeConfig(`${CONFIG}agents:\n  codex:\n    enabled: false\n`);

    const { out } = await invoke(["run"], {
      now: at("07:00"),
      scripts: {
        codex: { detect: [{ installed: true, health: "broken" }] },
      },
    });

    // A switched-off agent's last known problem is not news, and telling the
    // user to run `doctor` on it contradicts the exit code.
    expect(out).toContain("Disabled");
    expect(out).not.toContain("agent-waker doctor codex");
  });

  it("leaves out the footer when nothing is scheduled", async () => {
    await writeConfig(
      `${CONFIG}agents:\n  claude:\n    enabled: false\n  codex:\n    enabled: false\n`,
    );

    const { out } = await invoke(["run"], { now: at("07:00") });

    // An em dash as a headline answer is worse than no headline.
    expect(out).not.toContain("Next scheduled decision");
  });

  it("keeps its output printable without Unicode", async () => {
    await writeConfig();

    const { out } = await invoke(["run"], {
      now: at("05:00"),
      env: { NO_COLOR: "1", LC_ALL: "C" },
    });

    expect(out).not.toMatch(ANSI);
    expect(out).toMatch(/^[\u0020-\u007e\n]*$/);
    // The charset alone is not the assertion: an ellipsis that became "?"
    // would satisfy it while losing the word.
    expect(out).toContain("Checking Fake claude...");
    expect(out).toMatch(/Fake claude\s+Activated/);
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

    const { out } = await invoke(["logs", "--debug"]);

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

describe("an unsupported platform", () => {
  it("refuses rather than half working", async () => {
    await writeConfig();

    const { code, err } = await invoke(["status"], { platform: "linux" });

    // Exit 4 has been in the contract and the help text since the router was
    // written, and nothing returned it until now.
    expect(code).toBe(EXIT.unsupported);
    expect(err).toContain("macOS");
    expect(err).toContain("Linux");
  });

  it("refuses before it touches the configuration", async () => {
    // No config written: the answer is about the machine, not the setup.
    const { code, err } = await invoke(["init"], { platform: "win32" });

    expect(code).toBe(EXIT.unsupported);
    expect(err).toContain("win32");
    await expect(configFile()).rejects.toThrow();
  });

  it("still answers a question anybody can ask", async () => {
    const help = await invoke(["help"], { platform: "linux" });
    const version = await invoke(["--version"], { platform: "linux" });

    expect(help.code).toBe(EXIT.ok);
    expect(help.out).toContain("Usage:");
    expect(version.code).toBe(EXIT.ok);
  });
});

describe("logs", () => {
  it("says so when there is nothing yet", async () => {
    await writeConfig();

    const { code, out } = await invoke(["logs"]);

    expect(code).toBe(EXIT.ok);
    expect(out).toContain("No events yet");
  });

  it("shows what happened, in the words the other commands use", async () => {
    await writeConfig();
    await invoke(["tick"], { now: at("07:00") });

    const { out } = await invoke(["logs"], { now: at("07:05") });

    expect(out).toContain("Recent agent waker events");
    expect(out).toContain("Activated");
    expect(out).toContain("today 07:00:00");
    // The raw event name is the debug view's job.
    expect(out).not.toContain("agent.activated");
  });

  it("names a limit the way status does", async () => {
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

    const { out } = await invoke(["logs"], { now: at("07:05") });

    expect(out).toContain("Usage window limited");
    expect(out).toContain("next check today 08:24");
  });

  it("can be pointed at one agent", async () => {
    await writeConfig();
    await invoke(["tick"], { now: at("07:00") });

    const { out } = await invoke(["logs", "codex"], { now: at("07:05") });

    expect(out).toContain("codex");
    expect(out).not.toContain("claude");
  });

  it("refuses an agent it does not have", async () => {
    await writeConfig();

    const { code, err } = await invoke(["logs", "gemini"]);

    // Silently showing everything would be the worst of both.
    expect(code).toBe(EXIT.usage);
    expect(err).toContain("gemini");
  });

  it("says so when an agent has no events of its own", async () => {
    await writeConfig();
    await invoke(["run", "claude"], { now: at("07:00") });

    const { out } = await invoke(["logs", "codex"]);

    expect(out).toContain("No events yet for codex");
  });

  it("keeps no-op ticks out of the default view", async () => {
    await writeConfig(`${CONFIG}logging:\n  level: debug\n`);
    await invoke(["tick"], { now: at("05:00") });

    const plain = await invoke(["logs"]);
    const debug = await invoke(["logs", "--debug"]);

    // Written, so `--debug` can show it; not shown by default, because a
    // minute-level scheduler would bury everything else (UX §14).
    expect(plain.out).toContain("No events yet");
    expect(debug.out).toContain("scheduler.tick");
  });

  it("explains a recovered state file in the default view", async () => {
    await writeConfig();
    await invoke(["tick"], { now: at("07:00") });
    await invoke(["tick"], { now: at("07:30") });
    await writeFile(
      join(home, ".local", "state", "agent-waker", "state.json"),
      "broken",
    );
    await invoke(["tick"], { now: at("09:00") });

    const { out } = await invoke(["logs"], { now: at("09:05") });

    expect(out).toContain("State recovered from the backup copy");
  });

  it("shows the raw record under --debug", async () => {
    await writeConfig();
    await invoke(["tick"], { now: at("07:00") });

    const { out } = await invoke(["logs", "--debug"], { now: at("07:05") });

    expect(out).toContain("agent.activated");
    expect(out).toContain("INFO");
    expect(out).toContain("durationMs=");
  });

  it("takes a limit", async () => {
    await writeConfig();
    await invoke(["tick"], { now: at("07:00") });

    const { out } = await invoke(["logs", "--limit", "1", "--debug"]);

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

    const { out } = await invoke(["logs", "--debug"]);

    expect(out).toContain("cleared your screen");
    expect(out).not.toMatch(ANSI);
  });

  it("neutralises a hand-edited log file", async () => {
    // The default view no longer runs every field through the renderer, so an
    // event name it does not recognise is printed as-is. A log file is a file:
    // anything could be in it, and it is on its way to a terminal.
    await writeConfig();
    await mkdir(join(home, ".local", "state", "agent-waker", "logs"), {
      recursive: true,
    });
    await writeFile(
      join(
        home,
        ".local",
        "state",
        "agent-waker",
        "logs",
        "events-2026-09-07.jsonl",
      ),
      `${JSON.stringify({
        timestamp: "2026-09-07T05:00:00.000Z",
        level: "info",
        event: "\u001b[2Jmade.up.event",
        runtime: "local",
        fields: { reason: "\u001b[31mred", nextAttemptAt: "not a date" },
      })}\n`,
    );

    const { out } = await invoke(["logs"], { now: at("07:05") });

    expect(out).toContain("made.up.event");
    expect(out).not.toMatch(ANSI);
  });

  it("accepts a limit without mistaking it for an agent", async () => {
    // `logs` now takes agent positionals, so the option's value must not be
    // read as one.
    await writeConfig();
    await invoke(["tick"], { now: at("07:00") });

    expect((await invoke(["logs", "--limit", "5"])).code).toBe(EXIT.ok);
    expect((await invoke(["logs", "claude", "codex"])).code).toBe(EXIT.ok);
  });

  it("keeps provider text out of the default view entirely", async () => {
    await writeConfig();
    await invoke(["tick"], {
      now: at("07:00"),
      scripts: {
        codex: {
          probe: [{ kind: "unknown", detail: "something the provider said" }],
        },
      },
    });

    const { out } = await invoke(["logs"]);

    expect(out).not.toContain("something the provider said");
    expect(out).toContain("Unrecognised response");
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

  it("reports that state can be written", async () => {
    await writeConfig();

    expect((await invoke(["doctor"])).out).toContain("state can be written");
  });

  it("says so when state cannot be written", async () => {
    await writeConfig();
    // A tick that cannot save has spent a provider turn and lost the record.
    const stateDir = join(home, ".local", "state", "agent-waker");

    await mkdir(stateDir, { recursive: true });
    await chmod(stateDir, 0o500);

    try {
      const { out, code } = await invoke(["doctor"]);

      expect(out).toContain("state cannot be written");
      expect(out).toContain("activated more than once a day");
      expect(code).toBe(EXIT.partial);
    } finally {
      // Otherwise the temporary home cannot be removed.
      await chmod(stateDir, 0o700);
    }
  });

  it("does not create the directory it is asking about", async () => {
    await writeConfig();

    await invoke(["doctor"]);

    // A diagnostic that creates what it inspects is reporting on a machine it
    // just changed — and recursive mkdir would make ~/.local on the way.
    await expect(stat(join(home, ".local"))).rejects.toThrow();
  });

  it("names a flag the provider no longer offers", async () => {
    await writeConfig();

    const { out, code } = await invoke(["doctor", "codex"], {
      scripts: { codex: { smoke: ["--ephemeral"] } },
    });

    expect(out).toContain("the activation command may have changed");
    expect(out).toContain("not offered: --ephemeral");
    expect(code).toBe(EXIT.partial);
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

  it("records the resolved XDG locations when installing and repairing", async () => {
    const env = {
      XDG_CONFIG_HOME: join(home, "custom-config"),
      XDG_STATE_HOME: join(home, "custom-state"),
      XDG_CACHE_HOME: join(home, "custom-cache"),
      XDG_DATA_HOME: join(home, "custom-data"),
    };
    for (const argv of [
      ["init", "--agents", "none"],
      ["init", "--repair"],
    ]) {
      expect((await setUp(argv, { env, now: at("06:00") })).code).toBe(EXIT.ok);
      const launcher = await readFile(
        join(env.XDG_DATA_HOME, "agent-waker", "bin", "agent-waker-runner"),
        "utf8",
      );
      for (const [name, value] of Object.entries(env)) {
        expect(launcher).toContain(`export ${name}='${value}'`);
      }
    }
  });

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
      answers: ["claude, codex", "America/New_York", "06:30"],
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

  it("says what it is and what it will not do", async () => {
    const { out } = await setUp(["init", "--time", "07:00"], {
      now: at("06:00"),
    });

    expect(out).toContain("Keep coding-agent subscription windows aligned");
    expect(out).toContain("does not install agents");
    // The thing users actually worry about (UX §6.7).
    expect(out).toContain("agents are only contacted when one is actually due");
  });

  it("explains deferment before the first one happens", async () => {
    const { out } = await setUp(["init", "--time", "07:00"], {
      now: at("06:00"),
    });

    // Otherwise the first deferred morning reads as a failure (UX §2.3).
    expect(out).toContain("still limited at 07:00");
    expect(out).toContain("up to 5 hours");
  });

  it("offers only the agents that are ready", async () => {
    const { questions } = await setUp(["init", "--time", "07:00"], {
      now: at("06:00"),
      answers: ["", "Europe/Rome"],
      scripts: { codex: { detect: [{ installed: false, health: "unknown" }] } },
    });

    // An agent that cannot work would fail every morning until somebody
    // noticed, so it is not selected by default (UX §6.4).
    expect(questions[0]).toContain("Which agents");

    const written = parseConfig(await configFile(), "config.yaml");

    expect(written.agents.codex.enabled).toBe(false);
    expect(written.agents.claude.enabled).toBe(true);
  });

  it("takes the agents the user names, not the ones that are ready", async () => {
    // A user about to sign in knows something detection does not.
    await setUp(["init", "--time", "07:00"], {
      now: at("06:00"),
      answers: ["codex", "Europe/Rome"],
      scripts: { codex: { detect: [{ installed: false, health: "unknown" }] } },
    });

    const written = parseConfig(await configFile(), "config.yaml");

    expect(written.agents.codex.enabled).toBe(true);
    expect(written.agents.claude.enabled).toBe(false);
  });

  it("accepts none of them", async () => {
    await setUp(["init", "--time", "07:00"], {
      now: at("06:00"),
      answers: ["none", "Europe/Rome"],
    });

    const written = parseConfig(await configFile(), "config.yaml");

    expect(written.agents.claude.enabled).toBe(false);
    expect(written.agents.codex.enabled).toBe(false);
  });

  it("asks again rather than starting over after a typo", async () => {
    const { code, err } = await setUp(["init", "--time", "07:00"], {
      now: at("06:00"),
      answers: ["gemini", "codex", "Europe/Rome"],
    });

    // This is the first prompt of the onboarding; a typo should not send the
    // user back to the beginning of it.
    expect(err).toContain("gemini");
    expect(code).toBe(EXIT.ok);
    expect(await configFile()).toMatch(/codex:\n {4}enabled: true/);
  });

  it("gives up rather than spinning on an answer that never parses", async () => {
    const { code } = await setUp(["init"], {
      now: at("06:00"),
      answers: ["gemini", "gemini", "gemini", "gemini"],
    });

    expect(code).toBe(EXIT.failed);
  });

  it("takes the agents from the command line, so a script need not answer", async () => {
    // Previously `init --time X --timezone Y` asked nothing; the new prompt
    // would have blocked a bootstrap run in a terminal.
    const { questions } = await setUp(
      [
        "init",
        "--time",
        "07:00",
        "--timezone",
        "Europe/Rome",
        "--agents",
        "codex",
      ],
      { now: at("06:00"), answers: [] },
    );

    expect(questions).toEqual([]);

    const written = parseConfig(await configFile(), "config.yaml");

    expect(written.agents.codex.enabled).toBe(true);
    expect(written.agents.claude.enabled).toBe(false);
  });

  it("accepts a name in the case the user typed it", async () => {
    await setUp(["init", "--time", "07:00", "--agents", "Claude"], {
      now: at("06:00"),
    });

    expect(
      parseConfig(await configFile(), "config.yaml").agents.claude.enabled,
    ).toBe(true);
  });

  it("does not reconsider a choice already made", async () => {
    // A second `init` is a user changing a time, not asking to have an agent
    // they disabled switched back on.
    await writeConfig(`${CONFIG}agents:\n  codex:\n    enabled: false\n`);

    const { questions } = await setUp(["init", "--time", "06:45"], {
      now: at("03:00"),
      answers: ["", "Europe/Rome"],
    });

    expect(questions[0]).toContain("(claude)");
    expect(await configFile()).toContain("enabled: false");
  });

  it("never activates an agent the user just excluded", async () => {
    // The catch-up run used the configuration loaded before init wrote the
    // file, so an agent excluded thirty seconds earlier was contacted anyway
    // — a real provider turn against an answer already given.
    const { code } = await setUp(["init", "--time", "07:00"], {
      now: at("09:00"),
      answers: ["codex", "Europe/Rome", "y"],
    });

    expect(code).toBe(EXIT.ok);

    const state = JSON.parse(await stateFile()) as {
      agents: Record<string, { phase: string }>;
    };

    expect(state.agents.codex?.phase).toBe("activated");
    expect(state.agents.claude?.phase).toBe("idle");
  });

  it("activates nothing when the user excluded everything", async () => {
    await setUp(["init", "--time", "07:00", "--agents", "none"], {
      now: at("09:00"),
      answers: ["Europe/Rome", "y"],
    });

    const state = JSON.parse(await stateFile()) as {
      agents: Record<string, { phase: string }>;
    };

    expect(state.agents.claude?.phase).toBe("idle");
    expect(state.agents.codex?.phase).toBe("idle");
  });

  it("reports what it wrote, whatever shape the file is in", async () => {
    // Flow style parses fine, and greping the text for a block-style line
    // reported the opposite of the truth.
    await writeConfig(
      `${CONFIG}agents: { claude: { enabled: true }, codex: { enabled: false } }\n`,
    );

    const { out } = await setUp(["init", "--time", "07:00"], {
      now: at("03:00"),
    });

    expect(out).toMatch(/Fake codex\s+disabled/);
    expect(out).toMatch(/Fake claude\s+enabled/);
  });

  it("edits an agent that was written with no settings under it", async () => {
    // `claude:` with nothing after it is a null scalar. It parses, and it used
    // to abort init with raw YAML internals — no config, no scheduler.
    await writeConfig(
      `${CONFIG}agents:\n  claude:\n  codex:\n    enabled: true\n`,
    );

    const { code } = await setUp(["init", "--time", "06:45"], {
      now: at("03:00"),
    });

    expect(code).toBe(EXIT.ok);
    expect(
      parseConfig(await configFile(), "config.yaml").schedule.notBefore,
    ).toEqual({ hour: 6, minute: 45 });
  });

  it("says when the next decision point is", async () => {
    const { out } = await setUp(["init", "--time", "07:00"], {
      now: at("06:00"),
    });

    expect(out).toContain("Next decision point:");
    expect(out).toContain("today 07:00");
  });

  it("reports the earliest window when an agent sets its own time", async () => {
    // `notBefore` can be set per agent, so the next thing that happens is not
    // necessarily the global time, nor the first-listed agent's.
    await writeConfig(
      `${CONFIG}agents:\n  claude:\n    enabled: true\n  codex:\n    enabled: true\n    schedule:\n      notBefore: "06:30"\n`,
    );

    const { out } = await setUp(["init", "--time", "09:00"], {
      now: at("05:00"),
    });

    expect(out).toContain("today 06:30");
  });

  it("offers to catch up when the morning has already passed", async () => {
    const { questions } = await setUp(["init", "--time", "07:00"], {
      now: at("09:00"),
      answers: ["claude, codex", "Europe/Rome", "y"],
    });

    expect(questions.at(-1)).toContain("already past today's activation time");
    expect(await stateFile()).toContain('"phase": "activated"');
  });

  it("leaves the morning alone when the answer is no", async () => {
    await setUp(["init", "--time", "07:00"], {
      now: at("09:00"),
      answers: ["claude, codex", "Europe/Rome", "n"],
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

  it("does not remove a lock or configuration while a tick is running", async () => {
    await writeConfig();
    const directory = join(home, ".local", "state", "agent-waker");
    const store = createStateStore(directory);
    await store.withLock(async () => {
      const before = await stat(join(directory, "lock"));
      expect(
        (await invoke(["uninstall", "--yes"], { runner: removes })).code,
      ).toBe(EXIT.failed);
      expect((await stat(join(directory, "lock"))).ino).toBe(before.ino);
      expect(await configFile()).toContain("version: 1");
    });
  });

  it.each(["nested", "..nested"])(
    "refuses cache cleanup when the state directory is inside %s",
    async (name) => {
      await writeConfig();
      const env = {
        XDG_STATE_HOME: join(home, ".cache", "agent-waker", "work", name),
      };
      expect((await invoke(["tick"], { env, now: at("07:00") })).code).toBe(
        EXIT.ok,
      );
      const { code, err } = await invoke(["uninstall", "--yes"], {
        env,
        runner: removes,
      });
      expect(code).toBe(EXIT.failed);
      expect(err).toContain("state directory is inside");
      await expect(configFile()).resolves.toContain("version: 1");
    },
  );

  it("preserves the lock and retained logs when XDG directories coincide", async () => {
    await writeConfig();
    const env = {
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".config"),
    };
    expect((await invoke(["tick"], { env, now: at("07:00") })).code).toBe(
      EXIT.ok,
    );
    const directory = join(home, ".config", "agent-waker");
    const before = await stat(join(directory, "lock"));
    expect(
      (await invoke(["uninstall", "--yes"], { env, runner: removes })).code,
    ).toBe(EXIT.ok);
    expect((await stat(join(directory, "lock"))).ino).toBe(before.ino);
    await expect(stat(join(directory, "logs"))).resolves.toBeDefined();
    await expect(configFile()).rejects.toThrow();
  });

  it("keeps the lock inode after uninstall so existing openers stay synchronized", async () => {
    await writeConfig();
    await invoke(["tick"], { now: at("07:00") });
    const lock = join(home, ".local", "state", "agent-waker", "lock");
    const before = await stat(lock);
    expect(
      (await invoke(["uninstall", "--yes", "--logs"], { runner: removes }))
        .code,
    ).toBe(EXIT.ok);
    expect((await stat(lock)).ino).toBe(before.ino);
  });

  it("works when there was never a configuration", async () => {
    const { code } = await invoke(["uninstall", "--yes"], { runner: removes });

    expect(code).toBe(EXIT.ok);
  });
});
