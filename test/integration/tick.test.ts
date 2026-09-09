import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRegistry } from "#src/adapters/registry.js";
import { parseConfig, type AgentWakerConfig } from "#src/config/config.js";
import type { AgentId } from "#src/core/agent.js";
import type { AgentObservation } from "#src/core/observation.js";
import { tick, type TickResult } from "#src/core/orchestrator.js";
import { createEventLog, readRecentEvents } from "#src/logging/log.js";
import {
  createProcessRunner,
  type ProcessResult,
  type ProcessRunner,
} from "#src/process/runner.js";
import { createStateStore } from "#src/state/store.js";
import {
  NO_TELEMETRY,
  type Span,
  type Telemetry,
} from "#src/telemetry/otlp.js";
import { createFakeAdapter, type FakeScript } from "../support/fake-adapter.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-waker-tick-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const utc = (iso: string): number => Date.parse(iso);

/** Local wall-clock time on 2026-09-07, a CEST day in Europe/Rome. */
const at = (localTime: string, day = "07"): number =>
  utc(`2026-09-${day}T${localTime}:00.000Z`) - 2 * 3_600_000;

const config = (yaml = ""): AgentWakerConfig =>
  parseConfig(`version: 1\ntimezone: Europe/Rome\n${yaml}`, "config.yaml");

/** A span as a test can look at it, once it has been closed. */
interface RecordedSpan {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
  /** Events attached to this span, which is the linkage worth asserting. */
  readonly logs: string[];
  error?: string;
  ended: boolean;
}

interface Recorder extends Telemetry {
  readonly spans: RecordedSpan[];
  readonly logged: { event: string; level: string }[];
}

/** Telemetry that keeps what it was given, rather than sending it anywhere. */
function recorder(): Recorder {
  const spans: RecordedSpan[] = [];
  const logged: { event: string; level: string }[] = [];

  const open = (
    name: string,
    attributes: Readonly<Record<string, unknown>> = {},
  ): Span => {
    const recorded: RecordedSpan = {
      name,
      attributes: { ...attributes },
      logs: [],
      ended: false,
    };

    spans.push(recorded);

    return {
      span: (childName, childAttributes) => open(childName, childAttributes),
      log: (event) => {
        recorded.logs.push(event.event);
        logged.push({ event: event.event, level: event.level });
      },
      end: (options = {}) => {
        Object.assign(recorded.attributes, options.attributes ?? {});
        recorded.ended = true;

        if (options.error !== undefined) recorded.error = options.error;
      },
    };
  };

  return {
    spans,
    logged,
    span: (name, attributes) => open(name, attributes),
    log: (event) => logged.push({ event: event.event, level: event.level }),
    flush: () => Promise.resolve(undefined),
  };
}

interface Harness {
  run: (
    now: number,
    options?: { only?: AgentId[]; force?: boolean },
  ) => Promise<TickResult>;
  adapters: Record<AgentId, ReturnType<typeof createFakeAdapter>>;
  events: () => Promise<string[]>;
  levels: () => Promise<Record<string, string>>;
  telemetry: Recorder;
}

interface HarnessOptions {
  readonly config?: AgentWakerConfig;
  readonly runner?: ProcessRunner;
}

const harness = (
  scripts: Partial<Record<AgentId, FakeScript>> = {},
  {
    config: configuration = config(),
    runner = createProcessRunner(),
  }: HarnessOptions = {},
): Harness => {
  const adapters = {
    claude: createFakeAdapter("claude", scripts.claude ?? {}),
    codex: createFakeAdapter("codex", scripts.codex ?? {}),
  };
  const store = createStateStore(join(directory, "state"));
  const log = createEventLog({ directory: join(directory, "logs") });
  const telemetry = recorder();
  // Advances a millisecond per read, so a measured duration is non-zero and
  // still deterministic.
  let ticks = 0;

  return {
    adapters,
    telemetry,
    run: (now, options = {}) =>
      tick(
        {
          config: configuration,
          store,
          registry: createRegistry([adapters.claude, adapters.codex]),
          log,
          telemetry,
          runner,
          workDir: directory,
          runtime: "local",
          now: () => now,
          wallClock: () => (ticks += 1),
        },
        options,
      ),
    events: async () =>
      (await readRecentEvents(join(directory, "logs"), 100)).map(
        (event) => event.event,
      ),
    levels: async () =>
      Object.fromEntries(
        (await readRecentEvents(join(directory, "logs"), 100)).map((event) => [
          event.event,
          event.level,
        ]),
      ),
  };
};

