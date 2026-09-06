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
import { createProcessRunner } from "#src/process/runner.js";
import { createStateStore } from "#src/state/store.js";
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

interface Harness {
  run: (
    now: number,
    options?: { only?: AgentId[]; force?: boolean },
  ) => Promise<TickResult>;
  adapters: Record<AgentId, ReturnType<typeof createFakeAdapter>>;
  events: () => Promise<string[]>;
}

const harness = (
  scripts: Partial<Record<AgentId, FakeScript>> = {},
  configuration = config(),
): Harness => {
  const adapters = {
    claude: createFakeAdapter("claude", scripts.claude ?? {}),
    codex: createFakeAdapter("codex", scripts.codex ?? {}),
  };
  const store = createStateStore(join(directory, "state"));
  const log = createEventLog({ directory: join(directory, "logs") });

  return {
    adapters,
    run: (now, options = {}) =>
      tick(
        {
          config: configuration,
          store,
          registry: createRegistry([adapters.claude, adapters.codex]),
          log,
          runner: createProcessRunner(),
          workDir: directory,
          runtime: "local",
          now: () => now,
        },
        options,
      ),
    events: async () =>
      (await readRecentEvents(join(directory, "logs"), 100)).map(
        (event) => event.event,
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
      runner: createProcessRunner(),
      workDir: directory,
      runtime: "local",
      now: () => at("07:00"),
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
    const test = harness({}, config("agents:\n  codex:\n    enabled: false\n"));

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
