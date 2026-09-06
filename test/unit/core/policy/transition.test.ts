import { describe, expect, it } from "vitest";

import { effectiveAgentConfig, parseConfig } from "#src/config/config.js";
import type { AgentObservation } from "#src/core/observation.js";
import {
  applyObservation,
  isDue,
  LOCAL_RECHECK_MS,
} from "#src/core/policy/transition.js";
import type { AgentState } from "#src/core/state.js";

const config = effectiveAgentConfig(
  parseConfig("version: 1\ntimezone: Europe/Rome\n", "config.yaml"),
  "claude",
);

const utc = (iso: string): number => Date.parse(`${iso}Z`);

/** Local wall-clock time on 2026-09-07, a CEST day. */
const at = (localTime: string): number =>
  utc(`2026-09-07T${localTime}:00`) - 2 * 3_600_000;

/** The state after the cycle opens and before anything has been observed. */
const ready: AgentState = { phase: "ready", cycleDate: "2026-09-07" };

describe("applyObservation", () => {
  describe("a successful activation", () => {
    const activated = applyObservation(
      config,
      ready,
      { kind: "activated" },
      at("07:00"),
    );

    it("completes the daily cycle", () => {
      expect(activated).toEqual({
        phase: "activated",
        cycleDate: "2026-09-07",
        firstAttemptAt: at("07:00"),
        lastAttemptAt: at("07:00"),
        lastActivationAt: at("07:00"),
      });
    });

    it("is not due again", () => {
      expect(isDue(config, activated, at("09:00"))).toBe(false);
    });

    it("clears the retry state a blocked morning left behind", () => {
      const afterRetries: AgentState = {
        phase: "waiting_unknown_reset",
        cycleDate: "2026-09-07",
        firstAttemptAt: at("07:00"),
        lastAttemptAt: at("08:00"),
        nextAttemptAt: at("09:00"),
        retryIndex: 4,
        retryHorizonEndsAt: at("12:00"),
        blockedUntil: at("08:23"),
        reason: "rolling_window",
      };

      expect(
        applyObservation(
          config,
          afterRetries,
          { kind: "activated" },
          at("09:00"),
        ),
      ).toEqual({
        phase: "activated",
        cycleDate: "2026-09-07",
        firstAttemptAt: at("07:00"),
        lastAttemptAt: at("09:00"),
        lastActivationAt: at("09:00"),
      });
    });
  });

  describe("a probe that only says the window is open", () => {
    it("does not complete the cycle, because nothing has run yet", () => {
      // The orchestrator still has to activate. Treating this as done would
      // mark the day complete without the provider ever being called.
      const next = applyObservation(
        config,
        ready,
        { kind: "available" },
        at("07:00"),
      );

      expect(next.phase).toBe("ready");
      expect(next.lastActivationAt).toBeUndefined();
      expect(isDue(config, next, at("07:00"))).toBe(true);
    });
  });

  describe("blocked with a known reset", () => {
    const observation: AgentObservation = {
      kind: "blocked",
      reason: "rolling_window",
      constraints: [
        { type: "rolling_window", resetAt: at("08:23"), confidence: "high" },
      ],
    };
    const next = applyObservation(config, ready, observation, at("07:00"));

    it("waits until the reset plus the grace", () => {
      // Scenario B.
      expect(next).toMatchObject({
        phase: "waiting_known_reset",
        blockedUntil: at("08:23"),
        nextAttemptAt: at("08:24"),
        reason: "rolling_window",
      });
    });

    it("is not due before then", () => {
      expect(isDue(config, next, at("08:23"))).toBe(false);
      expect(isDue(config, next, at("08:24"))).toBe(true);
    });

    it("is due once a sleeping laptop wakes up late", () => {
      // Scenario E: the attempt is overdue, not missed.
      expect(isDue(config, next, at("09:13"))).toBe(true);
    });

    it("waits for the latest limit when several apply", () => {
      // Scenario D: the weekly reset wins and no short-window retry is set.
      const weekly = utc("2026-09-14T12:00:00");

      expect(
        applyObservation(
          config,
          ready,
          {
            kind: "blocked",
            reason: "weekly_limit",
            constraints: [
              {
                type: "rolling_window",
                resetAt: at("08:23"),
                confidence: "high",
              },
              { type: "weekly", resetAt: weekly, confidence: "high" },
            ],
          },
          at("07:00"),
        ),
      ).toMatchObject({
        phase: "waiting_known_reset",
        blockedUntil: weekly,
        nextAttemptAt: weekly + 60_000,
      });
    });

    it("falls back to the backoff ladder when the reset has already passed", () => {
      // A reset in the past cannot be waited for, and the agent is still
      // blocked, so the only honest answer is that the reset time is unknown.
      expect(
        applyObservation(
          config,
          ready,
          {
            kind: "blocked",
            reason: "rolling_window",
            constraints: [
              {
                type: "rolling_window",
                resetAt: at("06:30"),
                confidence: "high",
              },
            ],
          },
          at("07:00"),
        ),
      ).toMatchObject({
        phase: "waiting_unknown_reset",
        nextAttemptAt: at("07:05"),
      });
    });
  });

  describe("blocked with no reset", () => {
    const observation: AgentObservation = {
      kind: "blocked",
      reason: "rolling_window",
      constraints: [{ type: "rolling_window", confidence: "high" }],
    };

    it("starts the staged backoff and records the horizon", () => {
      // Scenario C.
      expect(applyObservation(config, ready, observation, at("07:00"))).toEqual(
        {
          phase: "waiting_unknown_reset",
          cycleDate: "2026-09-07",
          firstAttemptAt: at("07:00"),
          lastAttemptAt: at("07:00"),
          nextAttemptAt: at("07:05"),
          retryIndex: 1,
          retryHorizonEndsAt: at("12:00"),
          reason: "rolling_window",
        },
      );
    });

    it("walks the whole ladder to the horizon and then gives up", () => {
      const expected = [
        ["07:00", "07:05"],
        ["07:05", "07:15"],
        ["07:15", "07:30"],
        ["07:30", "08:00"],
        ["08:00", "09:00"],
        ["09:00", "10:00"],
        ["10:00", "11:00"],
        ["11:00", "12:00"],
      ] as const;

      let state = ready;

      for (const [now, nextAttempt] of expected) {
        state = applyObservation(config, state, observation, at(now));

        expect(state).toMatchObject({
          phase: "waiting_unknown_reset",
          nextAttemptAt: at(nextAttempt),
        });
      }

      // The horizon attempt happens, and only then does it become long term.
      state = applyObservation(config, state, observation, at("12:00"));

      expect(state).toMatchObject({
        phase: "long_term_block",
        nextAttemptAt: at("18:00"),
        reason: "rolling_window",
      });
    });

    it("starts a fresh ladder after a network detour", () => {
      // The transient ladder owns retryIndex while it is walking, so the quota
      // ladder must not resume from its position.
      const afterNetwork: AgentState = {
        phase: "transient_error",
        cycleDate: "2026-09-07",
        retryIndex: 3,
        nextAttemptAt: at("07:30"),
      };

      expect(
        applyObservation(config, afterNetwork, observation, at("07:30")),
      ).toMatchObject({
        phase: "waiting_unknown_reset",
        retryIndex: 1,
        nextAttemptAt: at("07:35"),
      });
    });

    it("ignores a guessed reset time rather than waiting on it", () => {
      expect(
        applyObservation(
          config,
          ready,
          {
            kind: "blocked",
            reason: "unknown",
            constraints: [
              {
                type: "other",
                resetAt: utc("2026-09-30T12:00:00"),
                confidence: "low",
              },
            ],
          },
          at("07:00"),
        ),
      ).toMatchObject({
        phase: "waiting_unknown_reset",
        nextAttemptAt: at("07:05"),
      });
    });

    it("prefers a reset that turns up during a long-term block", () => {
      const longTerm: AgentState = {
        phase: "long_term_block",
        cycleDate: "2026-09-07",
        nextAttemptAt: at("18:00"),
        reason: "unknown",
      };

      expect(
        applyObservation(
          config,
          longTerm,
          {
            kind: "blocked",
            reason: "weekly_limit",
            constraints: [
              { type: "weekly", resetAt: at("14:00"), confidence: "high" },
            ],
          },
          at("12:00"),
        ),
      ).toMatchObject({
        phase: "waiting_known_reset",
        nextAttemptAt: at("14:01"),
      });
    });
  });

  describe("an authentication problem", () => {
    const next = applyObservation(
      config,
      ready,
      { kind: "auth_error", state: "expired", message: "session expired" },
      at("07:00"),
    );

    it("asks the user rather than waiting on a quota", () => {
      expect(next).toMatchObject({
        phase: "auth_required",
        reason: "expired",
      });
    });

    it("never enters the quota backoff", () => {
      // Rule 4: an authentication failure is not a usage-window failure.
      expect(next.retryIndex).toBeUndefined();
      expect(next.retryHorizonEndsAt).toBeUndefined();
      expect(next.blockedUntil).toBeUndefined();
    });

    it("rechecks cheaply rather than every tick", () => {
      expect(next.nextAttemptAt).toBe(at("07:00") + LOCAL_RECHECK_MS);
      expect(isDue(config, next, at("07:01"))).toBe(false);
    });

    it("does not consume the ladder when it interrupts a blocked morning", () => {
      const midLadder: AgentState = {
        phase: "waiting_unknown_reset",
        cycleDate: "2026-09-07",
        retryIndex: 3,
        retryHorizonEndsAt: at("12:00"),
        nextAttemptAt: at("08:00"),
      };
      const interrupted = applyObservation(
        config,
        midLadder,
        { kind: "auth_error", state: "not_authenticated", message: "" },
        at("08:00"),
      );

      expect(interrupted.phase).toBe("auth_required");
      expect(interrupted.retryIndex).toBe(3);
    });
  });

  describe("an install or runtime problem", () => {
    const next = applyObservation(
      config,
      ready,
      { kind: "runtime_error", category: "broken_install" },
      at("07:00"),
    );

    it("is reported as unhealthy", () => {
      // Scenario F: a broken npm wrapper is not quota exhaustion.
      expect(next).toMatchObject({
        phase: "unhealthy",
        reason: "broken_install",
      });
    });

    it("never starts a five-hour backoff", () => {
      // Rule 5.
      expect(next.retryIndex).toBeUndefined();
      expect(next.retryHorizonEndsAt).toBeUndefined();
      expect(next.nextAttemptAt).toBe(at("07:00") + LOCAL_RECHECK_MS);
    });
  });

  describe("a transient failure", () => {
    const observation: AgentObservation = {
      kind: "transient_error",
      category: "network",
    };

    it("uses its own short ladder", () => {
      expect(applyObservation(config, ready, observation, at("07:00"))).toEqual(
        {
          phase: "transient_error",
          cycleDate: "2026-09-07",
          firstAttemptAt: at("07:00"),
          lastAttemptAt: at("07:00"),
          nextAttemptAt: at("07:01"),
          retryIndex: 1,
          reason: "network",
        },
      );
    });

    it("degrades to an hourly check rather than stopping", () => {
      const schedule = ["07:01", "07:06", "07:21", "08:21", "09:21"];
      let state = applyObservation(config, ready, observation, at("07:00"));

      for (const nextAttempt of schedule.slice(1)) {
        state = applyObservation(
          config,
          state,
          observation,
          state.nextAttemptAt ?? 0,
        );

        expect(state.nextAttemptAt).toBe(at(nextAttempt));
      }
    });

    it("restarts the ladder when the position was lost", () => {
      // Only reachable through an edited state file.
      expect(
        applyObservation(
          config,
          { phase: "transient_error", cycleDate: "2026-09-07" },
          observation,
          at("07:00"),
        ),
      ).toMatchObject({ retryIndex: 1, nextAttemptAt: at("07:01") });
    });

    it("falls back to the hourly recheck if the ladder is empty", () => {
      // Configuration rejects an empty ladder; failing to an hourly check beats
      // retrying a flapping network every tick.
      expect(
        applyObservation(
          { ...config, transientDelaysMs: [] },
          ready,
          observation,
          at("07:00"),
        ),
      ).toMatchObject({
        phase: "transient_error",
        nextAttemptAt: at("07:00") + LOCAL_RECHECK_MS,
      });
    });

    it("is bounded by the daily cycle rather than by the five-hour horizon", () => {
      // Rule 6: a network failure must not be confused with provider quota.
      const next = applyObservation(config, ready, observation, at("13:00"));

      expect(next.phase).toBe("transient_error");
      expect(next.retryHorizonEndsAt).toBeUndefined();
    });

    it("does not inherit the quota ladder's position", () => {
      const midLadder: AgentState = {
        phase: "waiting_unknown_reset",
        cycleDate: "2026-09-07",
        retryIndex: 4,
        retryHorizonEndsAt: at("12:00"),
      };

      expect(
        applyObservation(config, midLadder, observation, at("08:00")),
      ).toMatchObject({ retryIndex: 1, nextAttemptAt: at("08:01") });
    });
  });

  describe("a response nobody could classify", () => {
    const next = applyObservation(
      config,
      ready,
      { kind: "unknown", detail: "unrecognised output" },
      at("07:00"),
    );

    it("fails closed rather than guessing a reset", () => {
      expect(next).toMatchObject({
        phase: "failed",
        reason: "unclassified_response",
      });
    });

    it("does not treat it as a usage block", () => {
      expect(next.retryHorizonEndsAt).toBeUndefined();
      expect(next.nextAttemptAt).toBe(at("07:00") + LOCAL_RECHECK_MS);
    });
  });

  it("records the first attempt of the cycle once", () => {
    const first = applyObservation(
      config,
      ready,
      { kind: "transient_error", category: "dns" },
      at("07:00"),
    );
    const second = applyObservation(
      config,
      first,
      { kind: "transient_error", category: "dns" },
      at("07:01"),
    );

    expect(second.firstAttemptAt).toBe(at("07:00"));
    expect(second.lastAttemptAt).toBe(at("07:01"));
  });

  it("uses the day's own horizon when the cycle date is missing", () => {
    // Only reachable through an edited state file; the horizon still has to
    // come from somewhere, and today's notBefore is the honest answer.
    expect(
      applyObservation(
        config,
        { phase: "ready" },
        {
          kind: "blocked",
          reason: "quota",
          constraints: [{ type: "quota", confidence: "high" }],
        },
        at("07:00"),
      ),
    ).toMatchObject({ retryHorizonEndsAt: at("12:00") });
  });
});