const phases = (result: TickResult): Record<string, string> =>
  Object.fromEntries(result.agents.map((a) => [a.agentId, a.phase]));

const blockedWith = (
  resetAt: number | undefined,
  reason: "rolling_window" | "weekly_limit" = "rolling_window",
): AgentObservation => ({
  kind: "blocked",
  reason,
  constraints: [
    resetAt === undefined
      ? { type: "rolling_window", confidence: "high" }
      : { type: "rolling_window", resetAt, confidence: "high" },
  ],
});

describe("scenario A — both agents available", () => {
  it("activates each agent once and does no more that day", async () => {
    const test = harness();

    expect(phases(await test.run(at("07:00")))).toEqual({
      claude: "activated",
      codex: "activated",
    });

    const later = await test.run(at("09:00"));

    expect(phases(later)).toEqual({ claude: "activated", codex: "activated" });
    expect(test.adapters.claude.calls.activate).toBe(1);
    expect(test.adapters.codex.calls.activate).toBe(1);
  });

  it("does nothing at all before notBefore", async () => {
    const test = harness();
    const result = await test.run(at("06:59"));

    expect(test.adapters.claude.calls.detect).toBe(0);
    expect(result.agents.every((agent) => agent.skipped === "not_due")).toBe(
      true,
    );
  });

  it("opens a new cycle the following day", async () => {
    const test = harness();

    await test.run(at("07:00"));

    expect(phases(await test.run(at("07:00", "08")))).toEqual({
      claude: "activated",
      codex: "activated",
    });
    expect(test.adapters.claude.calls.activate).toBe(2);
  });
});

describe("scenario B — a known reset", () => {
  it("waits until the reset plus the grace, and calls nothing before then", async () => {
    const test = harness({
      codex: { probe: [blockedWith(at("08:23")), { kind: "available" }] },
    });

    const first = await test.run(at("07:00"));

    expect(phases(first)).toMatchObject({
      claude: "activated",
      codex: "waiting_known_reset",
    });
    expect(
      first.agents.find((agent) => agent.agentId === "codex")?.nextAttemptAt,
    ).toBe(at("08:24"));

    // Nothing between 07:00 and 08:24 may touch the provider.
    await test.run(at("07:30"));
    await test.run(at("08:23"));

    expect(test.adapters.codex.calls.probe).toBe(1);

    expect(phases(await test.run(at("08:24")))).toMatchObject({
      codex: "activated",
    });
  });
});

describe("scenario C — an unknown reset", () => {
  it("walks the ladder and ends in a long-term block", async () => {
    const test = harness({ claude: { probe: [blockedWith(undefined)] } });
    const schedule = [
      "07:00",
      "07:05",
      "07:15",
      "07:30",
      "08:00",
      "09:00",
      "10:00",
      "11:00",
    ];

    for (const now of schedule) {
      expect(phases(await test.run(at(now)))).toMatchObject({
        claude: "waiting_unknown_reset",
      });
    }

    expect(phases(await test.run(at("12:00")))).toMatchObject({
      claude: "long_term_block",
    });
    expect(test.adapters.claude.calls.probe).toBe(schedule.length + 1);
  });
});

