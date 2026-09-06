import { describe, expect, it } from "vitest";

import { emptyState, type AgentWakerState } from "#src/core/state.js";
import {
  decodeState,
  encodeState,
  InvalidStateError,
} from "#src/state/codec.js";

const utc = (iso: string): number => Date.parse(iso);

const populated: AgentWakerState = {
  version: 1,
  updatedAt: utc("2026-09-06T05:30:01.000Z"),
  agents: {
    claude: {
      phase: "activated",
      cycleDate: "2026-09-06",
      firstAttemptAt: utc("2026-09-06T05:00:02.000Z"),
      lastAttemptAt: utc("2026-09-06T05:00:02.000Z"),
      lastActivationAt: utc("2026-09-06T05:00:04.000Z"),
    },
    codex: {
      phase: "waiting_unknown_reset",
      cycleDate: "2026-09-06",
      reason: "rolling_window",
      firstAttemptAt: utc("2026-09-06T05:00:02.000Z"),
      lastAttemptAt: utc("2026-09-06T05:30:01.000Z"),
      blockedUntil: utc("2026-09-06T06:23:00.000Z"),
      nextAttemptAt: utc("2026-09-06T06:00:00.000Z"),
      retryIndex: 3,
      retryHorizonEndsAt: utc("2026-09-06T10:00:00.000Z"),
    },
  },
};

describe("encodeState", () => {
  it("writes timestamps a human can read", () => {
    // The file is meant to be opened and understood; epoch milliseconds are
    // neither inspectable nor unambiguous about the zone.
    expect(encodeState(populated)).toEqual({
      version: 1,
      updatedAt: "2026-09-06T05:30:01.000Z",
      agents: {
        claude: {
          phase: "activated",
          cycleDate: "2026-09-06",
          firstAttemptAt: "2026-09-06T05:00:02.000Z",
          lastAttemptAt: "2026-09-06T05:00:02.000Z",
          lastActivationAt: "2026-09-06T05:00:04.000Z",
        },
        codex: {
          phase: "waiting_unknown_reset",
          cycleDate: "2026-09-06",
          reason: "rolling_window",
          firstAttemptAt: "2026-09-06T05:00:02.000Z",
          lastAttemptAt: "2026-09-06T05:30:01.000Z",
          blockedUntil: "2026-09-06T06:23:00.000Z",
          nextAttemptAt: "2026-09-06T06:00:00.000Z",
          retryIndex: 3,
          retryHorizonEndsAt: "2026-09-06T10:00:00.000Z",
        },
      },
    });
  });

  it("omits fields that have no value", () => {
    const encoded = encodeState(emptyState()) as { agents: { claude: object } };

    expect(encoded.agents.claude).toEqual({ phase: "idle" });
  });

  it("survives a round trip", () => {
    expect(decodeState(encodeState(populated))).toEqual(populated);
  });

  it("survives a round trip through JSON", () => {
    expect(
      decodeState(JSON.parse(JSON.stringify(encodeState(populated)))),
    ).toEqual(populated);
  });
});

describe("decodeState", () => {
  const encoded = encodeState(populated) as Record<string, unknown>;
  const withState = (patch: Record<string, unknown>): unknown => ({
    ...encoded,
    ...patch,
  });

  it("fills in an agent the file does not mention", () => {
    const decoded = decodeState({
      version: 1,
      updatedAt: "2026-09-06T05:30:01.000Z",
      agents: {},
    });

    expect(decoded.agents).toEqual({
      claude: { phase: "idle" },
      codex: { phase: "idle" },
    });
  });

  it("drops an agent this build does not know", () => {
    // Written by a newer version. State is disposable, so forgetting it beats
    // refusing to start.
    const decoded = decodeState({
      version: 1,
      updatedAt: "2026-09-06T05:30:01.000Z",
      agents: { gemini: { phase: "activated" } },
    });

    expect(decoded.agents).not.toHaveProperty("gemini");
  });

  it.each<[unknown, string]>([
    [null, "null"],
    ["{}", "a string"],
    [[], "an array"],
    [42, "a number"],
    [{}, "no version"],
    [{ version: 1 }, "no agents"],
    [{ version: 1, updatedAt: "2026-09-06T05:30:01.000Z" }, "no agents"],
  ])("rejects %j (%s)", (raw) => {
    expect(() => decodeState(raw)).toThrow(InvalidStateError);
  });

  it("refuses a version from the future with a clear message", () => {
    expect(() => decodeState(withState({ version: 2 }))).toThrow(
      /version 2.*newer/i,
    );
  });

  it.each([
    ["updatedAt", "yesterday"],
    ["updatedAt", 1_757_000_000_000],
  ])("rejects a %s of %j", (key, value) => {
    expect(() => decodeState(withState({ [key]: value }))).toThrow(
      InvalidStateError,
    );
  });

  it.each<[string, unknown, string]>([
    ["phase", "sleeping", "an unknown phase"],
    ["phase", 1, "a phase that is not a string"],
    ["cycleDate", "6 September", "a date that is not ISO"],
    ["lastAttemptAt", "not a time", "a timestamp that is not ISO"],
    ["lastAttemptAt", 12_345, "a timestamp that is a number"],
    ["retryIndex", -1, "a negative retry index"],
    ["retryIndex", 1.5, "a fractional retry index"],
    ["retryIndex", "3", "a retry index that is a string"],
    ["reason", 42, "a reason that is not a string"],
  ])("rejects %s of %j (%s)", (key, value) => {
    expect(() =>
      decodeState(
        withState({
          agents: { claude: { phase: "idle", [key]: value } },
        }),
      ),
    ).toThrow(InvalidStateError);
  });

  it("rejects an agent entry that is not an object", () => {
    expect(() =>
      decodeState(withState({ agents: { claude: "activated" } })),
    ).toThrow(InvalidStateError);
  });

  it("names the agent, the field and the offending value", () => {
    const decode = (): unknown =>
      decodeState(withState({ agents: { claude: { phase: "sleeping" } } }));

    expect(decode).toThrow(/claude/);
    expect(decode).toThrow(/phase/);
    expect(decode).toThrow(/"sleeping"/);
  });
});
