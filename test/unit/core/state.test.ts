import { describe, expect, it } from "vitest";

import { parseConfig, effectiveAgentConfig } from "#src/config/config.js";
import {
  emptyState,
  rollDailyCycle,
  type AgentState,
} from "#src/core/state.js";

const config = effectiveAgentConfig(
  parseConfig("version: 1\ntimezone: Europe/Rome\n", "config.yaml"),
  "claude",
);

const utc = (iso: string): number => Date.parse(`${iso}Z`);

/** 07:00 Europe/Rome, the configured notBefore, on successive days. */
const MONDAY_07 = utc("2026-09-07T05:00:00");
const TUESDAY_07 = utc("2026-09-08T05:00:00");

const activated = (at: number): AgentState => ({
  phase: "activated",
  cycleDate: "2026-09-07",
  lastActivationAt: at,
  lastAttemptAt: at,
  firstAttemptAt: at,
});

describe("emptyState", () => {
  it("starts every known agent idle", () => {
    expect(emptyState()).toEqual({
      version: 1,
      updatedAt: 0,
      agents: {
        claude: { phase: "idle" },
        codex: { phase: "idle" },
      },
    });
  });
});

describe("rollDailyCycle", () => {
  it("leaves an idle agent alone before notBefore", () => {
    const state: AgentState = { phase: "idle" };

    expect(rollDailyCycle(config, state, MONDAY_07 - 1)).toBe(state);
  });

  it("opens the cycle at notBefore", () => {
    expect(rollDailyCycle(config, { phase: "idle" }, MONDAY_07)).toEqual({
      phase: "ready",
      cycleDate: "2026-09-07",
    });
  });

  it("opens the cycle when a tick arrives late", () => {
    // The scheduler fires every minute, but a sleeping laptop means the first
    // tick of the day can be hours after notBefore.
    expect(
      rollDailyCycle(config, { phase: "idle" }, MONDAY_07 + 4 * 3_600_000),
    ).toEqual({ phase: "ready", cycleDate: "2026-09-07" });
  });

  it("does not reopen a cycle it already completed", () => {
    const state = activated(MONDAY_07);

    expect(rollDailyCycle(config, state, MONDAY_07 + 3_600_000)).toBe(state);
  });

  it("reopens the cycle the next day", () => {
    // firstAttemptAt belongs to the cycle that just ended; the two "last"
    // timestamps outlive it, because `status` reports them.
    expect(rollDailyCycle(config, activated(MONDAY_07), TUESDAY_07)).toEqual({
      phase: "ready",
      cycleDate: "2026-09-08",
      lastActivationAt: MONDAY_07,
      lastAttemptAt: MONDAY_07,
    });
  });

  it("keeps yesterday's cycle closed until today's notBefore", () => {
    // Midnight is not the boundary: the cycle opens at notBefore, so between
    // 00:00 and 07:00 yesterday's completed cycle still stands.
    const monday = activated(MONDAY_07);
    const tuesdayJustAfterMidnight = utc("2026-09-07T22:30:00");

    expect(rollDailyCycle(config, monday, tuesdayJustAfterMidnight)).toBe(
      monday,
    );
  });

  it("respects a per-agent notBefore", () => {
    const early = effectiveAgentConfig(
      parseConfig(
        'version: 1\ntimezone: Europe/Rome\nagents:\n  claude:\n    schedule:\n      notBefore: "06:45"\n',
        "config.yaml",
      ),
      "claude",
    );
    const quarterTo = utc("2026-09-07T04:45:00");

    expect(rollDailyCycle(early, { phase: "idle" }, quarterTo)).toEqual({
      phase: "ready",
      cycleDate: "2026-09-07",
    });
  });

  describe("a cycle that is still in progress", () => {
    it("leaves a wait for a known reset alone within the same day", () => {
      const waiting: AgentState = {
        phase: "waiting_known_reset",
        cycleDate: "2026-09-07",
        blockedUntil: utc("2026-09-07T06:23:00"),
        nextAttemptAt: utc("2026-09-07T06:24:00"),
      };

      expect(rollDailyCycle(config, waiting, MONDAY_07 + 60_000)).toBe(waiting);
    });

    it("collapses an unfinished cycle into the new day", () => {
      // ADR-008: yesterday's missed warmup has no value once today's is due, so
      // it is replaced rather than queued behind it.
      const stale: AgentState = {
        phase: "waiting_unknown_reset",
        cycleDate: "2026-09-07",
        firstAttemptAt: MONDAY_07,
        lastAttemptAt: utc("2026-09-07T10:00:00"),
        nextAttemptAt: utc("2026-09-07T11:00:00"),
        retryIndex: 4,
        retryHorizonEndsAt: utc("2026-09-07T10:00:00"),
        reason: "rolling_window",
      };

      expect(rollDailyCycle(config, stale, TUESDAY_07)).toEqual({
        phase: "ready",
        cycleDate: "2026-09-08",
        lastAttemptAt: utc("2026-09-07T10:00:00"),
      });
    });

    it("carries a known reset in the future across the day boundary", () => {
      // A weekly limit resetting on Monday afternoon is still the best
      // information available when Monday morning's cycle opens, so the wait
      // survives; only the cycle it belongs to is updated.
      const weekly: AgentState = {
        phase: "waiting_known_reset",
        cycleDate: "2026-09-06",
        blockedUntil: utc("2026-09-07T12:00:00"),
        nextAttemptAt: utc("2026-09-07T12:01:00"),
        reason: "weekly_limit",
      };

      expect(rollDailyCycle(config, weekly, MONDAY_07)).toEqual({
        ...weekly,
        cycleDate: "2026-09-07",
      });
    });

    it("drops a known reset that has already passed", () => {
      const expired: AgentState = {
        phase: "waiting_known_reset",
        cycleDate: "2026-09-06",
        blockedUntil: utc("2026-09-06T20:00:00"),
        nextAttemptAt: utc("2026-09-06T20:01:00"),
        reason: "rolling_window",
      };

      expect(rollDailyCycle(config, expired, MONDAY_07)).toEqual({
        phase: "ready",
        cycleDate: "2026-09-07",
      });
    });

    it("drops a known-reset wait that lost its reset time", () => {
      // Only reachable through an edited or truncated state file, but a wait
      // with nothing to wait for must not survive the day.
      expect(
        rollDailyCycle(
          config,
          { phase: "waiting_known_reset", cycleDate: "2026-09-06" },
          MONDAY_07,
        ),
      ).toEqual({ phase: "ready", cycleDate: "2026-09-07" });
    });

    it("keeps a long-term block but re-anchors it to the new cycle", () => {
      const blocked: AgentState = {
        phase: "long_term_block",
        cycleDate: "2026-09-06",
        nextAttemptAt: utc("2026-09-07T09:00:00"),
        reason: "unknown",
      };

      expect(rollDailyCycle(config, blocked, MONDAY_07)).toEqual({
        ...blocked,
        cycleDate: "2026-09-07",
      });
    });

    it.each(["auth_required", "unhealthy"] as const)(
      "reopens %s so a fixed install is noticed",
      (phase) => {
        // Neither is a usage block, so the new day should re-check cheaply
        // rather than leave the agent parked until the user runs a command.
        const state: AgentState = {
          phase,
          cycleDate: "2026-09-06",
          reason: "not_authenticated",
          lastAttemptAt: utc("2026-09-06T05:00:00"),
        };

        expect(rollDailyCycle(config, state, MONDAY_07)).toEqual({
          phase: "ready",
          cycleDate: "2026-09-07",
          lastAttemptAt: utc("2026-09-06T05:00:00"),
        });
      },
    );
  });

  describe("across a daylight-saving change", () => {
    it("opens at 07:00 local on the day the clocks go forward", () => {
      // 2026-03-29 in Europe/Rome loses an hour at 02:00, so 07:00 local is
      // 05:00Z, an hour earlier in absolute terms than the day before.
      expect(
        rollDailyCycle(config, { phase: "idle" }, utc("2026-03-29T05:00:00")),
      ).toEqual({ phase: "ready", cycleDate: "2026-03-29" });

      expect(
        rollDailyCycle(config, { phase: "idle" }, utc("2026-03-29T04:59:59")),
      ).toEqual({ phase: "idle" });
    });

    it("opens at 07:00 local on the day the clocks go back", () => {
      expect(
        rollDailyCycle(config, { phase: "idle" }, utc("2026-10-25T06:00:00")),
      ).toEqual({ phase: "ready", cycleDate: "2026-10-25" });

      expect(
        rollDailyCycle(config, { phase: "idle" }, utc("2026-10-25T05:59:59")),
      ).toEqual({ phase: "idle" });
    });
  });

  it("does not open a cycle for a disabled agent", () => {
    const disabled = effectiveAgentConfig(
      parseConfig(
        "version: 1\ntimezone: Europe/Rome\nagents:\n  claude:\n    enabled: false\n",
        "config.yaml",
      ),
      "claude",
    );

    expect(rollDailyCycle(disabled, { phase: "idle" }, MONDAY_07)).toEqual({
      phase: "idle",
    });
  });
});