describe("scenario D — a weekly limit", () => {
  it("waits for the later reset and schedules no short retry", async () => {
    const monday = utc("2026-09-14T12:00:00.000Z");
    const test = harness({
      claude: {
        probe: [
          {
            kind: "blocked",
            reason: "weekly_limit",
            constraints: [
              {
                type: "rolling_window",
                resetAt: at("08:23"),
                confidence: "high",
              },
              { type: "weekly", resetAt: monday, confidence: "high" },
            ],
          },
        ],
      },
    });

    const result = await test.run(at("07:00"));
    const claude = result.agents.find((agent) => agent.agentId === "claude");

    expect(claude?.phase).toBe("waiting_known_reset");
    expect(claude?.nextAttemptAt).toBe(monday + 60_000);
  });

  it("carries the wait across the days in between", async () => {
    const monday = utc("2026-09-14T12:00:00.000Z");
    const test = harness({
      claude: {
        probe: [
          {
            kind: "blocked",
            reason: "weekly_limit",
            constraints: [
              { type: "weekly", resetAt: monday, confidence: "high" },
            ],
          },
        ],
      },
    });

    await test.run(at("07:00"));

    // Tuesday and Wednesday mornings open new cycles but must not re-probe.
    await test.run(at("07:00", "08"));
    await test.run(at("07:00", "09"));

    expect(test.adapters.claude.calls.probe).toBe(1);
  });
});

describe("scenario E — the laptop was asleep", () => {
  it("runs the overdue attempt on the next tick", async () => {
    const test = harness({
      claude: { probe: [blockedWith(at("08:23")), { kind: "available" }] },
    });

    await test.run(at("07:00"));

    // Asleep from 08:20, awake at 09:13. The attempt is overdue, not missed.
    expect(phases(await test.run(at("09:13")))).toMatchObject({
      claude: "activated",
    });
  });
});

describe("scenario F — a broken install", () => {
  it("reports unhealthy without starting a quota backoff", async () => {
    const test = harness({
      codex: {
        detect: [
          {
            installed: true,
            health: "broken",
            executable: "/usr/local/bin/codex",
          },
        ],
      },
    });

    const result = await test.run(at("07:00"));
    const codex = result.agents.find((agent) => agent.agentId === "codex");

    expect(codex?.phase).toBe("unhealthy");
    // Never asked the provider anything, so nothing looks like exhaustion.
    expect(test.adapters.codex.calls.probe).toBe(0);
    expect(test.adapters.codex.calls.activate).toBe(0);
    // An hour away, not five.
    expect(codex?.nextAttemptAt).toBe(at("08:00"));
  });

  it("reports an agent that is not installed at all", async () => {
    const test = harness({
      codex: { detect: [{ installed: false, health: "unknown" }] },
    });

    expect(phases(await test.run(at("07:00")))).toMatchObject({
      codex: "unhealthy",
    });
  });
});

describe("scenario G — an API key instead of a subscription", () => {
  it("refuses to activate and never sends a billable request", async () => {
    const test = harness({
      claude: {
        auth: [
          {
            authenticated: true,
            mode: "api_key",
            supportsIntent: false,
            message: "API key configured",
          },
        ],
      },
    });

    const result = await test.run(at("07:00"));
    const claude = result.agents.find((agent) => agent.agentId === "claude");

    expect(claude?.phase).toBe("auth_required");
    expect(claude?.reason).toBe("api_billing_only");
    expect(test.adapters.claude.calls.activate).toBe(0);
  });

  it("refuses a cloud-provider credential the same way", async () => {
    // Bedrock or Vertex answers, and bills, but does not touch the
    // subscription window the user is trying to keep warm.
    const test = harness({
      claude: {
        auth: [
          {
            authenticated: true,
            mode: "cloud_provider",
            supportsIntent: false,
          },
        ],
      },
    });

    const claude = (await test.run(at("07:00"))).agents.find(
      (agent) => agent.agentId === "claude",
    );

    expect(claude?.reason).toBe("unsupported_auth");
    expect(test.adapters.claude.calls.activate).toBe(0);
  });

  it("distinguishes not being logged in", async () => {
    const test = harness({
      claude: {
        auth: [{ authenticated: false, mode: "none", supportsIntent: false }],
      },
    });

    expect(
      (await test.run(at("07:00"))).agents.find((a) => a.agentId === "claude")
        ?.reason,
    ).toBe("not_authenticated");
  });
});

