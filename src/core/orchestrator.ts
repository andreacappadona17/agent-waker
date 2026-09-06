/**
 * One pass of the scheduler.
 *
 * A tick is a short-lived process (ADR-001), so this is the whole program's
 * main loop: read the clock once, load state, work out which agents are due,
 * ask their adapters what the provider says, and write down what to do next.
 *
 * It owns no product semantics of its own. Whether an agent is due, and what an
 * observation means, both live in the policy; whether the provider is blocked
 * lives in the adapter. What happens here is the sequencing between them, and
 * the translation of a detection or an authentication result into the
 * observation vocabulary the policy speaks.
 */

import type { AdapterRegistry } from "#src/adapters/registry.js";
import type {
  AuthResult,
  DetectionResult,
  AgentAdapter,
  AdapterContext,
} from "#src/adapters/contract.js";
import {
  effectiveAgentConfig,
  type AgentWakerConfig,
  type EffectiveAgentConfig,
} from "#src/config/config.js";
import { AGENT_IDS, type AgentId } from "#src/core/agent.js";
import type { AgentObservation } from "#src/core/observation.js";
import { applyObservation, isDue } from "#src/core/policy/transition.js";
import {
  rollDailyCycle,
  type AgentPhase,
  type AgentState,
  type AgentWakerState,
} from "#src/core/state.js";
import type { Instant } from "#src/core/time.js";
import type { Event, EventLog } from "#src/logging/log.js";
import type { ProcessRunner } from "#src/process/runner.js";
import type { StateStore } from "#src/state/store.js";

export interface TickContext {
  readonly config: AgentWakerConfig;
  readonly store: StateStore;
  readonly registry: AdapterRegistry;
  readonly log: EventLog;
  readonly runner: ProcessRunner;
  /** An empty directory for adapters to run providers in. */
  readonly workDir: string;
  readonly runtime: "local" | "github";
  /** Read once per tick, so every decision in it shares one instant. */
  readonly now: () => Instant;
}

export interface TickOptions {
  /** Restrict the run to these agents, as `run <agent>` does. */
  readonly only?: readonly AgentId[];
  /**
   * Evaluate now rather than when the schedule says.
   *
   * Skips the timer, never the rate limit: a forced run still asks the
   * provider and still respects a block, and still will not activate an agent
   * that has already completed today's cycle.
   */
  readonly force?: boolean;
}

export interface AgentOutcome {
  readonly agentId: AgentId;
  readonly phase: AgentPhase;
  readonly reason?: string;
  readonly nextAttemptAt?: Instant;
  /** Set when the agent was not evaluated, and why. */
  readonly skipped?: "disabled" | "not_due";
}

export interface TickResult {
  readonly at: Instant;
  readonly agents: readonly AgentOutcome[];
}

/** Turns what detection found into something the policy understands. */
function observeDetection(
  detection: DetectionResult,
): AgentObservation | undefined {
  if (!detection.installed) {
    return { kind: "runtime_error", category: "executable_missing" };
  }

  if (detection.health === "broken") {
    return { kind: "runtime_error", category: "broken_install" };
  }

  return undefined;
}

/** Turns an authentication result into something the policy understands. */
function observeAuth(auth: AuthResult): AgentObservation | undefined {
  if (!auth.authenticated) {
    return {
      kind: "auth_error",
      state: "not_authenticated",
      message: auth.message ?? "Not signed in.",
    };
  }

  if (auth.supportsIntent) return undefined;

  // Authenticated, but with a credential that cannot do what was asked. An API
  // key would answer and bill for it, which is the one thing not to do quietly.
  return {
    kind: "auth_error",
    state: auth.mode === "api_key" ? "api_billing_only" : "unsupported_auth",
    message:
      auth.message ??
      "This credential cannot be used for subscription activation.",
  };
}

