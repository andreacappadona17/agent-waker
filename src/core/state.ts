/**
 * The persisted per-agent state, and the daily cycle that drives it.
 *
 * State is timestamps rather than timers: a tick is a short-lived process, so
 * "wait until 08:24" has to survive the process exiting, the laptop sleeping
 * and the machine rebooting.
 */

import { AGENT_IDS, type AgentId } from "#src/core/agent.js";
import type { EffectiveAgentConfig } from "#src/config/config.js";
import { localDateAt, resolveLocalTime } from "#src/core/time.js";
import type { Instant, LocalDate } from "#src/core/time.js";

/**
 * Where an agent stands in the current daily cycle.
 *
 * `auth_required` and `unhealthy` are deliberately not usage blocks: neither
 * may enter the quota backoff ladder, because retrying them costs the user
 * nothing to fix and everything to wait for.
 */
export const AGENT_PHASES = [
  "idle",
  "ready",
  "activated",
  "waiting_known_reset",
  "waiting_unknown_reset",
  "long_term_block",
  "auth_required",
  "unhealthy",
  "transient_error",
  "failed",
] as const;

export type AgentPhase = (typeof AGENT_PHASES)[number];

/**
 * Phases that no amount of waiting will clear.
 *
 * One rule, three readers: `status` says so, `tick` turns it into an exit
 * code, and the orchestrator logs at `warn` and marks the span failed. It was
 * spelled out separately in each until they disagreed.
 */
export function needsAttention(phase: AgentPhase): boolean {
  return (
    phase === "unhealthy" || phase === "auth_required" || phase === "failed"
  );
}

/** One agent's persisted state. */
export interface AgentState {
  readonly phase: AgentPhase;

  /** The local day this state belongs to; absent before the first cycle. */
  readonly cycleDate?: LocalDate;
  /** Why the agent is in this phase, in the provider-neutral vocabulary. */
  readonly reason?: string;

  /** The first attempt of the current cycle, so its age can be reported. */
  readonly firstAttemptAt?: Instant;
  readonly lastAttemptAt?: Instant;
  readonly lastActivationAt?: Instant;

  /** When the provider said the block lifts, if it said. */
  readonly blockedUntil?: Instant;
  /** When the next attempt becomes due. The scheduler compares against this. */
  readonly nextAttemptAt?: Instant;
  /** How far into the backoff ladder this cycle has walked. */
  readonly retryIndex?: number;
  /** When normal-window retries stop and long-term handling starts. */
  readonly retryHorizonEndsAt?: Instant;
}

/** The whole persisted document. */
export interface AgentWakerState {
  readonly version: 1;
  /** Stamped by the store on save; zero means never written. */
  readonly updatedAt: Instant;
  readonly agents: Readonly<Record<AgentId, AgentState>>;
}

/** The state of an installation that has never run. */
export function emptyState(): AgentWakerState {
  const agents = {} as Record<AgentId, AgentState>;

  for (const agentId of AGENT_IDS) agents[agentId] = { phase: "idle" };

  return { version: 1, updatedAt: 0, agents };
}

/** The instant this agent's cycle opens on the local day containing `now`. */
export function cycleStartAt(
  config: EffectiveAgentConfig,
  now: Instant,
): Instant {
  return resolveLocalTime(
    localDateAt(now, config.timezone),
    config.notBefore,
    config.timezone,
  );
}

/**
 * Opens the day's activation cycle, or leaves the current one alone.
 *
 * The cycle turns over at `notBefore`, not at midnight, so the hours between
 * are still part of the previous day's cycle.
 *
 * A cycle that did not finish is not carried forward. ADR-008: a warmup has no
 * value once a newer one is due, so an unfinished cycle collapses into today's
 * rather than queueing behind it. The exceptions are the two waits that are
 * still telling the truth — a known reset that has not yet passed, and a
 * long-term block — which keep their timers and are simply re-anchored to the
 * new cycle.
 *
 * Returns the state unchanged, by identity, when nothing moves.
 */
export function rollDailyCycle(
  config: EffectiveAgentConfig,
  state: AgentState,
  now: Instant,
): AgentState {
  if (!config.enabled) return state;

  const today = localDateAt(now, config.timezone);

  // Before notBefore the day's cycle has not opened yet.
  if (now < cycleStartAt(config, now)) return state;
  if (state.cycleDate === today) return state;

  const knownResetStillAhead =
    state.phase === "waiting_known_reset" && (state.blockedUntil ?? 0) > now;

  if (knownResetStillAhead || state.phase === "long_term_block") {
    return { ...state, cycleDate: today };
  }

  // Survivors are listed positively, so a field added to AgentState later has
  // to opt in to crossing the day boundary instead of leaking across it. These
  // two are what `status` reports: when the agent last ran, and last succeeded.
  return {
    phase: "ready",
    cycleDate: today,
    ...(state.lastAttemptAt === undefined
      ? {}
      : { lastAttemptAt: state.lastAttemptAt }),
    ...(state.lastActivationAt === undefined
      ? {}
      : { lastActivationAt: state.lastActivationAt }),
  };
}