describe("scenario H — a delayed scheduled run", () => {
  it("treats a late attempt as due rather than invalid", async () => {
    const test = harness({
      claude: { probe: [blockedWith(at("08:23")), { kind: "available" }] },
    });

    await test.run(at("07:00"));

    expect(phases(await test.run(at("08:28")))).toMatchObject({
      claude: "activated",
    });
  });
});

describe("independent agents", () => {
  it("does not let one agent's block hold up the other", async () => {
    const test = harness({
      claude: { probe: [blockedWith(undefined)] },
    });

    expect(phases(await test.run(at("07:00")))).toEqual({
      claude: "waiting_unknown_reset",
      codex: "activated",
    });
  });

  it("keeps going when one adapter throws", async () => {
    const test = harness({
      claude: { detect: [new Error("adapter exploded")] },
    });

    expect(phases(await test.run(at("07:00")))).toEqual({
      claude: "unhealthy",
      codex: "activated",
    });
  });
});

describe("probe modes", () => {
  it("skips the probe when activation is the probe", async () => {
    const test = harness({
      claude: { probeMode: "activation_is_probe" },
    });

    await test.run(at("07:00"));

    expect(test.adapters.claude.calls.probe).toBe(0);
    expect(test.adapters.claude.calls.activate).toBe(1);
  });

  it("activates when an adapter declares a probe it does not implement", async () => {
    // A contract slip, not a user's problem: activating is what the other
    // probe mode does anyway, so the tick proceeds rather than stalling.
    const base = createFakeAdapter("claude", {
      probeMode: "activation_is_probe",
    });
    const store = createStateStore(join(directory, "state"));
    const result = await tick({
      config: config(),
      store,
      registry: createRegistry([
        { ...base, capabilities: { probeMode: "separate" } },
        createFakeAdapter("codex"),
      ]),
      log: createEventLog({ directory: join(directory, "logs") }),
      telemetry: NO_TELEMETRY,
      runner: createProcessRunner(),
      workDir: directory,
      runtime: "local",
      now: () => at("07:00"),
      wallClock: Date.now,
    });

    expect(phases(result)).toMatchObject({ claude: "activated" });
  });

  it("takes a block reported by the activation itself", async () => {
    const test = harness({
      claude: {
        probeMode: "activation_is_probe",
        activate: [blockedWith(at("08:23"))],
      },
    });

    expect(phases(await test.run(at("07:00")))).toMatchObject({
      claude: "waiting_known_reset",
    });
  });
});

describe("disabled agents", () => {
  it("is left alone entirely", async () => {
    const test = harness(
      {},
      { config: config("agents:\n  codex:\n    enabled: false\n") },
    );

    const result = await test.run(at("07:00"));

    expect(
      result.agents.find((agent) => agent.agentId === "codex")?.skipped,
    ).toBe("disabled");
    expect(test.adapters.codex.calls.detect).toBe(0);
  });
});

describe("run now", () => {
  it("evaluates immediately, before the cycle would have opened", async () => {
    const test = harness();

    expect(
      phases(await test.run(at("05:00"), { only: ["claude"], force: true })),
    ).toMatchObject({ claude: "activated" });
    expect(test.adapters.codex.calls.detect).toBe(0);
  });

  it("still honours what the provider says", async () => {
    // Forcing skips the timer, not the rate limit.
    const test = harness({ claude: { probe: [blockedWith(at("08:23"))] } });

    expect(
      phases(await test.run(at("07:30"), { only: ["claude"], force: true })),
    ).toMatchObject({ claude: "waiting_known_reset" });
    expect(test.adapters.claude.calls.activate).toBe(0);
  });

  it("does not activate twice in one day", async () => {
    const test = harness();

    await test.run(at("07:00"));
    await test.run(at("09:00"), { only: ["claude"], force: true });

    expect(test.adapters.claude.calls.activate).toBe(1);
  });
});

