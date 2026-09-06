import { describe, expect, it } from "vitest";

import { effectiveAgentConfig, parseConfig } from "#src/config/config.js";
import type { BlockingConstraint } from "#src/core/observation.js";
import {
  attemptAfterReset,
  effectiveReset,
  longTermRetryAt,
  nextBackoffStep,
  retryHorizonAt,
} from "#src/core/policy/retry.js";

const config = effectiveAgentConfig(
  parseConfig("version: 1\ntimezone: Europe/Rome\n", "config.yaml"),
  "claude",
);

const utc = (iso: string): number => Date.parse(`${iso}Z`);

/** Local wall-clock time on 2026-09-07, a CEST day, as an instant. */
const at = (localTime: string): number =>
  utc(`2026-09-07T${localTime}:00`) - 2 * 3_600_000;

const constraint = (
  type: BlockingConstraint["type"],
  resetAt: number | undefined,
  confidence: BlockingConstraint["confidence"] = "high",
): BlockingConstraint =>
  resetAt === undefined ? { type, confidence } : { type, resetAt, confidence };

describe("effectiveReset", () => {
  it("has no answer without constraints", () => {
    expect(effectiveReset([])).toBeUndefined();
  });

  it("takes the only reset there is", () => {
    expect(effectiveReset([constraint("rolling_window", at("08:23"))])).toBe(
      at("08:23"),
    );
  });

  it("takes the latest blocking reset", () => {
    // Scenario D: a rolling window that clears at 08:23 is irrelevant while a
    // weekly limit holds until Monday afternoon.
    expect(
      effectiveReset([
        constraint("rolling_window", at("08:23")),
        constraint("weekly", utc("2026-09-14T12:00:00")),
      ]),
    ).toBe(utc("2026-09-14T12:00:00"));
  });

  it("ignores the order the adapter reported them in", () => {
    expect(
      effectiveReset([
        constraint("weekly", utc("2026-09-14T12:00:00")),
        constraint("rolling_window", at("08:23")),
      ]),
    ).toBe(utc("2026-09-14T12:00:00"));
  });

  it("ignores a constraint with no reset time", () => {
    expect(
      effectiveReset([
        constraint("quota", undefined),
        constraint("rolling_window", at("08:23")),
      ]),
    ).toBe(at("08:23"));
  });

  it("keeps a medium-confidence reset", () => {
    expect(
      effectiveReset([constraint("rolling_window", at("08:23"), "medium")]),
    ).toBe(at("08:23"));
  });

  it("does not let a low-confidence reset suppress retries", () => {
    // A guessed timestamp may be shown to the user, but it must not silence the
    // backoff ladder for hours on the strength of a parser's hunch.
    expect(
      effectiveReset([
        constraint("rolling_window", at("08:23")),
        constraint("weekly", utc("2026-10-01T12:00:00"), "low"),
      ]),
    ).toBe(at("08:23"));
  });

  it("has no answer when every reset is a guess", () => {
    expect(
      effectiveReset([constraint("weekly", at("08:23"), "low")]),
    ).toBeUndefined();
  });
});

describe("attemptAfterReset", () => {
  it("waits the configured grace past the reset", () => {
    // Scenario B: reset 08:23, grace 1m, next attempt 08:24.
    expect(attemptAfterReset(config, at("08:23"))).toBe(at("08:24"));
  });

  it("attempts at the reset itself when the grace is zero", () => {
    const noGrace = effectiveAgentConfig(
      parseConfig(
        "version: 1\ntimezone: Europe/Rome\nactivation:\n  resetGrace: 0s\n",
        "config.yaml",
      ),
      "claude",
    );

    expect(attemptAfterReset(noGrace, at("08:23"))).toBe(at("08:23"));
  });
});

