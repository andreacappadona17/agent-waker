/**
 * A scriptable adapter, so the orchestrator can be tested end to end without
 * a provider, a network or anybody's quota.
 *
 * Each step is a queue: give it what the provider should say on the first
 * call, the second, and so on. A step with nothing queued repeats its last
 * answer, which keeps a test that only cares about one call short.
 */

import type {
  AdapterContext,
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
  /**
   * Executables to run during `detect`.
   *
   * A real adapter learns everything by starting a process. This is how a test
   * makes the fake one do the same, so the runner the orchestrator hands over
   * is actually used.
   */
  readonly exec?: readonly string[];
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

  const probeMode = script.probeMode ?? "separate";

  return {
    id,
    displayName: `Fake ${id}`,
    capabilities: { probeMode },
    calls,

    async detect(context: AdapterContext): Promise<DetectionResult> {
      const index = calls.detect++;

      for (const executable of script.exec ?? []) {
        await context.runner.run({ executable, args: [], timeoutMs: 1_000 });
      }

      return step(script.detect, index, INSTALLED);
    },

    inspectAuth(): Promise<AuthResult> {
      const index = calls.auth++;

      return Promise.resolve(step(script.auth, index, SUBSCRIBED));
    },

    // Omitted entirely when the activation is the probe, which is what a real
    // adapter does rather than shipping a method nothing calls.
    ...(probeMode === "activation_is_probe"
      ? {}
      : {
          probe(): Promise<AgentObservation> {
            const index = calls.probe++;

            return Promise.resolve(
              step(script.probe, index, { kind: "available" }),
            );
          },
        }),

    activate(): Promise<AgentObservation> {
      const index = calls.activate++;

      return Promise.resolve(
        step(script.activate, index, { kind: "activated" }),
      );
    },
  };
}
