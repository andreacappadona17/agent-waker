/**
 * The observation-to-phase table, and whether an agent is due.
 *
 * This is where the product's central safety rule lives: an authentication or
 * install problem must never enter quota backoff. Those cost the user nothing
 * to fix and everything to wait for, so they get a cheap local recheck instead
 * of a five-hour window.
 */

import type { EffectiveAgentConfig } from "#src/config/config.js";
import type { AgentObservation } from "#src/core/observation.js";
import {
  attemptAfterReset,
  effectiveReset,
  longTermRetryAt,
  nextBackoffStep,
  retryHorizonAt,
} from "#src/core/policy/retry.js";
import type { AgentPhase, AgentState } from "#src/core/state.js";
import { localDateAt, type Instant, type LocalDate } from "#src/core/time.js";

/**
 * How often a problem the user has to fix is looked at again.
 *
 * Only local work — is the executable there, is there a session — so it costs
 * no quota. An hour is slow enough not to spam a broken install and fast enough
 * that a fix made over coffee is picked up the same morning.
 */
export const LOCAL_RECHECK_MS = 3_600_000;

/** A state under construction; absent fields are dropped rather than stored. */
type Draft = { [K in keyof AgentState]: AgentState[K] | undefined } & {
  phase: AgentPhase;
};

function build({ phase, ...rest }: Draft): AgentState {
  // `exactOptionalPropertyTypes` will not take an explicit undefined, and the
  // persisted file should not carry empty keys either. Phase is reattached
  // rather than filtered so it stays statically present.
  const set = Object.entries(rest).filter(([, value]) => value !== undefined);

  return Object.assign({ phase }, Object.fromEntries(set));
}

/** Whether this tick should evaluate the agent at all. */
export function isDue(
  config: EffectiveAgentConfig,
  state: AgentState,
  now: Instant,
): boolean {
  if (!config.enabled) return false;

  switch (state.phase) {
    case "idle":
      // The day's cycle has not opened yet.
      return false;
    case "activated":
      // Terminal until the next daily cycle.
      return false;
    case "ready":
      return true;
    default:
      // A wait with no timestamp is re-evaluated rather than parked forever: a
      // check costs one local call, never checking costs the user a morning.
      return now >= (state.nextAttemptAt ?? now);
  }
}

/**
 * Applies what the provider said to the agent's state.
 *
 * Called with the outcome of the run: either a probe result that was not
 * `available`, or the result of the activation itself. An `available`
 * observation therefore leaves the cycle open — only `activated` completes it,
 * so a probe can never mark the day done without the provider being called.
 */
export function applyObservation(
  config: EffectiveAgentConfig,
  state: AgentState,
  observation: AgentObservation,
  now: Instant,
): AgentState {
  // Every observation belongs to a cycle; a state file missing its date is
  // adopted into today's rather than left unattached.
  const cycleDate = state.cycleDate ?? localDateAt(now, config.timezone);
  const attempt = {
    cycleDate,
    firstAttemptAt: state.firstAttemptAt ?? now,
    lastAttemptAt: now,
    lastActivationAt: state.lastActivationAt,
  };

  // A problem the user has to fix interrupts the quota ladder without consuming
  // it, so the morning's position survives the detour.
  const interrupted = {
    ...attempt,
    retryIndex: state.retryIndex,
    retryHorizonEndsAt: state.retryHorizonEndsAt,
    nextAttemptAt: now + LOCAL_RECHECK_MS,
  };

  switch (observation.kind) {
    case "activated":
      return build({
        ...attempt,
        phase: "activated",
        lastActivationAt: now,
      });

    case "available":
      return build({ ...attempt, phase: "ready" });

    case "blocked":
      return whenBlocked(config, state, observation, now, attempt);

    case "auth_error":
      return build({
        ...interrupted,
        phase: "auth_required",
        reason: observation.state,
      });

    case "runtime_error":
      return build({
        ...interrupted,
        phase: "unhealthy",
        reason: observation.category,
      });

    case "transient_error":
      return whenTransient(config, state, observation, now, attempt);

    case "unknown":
      return build({
        ...interrupted,
        phase: "failed",
        reason: "unclassified_response",
      });
  }
}

type Attempt = Omit<Draft, "phase"> & { cycleDate: LocalDate };

/** `retryIndex` names a position in the ladder the current phase is walking. */
function quotaLadderIndex(state: AgentState): number {
  return state.phase === "transient_error" ? 0 : (state.retryIndex ?? 0);
}

function whenBlocked(
  config: EffectiveAgentConfig,
  state: AgentState,
  observation: Extract<AgentObservation, { kind: "blocked" }>,
  now: Instant,
  attempt: Attempt,
): AgentState {
  const resetAt = effectiveReset(observation.constraints);

  // A stated reset outranks the ladder, however long the wait — a weekly limit
  // is not something a five-hour window can outlast.
  if (resetAt !== undefined && resetAt > now) {
    return build({
      ...attempt,
      phase: "waiting_known_reset",
      reason: observation.reason,
      blockedUntil: resetAt,
      nextAttemptAt: attemptAfterReset(config, resetAt),
      retryIndex: state.retryIndex,
      retryHorizonEndsAt: state.retryHorizonEndsAt,
    });
  }

  // A reset already in the past cannot be waited for while the agent is still
  // blocked, so the honest reading is that the real reset time is unknown.
  const horizonEndsAt = retryHorizonAt(config, attempt.cycleDate);
  const step = nextBackoffStep(
    config.unknownResetDelaysMs,
    quotaLadderIndex(state),
    now,
    horizonEndsAt,
  );

  return step === undefined
    ? build({
        ...attempt,
        phase: "long_term_block",
        reason: observation.reason,
        nextAttemptAt: longTermRetryAt(config, now),
        retryIndex: quotaLadderIndex(state),
        retryHorizonEndsAt: horizonEndsAt,
      })
    : build({
        ...attempt,
        phase: "waiting_unknown_reset",
        reason: observation.reason,
        nextAttemptAt: step.nextAttemptAt,
        retryIndex: step.retryIndex,
        retryHorizonEndsAt: horizonEndsAt,
      });
}

function whenTransient(
  config: EffectiveAgentConfig,
  state: AgentState,
  observation: Extract<AgentObservation, { kind: "transient_error" }>,
  now: Instant,
  attempt: Attempt,
): AgentState {
  // No horizon: a network failure is bounded by the daily cycle, not by the
  // window that belongs to quota exhaustion.
  const step = nextBackoffStep(
    config.transientDelaysMs,
    state.phase === "transient_error" ? (state.retryIndex ?? 0) : 0,
    now,
    Number.POSITIVE_INFINITY,
  );

  return build({
    ...attempt,
    phase: "transient_error",
    reason: observation.category,
    nextAttemptAt: step?.nextAttemptAt ?? now + LOCAL_RECHECK_MS,
    retryIndex: step?.retryIndex,
  });
}
