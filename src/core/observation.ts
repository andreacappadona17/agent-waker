/**
 * What an adapter reports about a provider.
 *
 * Adapters describe facts, not decisions (ADR-004): "blocked, rolling window,
 * resets at 08:23", never "retry in ten minutes". Everything a provider says
 * arrives here, and the core alone decides what to do about it.
 */

import type { Instant } from "#src/core/time.js";

/** One reason a provider is currently refusing to run. */
export interface BlockingConstraint {
  readonly type: "rolling_window" | "weekly" | "quota" | "other";
  /** Absent when the provider did not say, which is the common case. */
  readonly resetAt?: Instant;
  /**
   * How much the adapter trusts `resetAt`.
   *
   * `low` means a guess. A guess may be shown to the user but must not be
   * allowed to suppress retries, so the core ignores it when choosing a reset.
   */
  readonly confidence: "high" | "medium" | "low";
}

/** The activation ran and the provider answered. The daily cycle is complete. */
export interface ActivatedObservation {
  readonly kind: "activated";
}

/** A probe found the window open. Nothing has run yet. */
export interface AvailableObservation {
  readonly kind: "available";
}

/** The provider refused to run because of a usage limit. */
export interface BlockedObservation {
  readonly kind: "blocked";
  readonly reason:
    "rolling_window" | "weekly_limit" | "quota" | "account" | "unknown";
  /** Every limit the adapter could identify; the core picks the latest. */
  readonly constraints: readonly BlockingConstraint[];
  /**
   * What the provider actually said, for the log.
   *
   * The single most useful line when a user asks why their morning was not
   * warmed up. Logged, never persisted: state keeps no raw provider output.
   */
  readonly detail?: string;
}

/** The provider cannot be used until the user fixes their credentials. */
export interface AuthObservation {
  readonly kind: "auth_error";
  readonly state:
    | "not_authenticated"
    | "expired"
    | "unsupported_auth"
    | "api_billing_only"
    | "unknown";
  readonly message: string;
}

/** The provider is installed wrong, missing, or would not run. */
export interface HealthObservation {
  readonly kind: "runtime_error";
  readonly category:
    | "executable_missing"
    | "dependency_missing"
    | "broken_install"
    | "permission"
    | "timeout"
    | "malformed_output"
    | "unknown";
}

/** Something outside the provider failed and is expected to recover. */
export interface TransientObservation {
  readonly kind: "transient_error";
  readonly category:
    "network" | "provider_unavailable" | "dns" | "tls" | "unknown";
}

/**
 * The adapter could not classify what it saw.
 *
 * Provider CLIs change without notice, so this is a normal outcome rather than
 * a bug. Reporting it beats guessing a reset time that is not there.
 */
export interface UnknownObservation {
  readonly kind: "unknown";
  readonly detail: string;
}

/** Everything an adapter can report, from a probe or from an activation. */
export type AgentObservation =
  | ActivatedObservation
  | AvailableObservation
  | BlockedObservation
  | AuthObservation
  | HealthObservation
  | TransientObservation
  | UnknownObservation;