describe("isDue", () => {
  it("is never due while the agent is disabled", () => {
    const disabled = effectiveAgentConfig(
      parseConfig(
        "version: 1\ntimezone: Europe/Rome\nagents:\n  claude:\n    enabled: false\n",
        "config.yaml",
      ),
      "claude",
    );

    expect(isDue(disabled, ready, at("07:00"))).toBe(false);
  });

  it("is not due before the cycle opens", () => {
    expect(isDue(config, { phase: "idle" }, at("06:59"))).toBe(false);
  });

  it("is due as soon as the cycle opens", () => {
    expect(isDue(config, ready, at("07:00"))).toBe(true);
  });

  it.each([
    "waiting_known_reset",
    "waiting_unknown_reset",
    "long_term_block",
    "transient_error",
    "auth_required",
    "unhealthy",
    "failed",
  ] as const)("waits for the next attempt in %s", (phase) => {
    const state: AgentState = {
      phase,
      cycleDate: "2026-09-07",
      nextAttemptAt: at("08:24"),
    };

    expect(isDue(config, state, at("08:23"))).toBe(false);
    expect(isDue(config, state, at("08:24"))).toBe(true);
  });

  it("re-evaluates a wait that lost its timestamp", () => {
    // Fail towards checking: a check costs one local call, while never
    // checking again costs the user their morning.
    expect(isDue(config, { phase: "waiting_known_reset" }, at("08:00"))).toBe(
      true,
    );
  });
});
