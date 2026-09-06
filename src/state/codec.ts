/**
 * Converts between the in-memory state and the JSON written to disk.
 *
 * Timestamps are ISO-8601 in the file and milliseconds in memory. The file is
 * meant to be opened and understood — state is inspectable and disposable — and
 * epoch milliseconds are neither readable nor explicit about the zone.
 *
 * Decoding is strict. A file that cannot be trusted is better rejected here, so
 * the store can fall back to the backup, than half-read into a state machine
 * that then makes decisions from it.
 */

import { AGENT_IDS, type AgentId } from "#src/core/agent.js";
import { describeValue } from "#src/core/describe.js";
import {
  AGENT_PHASES,
  type AgentPhase,
  type AgentState,
  type AgentWakerState,
} from "#src/core/state.js";
import type { Instant } from "#src/core/time.js";

/** Raised when a state file cannot be read as state. */
export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateError";
  }
}

/** The instant fields, named once so encoding and decoding cannot drift. */
const INSTANT_FIELDS = [
  "firstAttemptAt",
  "lastAttemptAt",
  "lastActivationAt",
  "blockedUntil",
  "nextAttemptAt",
  "retryHorizonEndsAt",
] as const;

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Renders the state as the plain object that gets written to the file. */
export function encodeState(state: AgentWakerState): unknown {
  const agents: Record<string, unknown> = {};

  for (const agentId of AGENT_IDS) {
    agents[agentId] = encodeAgent(state.agents[agentId]);
  }

  return {
    version: state.version,
    updatedAt: new Date(state.updatedAt).toISOString(),
    agents,
  };
}

function encodeAgent(state: AgentState): Record<string, unknown> {
  const encoded: Record<string, unknown> = { phase: state.phase };

  if (state.cycleDate !== undefined) encoded.cycleDate = state.cycleDate;
  if (state.reason !== undefined) encoded.reason = state.reason;
  if (state.retryIndex !== undefined) encoded.retryIndex = state.retryIndex;

  for (const field of INSTANT_FIELDS) {
    const value = state[field];

    if (value !== undefined) encoded[field] = new Date(value).toISOString();
  }

  return encoded;
}

function reject(what: string, value: unknown): never {
  throw new InvalidStateError(
    `Expected ${what}, but found ${describeValue(value)}.`,
  );
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject(what, value);
  }

  return value as Record<string, unknown>;
}

/** Parses an ISO-8601 timestamp. Numbers are refused, not coerced. */
function asInstant(value: unknown, what: string): Instant {
  if (typeof value !== "string") reject(what, value);

  const instant = Date.parse(value);

  if (Number.isNaN(instant)) reject(what, value);

  return instant;
}

function asPhase(value: unknown, agentId: AgentId): AgentPhase {
  if (!(AGENT_PHASES as readonly unknown[]).includes(value)) {
    reject(`a known phase for ${agentId}`, value);
  }

  return value as AgentPhase;
}

/**
 * Reads a state file.
 *
 * @throws {InvalidStateError} for anything that is not a state document this
 * build understands, including one written by a newer version.
 */
export function decodeState(raw: unknown): AgentWakerState {
  const document = asRecord(raw, "a state object");

  if (document.version !== 1) {
    throw new InvalidStateError(
      `This state file says version ${describeValue(document.version)}; ` +
        `this build understands version 1. A newer agent waker may have written it.`,
    );
  }

  const encodedAgents = asRecord(document.agents, "an agents object");
  const agents = {} as Record<AgentId, AgentState>;

  for (const agentId of AGENT_IDS) {
    const entry = encodedAgents[agentId];

    // An agent the file never mentions has simply never run. One this build
    // does not know was written by a newer version, and is dropped: state is
    // disposable, so forgetting it beats refusing to start.
    agents[agentId] =
      entry === undefined
        ? { phase: "idle" }
        : decodeAgent(asRecord(entry, `an object for ${agentId}`), agentId);
  }

  return {
    version: 1,
    updatedAt: asInstant(document.updatedAt, "an ISO-8601 updatedAt"),
    agents,
  };
}

function decodeAgent(
  encoded: Record<string, unknown>,
  agentId: AgentId,
): AgentState {
  const phase = asPhase(encoded.phase, agentId);
  const state: Record<string, unknown> = {};

  const cycleDate = encoded.cycleDate;

  if (cycleDate !== undefined) {
    if (typeof cycleDate !== "string" || !LOCAL_DATE_PATTERN.test(cycleDate)) {
      reject(`a YYYY-MM-DD cycleDate for ${agentId}`, cycleDate);
    }

    state.cycleDate = cycleDate;
  }

  const reason = encoded.reason;

  if (reason !== undefined) {
    if (typeof reason !== "string") reject(`a reason for ${agentId}`, reason);

    state.reason = reason;
  }

  const retryIndex = encoded.retryIndex;

  if (retryIndex !== undefined) {
    if (!Number.isInteger(retryIndex) || (retryIndex as number) < 0) {
      reject(`a whole retryIndex for ${agentId}`, retryIndex);
    }

    state.retryIndex = retryIndex;
  }

  for (const field of INSTANT_FIELDS) {
    const value = encoded[field];

    if (value !== undefined) {
      state[field] = asInstant(value, `an ISO-8601 ${field} for ${agentId}`);
    }
  }

  // Phase is attached last rather than filtered in, so it stays statically
  // present and the result needs no cast.
  return Object.assign({ phase }, state);
}