/** Runs one agent's adapter as far as it gets, and reports what happened. */
async function observe(
  adapter: AgentAdapter,
  context: AdapterContext,
): Promise<AgentObservation> {
  try {
    const detection = await adapter.detect(context);
    const unhealthy = observeDetection(detection);

    if (unhealthy !== undefined) return unhealthy;

    const auth = await adapter.inspectAuth(context, detection);
    const authProblem = observeAuth(auth);

    if (authProblem !== undefined) return authProblem;

    // A provider with no cheap status check has to let the activation itself
    // report the block, so there is no double call.
    const probed =
      adapter.capabilities.probeMode === "separate"
        ? await adapter.probe(context, detection, auth)
        : ({ kind: "available" } as const);

    return probed.kind === "available"
      ? await adapter.activate(context, detection, auth)
      : probed;
  } catch {
    // An adapter that throws is a bug or a surprise, and either way it is a
    // runtime problem rather than a usage limit. Never quota backoff.
    return { kind: "runtime_error", category: "unknown" };
  }
}

function outcomeOf(agentId: AgentId, state: AgentState): AgentOutcome {
  return {
    agentId,
    phase: state.phase,
    ...(state.reason === undefined ? {} : { reason: state.reason }),
    ...(state.nextAttemptAt === undefined
      ? {}
      : { nextAttemptAt: state.nextAttemptAt }),
  };
}

/**
 * Runs the scheduler once.
 *
 * @throws {LockedError} when another run holds the lock; a scheduled tick
 * should treat that as success and exit.
 */
export async function tick(
  context: TickContext,
  options: TickOptions = {},
): Promise<TickResult> {
  const { config, store, registry, log, runtime } = context;

  return store.withLock(async () => {
    const now = context.now();
    const loaded = await store.load();
    const agents: Record<AgentId, AgentState> = { ...loaded.state.agents };
    const outcomes: AgentOutcome[] = [];

    const emit = (event: Omit<Event, "timestamp" | "runtime">): Promise<void> =>
      log.write({ ...event, timestamp: now, runtime });

    await emit({
      level: "info",
      event: "scheduler.tick",
      fields: { stateSource: loaded.source },
    });

    if (loaded.source === "backup" || loaded.source === "reset") {
      await emit({
        level: "warn",
        event: `state.${loaded.source === "backup" ? "recovered" : "reset"}`,
        fields: {
          detail:
            loaded.source === "backup"
              ? "The state file could not be read; the previous copy was used."
              : "No readable state; starting over. An agent may activate once more than it needed to today.",
        },
      });
    }

    const selected =
      options.only === undefined
        ? AGENT_IDS
        : AGENT_IDS.filter((id) => options.only?.includes(id) === true);

    for (const agentId of selected) {
      const effective: EffectiveAgentConfig = effectiveAgentConfig(
        config,
        agentId,
      );
      const rolled = rollDailyCycle(effective, agents[agentId], now);

      agents[agentId] = rolled;

      if (!effective.enabled) {
        outcomes.push({ ...outcomeOf(agentId, rolled), skipped: "disabled" });
        continue;
      }

      // Forcing skips the schedule, but a cycle that is already complete stays
      // complete: at most one successful activation per agent per local day.
      const due =
        options.force === true
          ? rolled.phase !== "activated"
          : isDue(effective, rolled, now);

      if (!due) {
        outcomes.push({ ...outcomeOf(agentId, rolled), skipped: "not_due" });
        continue;
      }

      const observation = await observe(registry.get(agentId), {
        runner: context.runner,
        workDir: context.workDir,
        now,
      });
      const next = applyObservation(effective, rolled, observation, now);

      agents[agentId] = next;
      outcomes.push(outcomeOf(agentId, next));

      await emit({
        level:
          next.phase === "activated"
            ? "info"
            : next.phase === "unhealthy" ||
                next.phase === "auth_required" ||
                next.phase === "failed"
              ? "warn"
              : "info",
        event: `agent.${next.phase}`,
        agent: agentId,
        fields: {
          ...(next.reason === undefined ? {} : { reason: next.reason }),
          ...(next.nextAttemptAt === undefined
            ? {}
            : { nextAttemptAt: new Date(next.nextAttemptAt).toISOString() }),
        },
      });
    }

    const saved: AgentWakerState = { version: 1, updatedAt: now, agents };

    await store.save(saved);

    return { at: now, agents: outcomes };
  });
}
