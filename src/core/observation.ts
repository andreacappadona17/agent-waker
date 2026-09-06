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
