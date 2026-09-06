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

import { join } from "node:path";

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
  needsAttention,
  rollDailyCycle,
  type AgentPhase,
  type AgentState,
  type AgentWakerState,
} from "#src/core/state.js";
import type { Instant } from "#src/core/time.js";
import type { Event, EventLog } from "#src/logging/log.js";
import type { ProcessRunner, ProcessResult } from "#src/process/runner.js";
import type { Span, Telemetry } from "#src/telemetry/otlp.js";
import type { StateStore } from "#src/state/store.js";

export interface TickContext {
  readonly config: AgentWakerConfig;
  readonly store: StateStore;
  readonly registry: AdapterRegistry;
  readonly log: EventLog;
  /** OTLP export, or `NO_TELEMETRY` when it is not configured, which is usual. */
  readonly telemetry: Telemetry;
  readonly runner: ProcessRunner;
  /** An empty directory for adapters to run providers in. */
  readonly workDir: string;
  readonly runtime: "local" | "github";
  /** Read once per tick, so every decision in it shares one instant. */
  readonly now: () => Instant;
  /**
   * A moving clock, for measuring how long things took.
   *
   * Separate from `now` because that one is deliberately frozen: every
   * scheduling decision in a tick shares one instant, which would make every
   * measured duration zero.
   */
  readonly wallClock: () => number;
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
  /**
   * Whether the tick said anything above `debug`.
   *
   * A no-op tick is silent by design (ARCHITECTURE §34); this is how a caller
   * tells that apart from a tick worth reporting, without re-deriving the rule
   * from the outcomes.
   */
  readonly notable: boolean;
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

/**
 * Wraps a runner so every provider call becomes a span and an exit code.
 *
 * The adapter contract deliberately has no place for either: an adapter
 * reports what a provider said, not how it was invoked (ADR-004). They are
 * still the two fields an operator asks for first when an activation is slow
 * or a wrapper is broken, so they are taken here, where the process actually
 * starts, rather than pushed into the contract.
 */
function recordingRunner(
  runner: ProcessRunner,
  span: Span,
): {
  readonly runner: ProcessRunner;
  lastExitCode(): number | null | undefined;
} {
  let last: number | null | undefined;

  return {
    runner: {
      async run(spec) {
        // The executable path is a diagnostic. The arguments are not recorded:
        // an activation prompt is not something to send to a collector.
        const child = span.span("provider.exec", {
          "process.executable.path": spec.executable,
          "process.timeout_ms": spec.timeoutMs,
        });
        let result: ProcessResult;

        // Cleared first, so a call that throws does not leave the previous
        // call's exit code standing in for it.
        last = undefined;

        try {
          result = await runner.run(spec);
        } catch (error) {
          child.end({
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        last = result.exitCode ?? undefined;
        // A table, not a pile of conditional spreads: an attribute that is
        // `undefined` is dropped on the way out, including a null exit code,
        // which OTLP has no representation for.
        child.end({
          attributes: {
            "process.exit_code": last,
            "process.duration_ms": result.durationMs,
            "process.signal": result.signal ?? undefined,
            "process.timed_out": result.timedOut ? true : undefined,
            "process.start_failure": result.startFailure,
          },
          ...(result.startFailure === undefined
            ? {}
            : { error: result.startFailure }),
        });

        return result;
      },
    },
    lastExitCode: () => last,
  };
}

/** Why this agent will not be evaluated, or nothing when it will be. */
function skipReason(
  effective: EffectiveAgentConfig,
  rolled: AgentState,
  now: Instant,
  force: boolean,
): AgentOutcome["skipped"] {
  if (!effective.enabled) return "disabled";

  // Forcing skips the schedule, but a cycle that is already complete stays
  // complete: at most one successful activation per agent per local day.
  const due = force
    ? rolled.phase !== "activated"
    : isDue(effective, rolled, now);

  return due ? undefined : "not_due";
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
      adapter.capabilities.probeMode === "separate" &&
      adapter.probe !== undefined
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
  const { config, store, registry, log, runtime, telemetry, wallClock } =
    context;

  return store.withLock(async () => {
    const now = context.now();
    const root = telemetry.span("agent_waker.tick", {
      "agent_waker.runtime": runtime,
      "agent_waker.forced": options.force === true,
    });
    const loaded = await store.load();
    const agents: Record<AgentId, AgentState> = { ...loaded.state.agents };
    const outcomes: AgentOutcome[] = [];

    // One event, two sinks. Telemetry sees what the log sees rather than a
    // second stream to keep in step, and the span it is attached to is what
    // ties a log line to the provider call it came from.
    let notable = false;

    const emit = (
      event: Omit<Event, "timestamp" | "runtime">,
      span: Span = root,
    ): Promise<void> => {
      const full: Event = { ...event, timestamp: now, runtime };

      notable ||= full.level !== "debug";
      span.log(full);

      return log.write(full);
    };

    const selected =
      options.only === undefined
        ? AGENT_IDS
        : AGENT_IDS.filter((id) => options.only?.includes(id) === true);

    const plan = selected.map((agentId) => {
      const effective: EffectiveAgentConfig = effectiveAgentConfig(
        config,
        agentId,
      );
      const rolled = rollDailyCycle(effective, agents[agentId], now);

      return {
        agentId,
        effective,
        rolled,
        skipped: skipReason(effective, rolled, now, options.force === true),
      };
    });

    // Every cycle rolls before anything is said, so the tick knows whether it
    // is a no-op before it announces itself. A minute-level scheduler that
    // logs at `info` every minute drowns the log it exists to write
    // (ARCHITECTURE §34). Rolling is pure, so this costs nothing.
    for (const { agentId, rolled } of plan) agents[agentId] = rolled;

    const evaluated = plan.filter((entry) => entry.skipped === undefined);

    await emit({
      level: evaluated.length === 0 ? "debug" : "info",
      event: "scheduler.tick",
      fields: {
        stateSource: loaded.source,
        due: evaluated.length,
        skipped: plan.length - evaluated.length,
      },
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

    for (const { agentId, effective, rolled, skipped } of plan) {
      if (skipped !== undefined) {
        outcomes.push({ ...outcomeOf(agentId, rolled), skipped });
        continue;
      }

      const span = root.span("agent.activation", { "agent.id": agentId });
      const recording = recordingRunner(context.runner, span);
      const startedAt = wallClock();

      const observation = await observe(registry.get(agentId), {
        runner: recording.runner,
        // Its own directory, so one provider cannot read what another left.
        workDir: join(context.workDir, agentId),
        now,
      });
      const durationMs = wallClock() - startedAt;
      const next = applyObservation(effective, rolled, observation, now);
      // The provider's own words go to the log and no further: state holds the
      // classification, not raw output.
      const detail =
        observation.kind === "blocked" || observation.kind === "unknown"
          ? observation.detail
          : undefined;
      const exitCode = recording.lastExitCode();
      const attention = needsAttention(next.phase);

      agents[agentId] = next;
      outcomes.push(outcomeOf(agentId, next));

      await emit(
        {
          level: attention ? "warn" : "info",
          event: `agent.${next.phase}`,
          agent: agentId,
          fields: {
            ...(next.reason === undefined ? {} : { reason: next.reason }),
            ...(detail === undefined ? {} : { detail }),
            durationMs,
            ...(exitCode === undefined ? {} : { exitCode }),
            ...(next.nextAttemptAt === undefined
              ? {}
              : { nextAttemptAt: new Date(next.nextAttemptAt).toISOString() }),
          },
        },
        span,
      );

      span.end({
        attributes: {
          "agent.phase": next.phase,
          "agent.observation": observation.kind,
          "agent.duration_ms": durationMs,
          "agent.reason": next.reason,
          "agent.next_attempt_at":
            next.nextAttemptAt === undefined
              ? undefined
              : new Date(next.nextAttemptAt).toISOString(),
        },
        // Deferment is not a failure (UX §2.3); only something a person has to
        // fix marks the span as one. The phase says which, and `agent.reason`
        // above says why.
        ...(attention ? { error: next.phase } : {}),
      });
    }

    const saved: AgentWakerState = { version: 1, updatedAt: now, agents };

    await store.save(saved);
    root.end({
      attributes: { "agent_waker.agents_evaluated": evaluated.length },
    });

    return { at: now, agents: outcomes, notable };
  });
}