describe("persistence", () => {
  it("survives being restarted between ticks", async () => {
    const first = harness({ claude: { probe: [blockedWith(at("08:23"))] } });

    await first.run(at("07:00"));

    // A brand new process, reading the same directory.
    const second = harness({ claude: { probe: [{ kind: "available" }] } });

    await second.run(at("07:30"));

    expect(second.adapters.claude.calls.probe).toBe(0);
  });

  it("writes state a person can read", async () => {
    const test = harness();

    await test.run(at("07:00"));

    expect(
      await readFile(join(directory, "state", "state.json"), "utf8"),
    ).toContain('"phase": "activated"');
  });

  it("declines to run while another tick holds the lock", async () => {
    const test = harness();
    const store = createStateStore(join(directory, "state"));

    await store.withLock(async () => {
      await expect(test.run(at("07:00"))).rejects.toThrow(/in progress/);
    });
  });
});

/**
 * A runner that answers without starting anything.
 *
 * Scripted like the fake adapter: one answer per call, the last repeating. An
 * `Error` in the list is thrown rather than returned, which is what a runner
 * that cannot start a process does.
 */
const stubRunner = (
  ...answers: readonly (Partial<ProcessResult> | Error | string)[]
): ProcessRunner => {
  let index = -1;

  return {
    run: () => {
      index += 1;

      const answer = answers[Math.min(index, answers.length - 1)] ?? {};

      if (answer instanceof Error || typeof answer === "string") {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a runner may throw anything, and that is the case under test
        return Promise.reject(answer);
      }

      return Promise.resolve({
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: { stdout: false, stderr: false },
        durationMs: 3,
        ...answer,
      });
    },
  };
};

