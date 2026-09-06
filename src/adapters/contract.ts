/**
 * What a provider adapter has to implement.
 *
 * The line this draws is the product's most important one (ADR-004): an
 * adapter reports what a provider said, and the core decides what to do about
 * it. An adapter returning "retry in ten minutes" is wrong; the same adapter
 * returning "blocked, rolling window, resets at 08:23" is right. When it cannot
 * classify a response confidently it says so, rather than guessing a reset.
 */

import type { AgentId } from "#src/core/agent.js";
import type { AgentObservation } from "#src/core/observation.js";
import type { Instant } from "#src/core/time.js";
import type { ProcessRunner } from "#src/process/runner.js";

/** What an adapter is given to work with. */
export interface AdapterContext {
  /** The only way an adapter may start a process. */
  readonly runner: ProcessRunner;
  /**
   * An empty directory to run in, so an activation cannot pick up a
   * repository's own agent instructions or modify a user's project.
   */
  readonly workDir: string;
  /** Reading the clock is the core's job; this is what it read. */
  readonly now: Instant;
}

/** Whether the provider is installed, and usable. */
export interface DetectionResult {
  readonly installed: boolean;
  /** The exact executable that was found, so diagnostics can name it. */
  readonly executable?: string;
  readonly version?: string;
  /**
   * `broken` covers an executable that exists but cannot run — the npm wrapper
   * whose underlying binary is gone is the case this exists for.
   */
  readonly health: "ok" | "broken" | "unknown";
  /** How it appears to have been installed, for remediation advice. */
  readonly installHint?: string;
}

/** How the provider is authenticated, if it is. */
export type AuthMode =
  | "subscription_local"
  | "subscription_oauth_ci"
  | "api_key"
  | "cloud_provider"
  | "unknown"
  | "none";

export interface AuthResult {
  readonly authenticated: boolean;
  /** `unknown` when the adapter cannot tell. Guessing here is forbidden. */
  readonly mode: AuthMode;
  /**
   * Whether this credential can satisfy subscription-window activation.
   *
   * False for an API key even though it would happily answer: billing a user
   * per token to warm a subscription window they are already paying for is the
   * opposite of what they asked for (ADR-005).
   */
  readonly supportsIntent: boolean;
  /** Non-identifying, for display. Never an address or a token. */
  readonly accountHint?: string;
  readonly message?: string;
}

export interface AgentCapabilities {
  /**
   * `activation_is_probe` when the provider has no cheap status check, so the
   * activation itself has to report blocked, auth and runtime outcomes.
   */
  readonly probeMode: "separate" | "activation_is_probe";
}

// ponytail: the requirements sketch several more capability flags — exact reset
// support, weekly-limit detection, GitHub Actions support. None has a consumer
// while v0.1 is macOS and local only, so they land with the command or runtime
// that reads them.

export interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly capabilities: AgentCapabilities;

  detect(context: AdapterContext): Promise<DetectionResult>;

  inspectAuth(
    context: AdapterContext,
    detection: DetectionResult,
  ): Promise<AuthResult>;

  /**
   * A cheap check that does not consume the window.
   *
   * Omitted when `probeMode` is `activation_is_probe`, which is the common
   * case: a provider that will not tell you whether you are rate limited
   * without being asked to do something.
   */
  probe?(
    context: AdapterContext,
    detection: DetectionResult,
    auth: AuthResult,
  ): Promise<AgentObservation>;

  /** The minimal interaction that establishes the session. */
  activate(
    context: AdapterContext,
    detection: DetectionResult,
    auth: AuthResult,
  ): Promise<AgentObservation>;
}