describe("retryHorizonAt", () => {
  it("anchors five hours to the day's notBefore", () => {
    expect(retryHorizonAt(config, "2026-09-07")).toBe(at("12:00"));
  });

  it("anchors to the cycle, not to the current time", () => {
    // The horizon must not slide forward with every retry, so it is derived
    // from the cycle's own date rather than from `now`.
    expect(retryHorizonAt(config, "2026-09-06")).toBe(
      utc("2026-09-06T10:00:00"),
    );
  });

  it("follows the local clock across a daylight-saving change", () => {
    // 07:00 CET is 06:00Z, so the horizon on a winter day is 11:00Z.
    expect(retryHorizonAt(config, "2026-01-15")).toBe(
      utc("2026-01-15T11:00:00"),
    );
  });
});

describe("nextBackoffStep", () => {
  const horizon = at("12:00");
  const ladder = config.unknownResetDelaysMs;

  it("walks the configured delays", () => {
    // The sequence the product requirements spell out for notBefore 07:00.
    const schedule: [string, string][] = [
      ["07:00", "07:05"],
      ["07:05", "07:15"],
      ["07:15", "07:30"],
      ["07:30", "08:00"],
      ["08:00", "09:00"],
    ];

    let retryIndex = 0;

    for (const [now, expected] of schedule) {
      const step = nextBackoffStep(ladder, retryIndex, at(now), horizon);

      expect(step).toEqual({
        retryIndex: retryIndex + 1,
        nextAttemptAt: at(expected),
      });
      retryIndex = step?.retryIndex ?? -1;
    }
  });

  it("repeats the last delay once the ladder runs out", () => {
    expect(nextBackoffStep(ladder, 5, at("09:00"), horizon)).toEqual({
      retryIndex: 6,
      nextAttemptAt: at("10:00"),
    });
    expect(nextBackoffStep(ladder, 40, at("10:00"), horizon)).toEqual({
      retryIndex: 41,
      nextAttemptAt: at("11:00"),
    });
  });

  it("caps the last attempt at the horizon", () => {
    // 11:00 + 60m would overshoot noon, so the final attempt lands on it.
    expect(nextBackoffStep(ladder, 7, at("11:00"), horizon)).toEqual({
      retryIndex: 8,
      nextAttemptAt: at("12:00"),
    });
  });

  it("gives up at the horizon", () => {
    expect(nextBackoffStep(ladder, 8, at("12:00"), horizon)).toBeUndefined();
  });

  it("gives up when the horizon is already behind", () => {
    // A laptop that slept through the whole morning wakes past the horizon.
    expect(nextBackoffStep(ladder, 3, at("15:00"), horizon)).toBeUndefined();
  });

  it("never returns an attempt in the past", () => {
    // Every step must move forward, or the tick would spin.
    let retryIndex = 0;
    let now = at("07:00");

    for (let step = 0; step < 20; step += 1) {
      const next = nextBackoffStep(ladder, retryIndex, now, horizon);

      if (next === undefined) break;

      expect(next.nextAttemptAt).toBeGreaterThan(now);
      retryIndex = next.retryIndex;
      now = next.nextAttemptAt;
    }

    expect(now).toBe(at("12:00"));
  });

  it("reports an empty ladder as spent rather than retrying instantly", () => {
    // Configuration rejects an empty ladder; if one reaches here anyway, the
    // long-term retry is a safer answer than a delay of zero.
    expect(nextBackoffStep([], 0, at("07:00"), horizon)).toBeUndefined();
  });

  it("runs without a horizon for the transient ladder", () => {
    // Network failures are bounded by the daily cycle rather than by the
    // five-hour window, which belongs to quota exhaustion.
    expect(
      nextBackoffStep(
        config.transientDelaysMs,
        0,
        at("07:00"),
        Number.POSITIVE_INFINITY,
      ),
    ).toEqual({ retryIndex: 1, nextAttemptAt: at("07:01") });
  });

  it("degrades the transient ladder to an hourly check", () => {
    expect(
      nextBackoffStep(
        config.transientDelaysMs,
        9,
        at("07:00"),
        Number.POSITIVE_INFINITY,
      ),
    ).toEqual({ retryIndex: 10, nextAttemptAt: at("08:00") });
  });
});

describe("longTermRetryAt", () => {
  it("comes back in six hours", () => {
    expect(longTermRetryAt(config, at("12:00"))).toBe(at("18:00"));
  });
});