describe("telemetry", () => {
  const spanNames = (test: Harness): string[] =>
    test.telemetry.spans.map((span) => span.name);

  const named = (test: Harness, name: string): RecordedSpan | undefined =>
    test.telemetry.spans.find((span) => span.name === name);

  it("traces the tick, each agent, and each provider call", async () => {
    const test = harness(
      { claude: { exec: ["/usr/local/bin/fake"] } },
      { runner: stubRunner({ exitCode: 0 }) },
    );

    await test.run(at("07:00"));

    expect(spanNames(test)).toEqual([
      "agent_waker.tick",
      "agent.activation",
      "provider.exec",
      "agent.activation",
    ]);
    expect(test.telemetry.spans.every((span) => span.ended)).toBe(true);
    expect(named(test, "agent_waker.tick")?.attributes).toMatchObject({
      "agent_waker.runtime": "local",
      "agent_waker.forced": false,
      "agent_waker.agents_evaluated": 2,
    });
  });

  it("puts the provider's exit code and duration on the span", async () => {
    const test = harness(
      { claude: { exec: ["/usr/local/bin/fake"] } },
      { runner: stubRunner({ exitCode: 3, durationMs: 42 }) },
    );

    await test.run(at("07:00"));

    expect(named(test, "provider.exec")?.attributes).toMatchObject({
      "process.executable.path": "/usr/local/bin/fake",
      "process.exit_code": 3,
      "process.duration_ms": 42,
    });
  });

  it("records a timeout and a signal, which is what a hung provider looks like", async () => {
    const test = harness(
      { claude: { exec: ["/usr/local/bin/fake"] } },
      {
        runner: stubRunner({
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
        }),
      },
    );

    await test.run(at("07:00"));

    expect(named(test, "provider.exec")?.attributes).toMatchObject({
      "process.signal": "SIGTERM",
      "process.timed_out": true,
    });
  });

  it("marks a provider that could not be started", async () => {
    const test = harness(
      { claude: { exec: ["/usr/local/bin/fake"] } },
      { runner: stubRunner({ exitCode: null, startFailure: "ENOENT" }) },
    );

    await test.run(at("07:00"));

    expect(named(test, "provider.exec")?.attributes).toMatchObject({
      "process.start_failure": "ENOENT",
    });
    expect(named(test, "provider.exec")?.error).toBe("ENOENT");
  });

  it("closes the span when the runner itself throws", async () => {
    const test = harness(
      { claude: { exec: ["/usr/local/bin/fake"] } },
      { runner: stubRunner(new Error("the runner gave up")) },
    );

    await test.run(at("07:00"));

    expect(named(test, "provider.exec")).toMatchObject({
      ended: true,
      error: "the runner gave up",
    });
    // An adapter that throws is a runtime problem, never a usage limit.
    expect(named(test, "agent.activation")?.attributes).toMatchObject({
      "agent.phase": "unhealthy",
    });
  });

  it("closes the span when the runner throws something that is not an Error", async () => {
    const test = harness(
      { claude: { exec: ["/usr/local/bin/fake"] } },
      { runner: stubRunner("a bare string, which anything may throw") },
    );

    await test.run(at("07:00"));

    expect(named(test, "provider.exec")).toMatchObject({
      ended: true,
      error: "a bare string, which anything may throw",
    });
  });

  it("marks only what a person has to fix as a failed span", async () => {
    const test = harness({
      claude: { probe: [blockedWith(undefined)] },
      codex: {
        auth: [{ authenticated: false, mode: "none", supportsIntent: false }],
      },
    });

    await test.run(at("07:00"));

    const [deferred, broken] = test.telemetry.spans.filter(
      (span) => span.name === "agent.activation",
    );

    // Deferment is normal, not an error (UX §2.3).
    expect(deferred?.error).toBeUndefined();
    expect(deferred?.attributes).toMatchObject({
      "agent.phase": "waiting_unknown_reset",
    });
    expect(broken?.error).toBeDefined();
  });

  it("attaches every event to the span it came from", async () => {
    const test = harness();

    await test.run(at("07:00"));

    // The tick's own events belong to the root; an agent's belong to that
    // agent's span, which is what makes the trace and the log join up.
    expect(named(test, "agent_waker.tick")?.logs).toEqual(["scheduler.tick"]);
    expect(
      test.telemetry.spans
        .filter((span) => span.name === "agent.activation")
        .map((span) => span.logs),
    ).toEqual([["agent.activated"], ["agent.activated"]]);
  });

  it("has nothing to report when nothing was due", async () => {
    const test = harness();

    expect((await test.run(at("05:00"))).notable).toBe(false);
  });

  it("has something to report when the state file had to be recovered", async () => {
    const test = harness();

    await test.run(at("07:00"));
    // Twice, so the backup itself holds a state whose cycle is complete.
    await test.run(at("07:30"));
    await writeFile(join(directory, "state", "state.json"), "broken", "utf8");

    // Nothing is due at this hour, but a corrupted state file is still worth a
    // network call: it would otherwise reach the local log and nothing else.
    const result = await test.run(at("23:00"));

    expect(result.agents.every((agent) => agent.skipped !== undefined)).toBe(
      true,
    );
    expect(result.notable).toBe(true);
  });

  it("traces a tick where nothing is due", async () => {
    const test = harness();

    await test.run(at("05:00"));

    expect(spanNames(test)).toEqual(["agent_waker.tick"]);
    expect(named(test, "agent_waker.tick")?.attributes).toMatchObject({
      "agent_waker.agents_evaluated": 0,
    });
  });

  it("does not report the exit code of an earlier call for one that threw", async () => {
    const test = harness(
      { claude: { exec: ["/bin/first", "/bin/second"] } },
      { runner: stubRunner({ exitCode: 0 }, new Error("gone")) },
    );

    await test.run(at("07:00"));

    const [activation] = (
      await readRecentEvents(join(directory, "logs"), 100)
    ).filter((event) => event.agent === "claude");

    // The successful `--version` call must not stand in for the activation
    // that never ran.
    expect(activation?.fields.exitCode).toBeUndefined();
  });

  it("leaves a killed provider without an exit code rather than a null one", async () => {
    const test = harness(
      { claude: { exec: ["/usr/local/bin/fake"] } },
      {
        runner: stubRunner({
          exitCode: null,
          signal: "SIGKILL",
          timedOut: true,
        }),
      },
    );

    await test.run(at("07:00"));

    // OTLP has no representation for null, and an empty attribute value is
    // worse than an absent one.
    expect(
      named(test, "provider.exec")?.attributes["process.exit_code"],
    ).toBeUndefined();
  });
});

