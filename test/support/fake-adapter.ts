/**
 * A scriptable adapter, so the orchestrator can be tested end to end without
 * a provider, a network or anybody's quota.
 *
 * Each step is a queue: give it what the provider should say on the first
 * call, the second, and so on. A step with nothing queued repeats its last
 * answer, which keeps a test that only cares about one call short.
 */

import type {
  AgentAdapter,
  AuthResult,
  DetectionResult,
} from "#src/adapters/contract.js";
import type { AgentId } from "#src/core/agent.js";
import type { AgentObservation } from "#src/core/observation.js";

export interface FakeScript {
  readonly detect?: readonly (DetectionResult | Error)[];
  readonly auth?: readonly (AuthResult | Error)[];
  readonly probe?: readonly (AgentObservation | Error)[];
  readonly activate?: readonly (AgentObservation | Error)[];
  readonly probeMode?: "separate" | "activation_is_probe";
}

export interface FakeAdapter extends AgentAdapter {
  /** How many times each step was called, so a test can assert what ran. */
  readonly calls: {
    detect: number;
    auth: number;
    probe: number;
    activate: number;
  };
}

const INSTALLED: DetectionResult = {
  installed: true,
  executable: "/usr/local/bin/fake",
  version: "1.0.0",
  health: "ok",
};

const SUBSCRIBED: AuthResult = {
  authenticated: true,
  mode: "subscription_local",
  supportsIntent: true,
};

/** Takes the answer for this call, repeating the last one once the list runs out. */
function step<T>(
  script: readonly (T | Error)[] | undefined,
  index: number,
  fallback: T,
): T {
  const answer =
    script === undefined || script.length === 0
      ? fallback
      : (script[Math.min(index, script.length - 1)] ?? fallback);

  if (answer instanceof Error) throw answer;

  return answer;
}

export function createFakeAdapter(
  id: AgentId,
  script: FakeScript = {},
): FakeAdapter {
  const calls = { detect: 0, auth: 0, probe: 0, activate: 0 };

  return {
    id,
    displayName: `Fake ${id}`,
    capabilities: { probeMode: script.probeMode ?? "separate" },
    calls,

    detect(): Promise<DetectionResult> {
      const index = calls.detect++;

      return Promise.resolve(step(script.detect, index, INSTALLED));
    },

    inspectAuth(): Promise<AuthResult> {
      const index = calls.auth++;

      return Promise.resolve(step(script.auth, index, SUBSCRIBED));
    },

    probe(): Promise<AgentObservation> {
      const index = calls.probe++;

      return Promise.resolve(step(script.probe, index, { kind: "available" }));
    },

    activate(): Promise<AgentObservation> {
      const index = calls.activate++;

      return Promise.resolve(
        step(script.activate, index, { kind: "activated" }),
      );
    },
  };
}
