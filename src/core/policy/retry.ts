/**
 * Retry arithmetic. Pure functions over configuration, a cycle and a clock
 * reading; no state is mutated and nothing is observed.
 *
 * Two ladders exist and must not be confused. Quota exhaustion walks the
 * unknown-reset delays under a horizon anchored to the day's target; network
 * failures walk their own, shorter ladder with no horizon. An install or
 * authentication problem walks neither.
 */

import type { EffectiveAgentConfig } from "#src/config/config.js";
import type { BlockingConstraint } from "#src/core/observation.js";
import {
  resolveLocalTime,
  type Instant,
  type LocalDate,
} from "#src/core/time.js";

/** One rung of a backoff ladder. */
export interface BackoffStep {
  /** Where the next observation resumes from. */
  readonly retryIndex: number;
  readonly nextAttemptAt: Instant;
}

/**
 * The reset the core should wait for, given everything the provider said.
 *
 * The latest one wins: a rolling window clearing at 08:23 is irrelevant while a
 * weekly limit holds until Monday. Guessed timestamps are excluded — a parser's
 * hunch must not silence the backoff ladder for hours.
 */
export function effectiveReset(
  constraints: readonly BlockingConstraint[],
): Instant | undefined {
  const known = constraints
    .filter((constraint) => constraint.confidence !== "low")
    .map((constraint) => constraint.resetAt)
    .filter((resetAt) => resetAt !== undefined);

  return known.length === 0 ? undefined : Math.max(...known);
}

/** When to retry after a reset the provider stated. */
export function attemptAfterReset(
  config: EffectiveAgentConfig,
  resetAt: Instant,
): Instant {
  return resetAt + config.resetGraceMs;
}

/**
 * When normal-window retries stop for a cycle.
 *
 * Anchored to the cycle's own `notBefore`, not to the current time, so the
 * horizon does not slide forward with every retry.
 */
export function retryHorizonAt(
  config: EffectiveAgentConfig,
  cycleDate: LocalDate,
): Instant {
  return (
    resolveLocalTime(cycleDate, config.notBefore, config.timezone) +
    config.normalWindowHorizonMs
  );
}

/**
 * Advances a backoff ladder, or reports that the horizon is spent.
 *
 * The last delay repeats once the ladder runs out, and the final attempt is
 * pulled back onto the horizon rather than overshooting it. That final attempt
 * can land close behind its predecessor; the product requirements allow
 * skipping it, but one extra check beats reporting a long-term block a user
 * could have avoided.
 *
 * @param horizonEndsAt `Number.POSITIVE_INFINITY` for a ladder with no horizon.
 * @returns `undefined` once the horizon has been reached, or if the ladder is
 * empty.
 */
export function nextBackoffStep(
  delaysMs: readonly number[],
  retryIndex: number,
  now: Instant,
  horizonEndsAt: Instant,
): BackoffStep | undefined {
  if (now >= horizonEndsAt) return undefined;

  const delay = delaysMs[Math.min(retryIndex, delaysMs.length - 1)];

  // Configuration rejects an empty ladder, so this is a caller's mistake.
  // Reporting the horizon spent is the safe reading: it degrades to the
  // six-hourly long-term retry rather than to a delay of zero, which would spin.
  if (delay === undefined) return undefined;

  return {
    retryIndex: retryIndex + 1,
    nextAttemptAt: Math.min(now + delay, horizonEndsAt),
  };
}

/** When to look again once the normal window is spent. */
export function longTermRetryAt(
  config: EffectiveAgentConfig,
  now: Instant,
): Instant {
  return now + config.longTermRetryMs;
}