describe("the event log", () => {
  it("records the tick and what each agent did", async () => {
    const test = harness({ claude: { probe: [blockedWith(undefined)] } });

    await test.run(at("07:00"));

    expect(await test.events()).toEqual([
      "scheduler.tick",
      "agent.waiting_unknown_reset",
      "agent.activated",
    ]);
  });

  it("says nothing at all when nothing was due", async () => {
    const test = harness();

    await test.run(at("05:00"));

    // A minute-level scheduler logging every no-op at info drowns the log it
    // exists to write, so the tick drops to debug.
    expect(await test.events()).toEqual([]);
  });

  it("records how long each agent took, and the provider's exit code", async () => {
    const test = harness(
      { claude: { exec: ["/usr/local/bin/fake"] } },
      { runner: stubRunner({ exitCode: 2 }) },
    );

    await test.run(at("07:00"));

    const [activation] = (
      await readRecentEvents(join(directory, "logs"), 100)
    ).filter((event) => event.agent === "claude");

    expect(activation?.fields).toMatchObject({ exitCode: 2 });
    expect(activation?.fields.durationMs).toEqual(expect.any(Number));
  });

  it("records the provider's own words, which state does not keep", async () => {
    const test = harness({
      claude: {
        probe: [
          {
            kind: "blocked",
            reason: "quota",
            constraints: [{ type: "quota", confidence: "high" }],
            detail: "You've hit your usage limit.",
          },
        ],
      },
    });

    await test.run(at("07:00"));

    const logged = await readRecentEvents(join(directory, "logs"), 100);
    const blocked = logged.find((event) => event.agent === "claude");

    expect(blocked?.fields.detail).toBe("You've hit your usage limit.");

    // The classification is persisted; the message is not.
    expect(
      await readFile(join(directory, "state", "state.json"), "utf8"),
    ).not.toContain("usage limit");
  });

  it("records an unclassified response the same way", async () => {
    const test = harness({
      claude: { probe: [{ kind: "unknown", detail: "something unfamiliar" }] },
    });

    await test.run(at("07:00"));

    const logged = await readRecentEvents(join(directory, "logs"), 100);

    expect(
      logged.find((event) => event.agent === "claude")?.fields.detail,
    ).toBe("something unfamiliar");
  });

  it("warns when the state file had to be recovered from the backup", async () => {
    const test = harness();

    await test.run(at("07:00"));
    await test.run(at("07:30"));
    await writeFile(join(directory, "state", "state.json"), "broken", "utf8");
    await test.run(at("09:00"));

    expect(await test.events()).toContain("state.recovered");
  });

  it("warns that a day may be activated twice when state is unreadable", async () => {
    const test = harness();

    await test.run(at("07:00"));
    await test.run(at("07:30"));

    for (const name of ["state.json", "state.json.bak"]) {
      await writeFile(join(directory, "state", name), "broken", "utf8");
    }

    await test.run(at("09:00"));

    expect(await test.events()).toContain("state.reset");
  });
});

it("saves a successful activation before a log failure can interrupt the tick", async () => {
  const store = createStateStore(join(directory, "state"));
  const claude = createFakeAdapter("claude");
  const codex = createFakeAdapter("codex");
  const context = {
    config: config(),
    store,
    registry: createRegistry([claude, codex]),
    log: {
      write(event: { event: string }) {
        if (event.event === "agent.activated")
          throw new Error("log unavailable");
        return Promise.resolve();
      },
    },
    telemetry: NO_TELEMETRY,
    runner: createProcessRunner(),
    workDir: directory,
    runtime: "local" as const,
    now: () => at("07:00"),
    wallClock: Date.now,
  };
  await expect(tick(context)).rejects.toThrow("log unavailable");
  expect((await store.load()).state.agents.claude.phase).toBe("activated");
  await tick({ ...context, log: { write: () => Promise.resolve() } });
  expect(claude.calls.activate).toBe(1);
  expect(codex.calls.activate).toBe(1);
});
