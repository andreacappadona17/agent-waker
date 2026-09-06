/**
 * The Claude Code adapter.
 *
 * Claude Code answers `claude auth status --json` and `claude -p ...
 * --output-format json` with structured documents, so almost nothing here
 * matches message text. That matters: provider CLIs change their wording
 * without notice, and a scheduler that guesses at prose gets a user's morning
 * wrong quietly.
 *
 * Where a response cannot be classified from its structure, it is reported as
 * unclassified rather than guessed. Unclassified is not a usage limit, so it
 * never starts a five-hour backoff.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AdapterContext,
  AgentAdapter,
  AuthResult,
  DetectionResult,
} from "#src/adapters/contract.js";
import type { AgentObservation } from "#src/core/observation.js";
import {
  discoverExecutable,
  type ExecutableDiscovery,
} from "#src/process/discovery.js";
import { TIMEOUTS, type ProcessResult } from "#src/process/runner.js";

const EXECUTABLE = "claude";

/** Trivial, tool-free, and cheap: the window is what is wanted, not an answer. */
export const ACTIVATION_PROMPT = "Respond with OK only.";

/** How much of a message is worth keeping for the log. */
const MAX_DETAIL_LENGTH = 300;

/** Read as JSON, or `undefined` when the output is not a JSON object. */
function asObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function clip(text: string): string {
  return text.length <= MAX_DETAIL_LENGTH
    ? text
    : `${text.slice(0, MAX_DETAIL_LENGTH)}…`;
}

/**
 * Reads `claude auth status --json`.
 *
 * Fails closed. Only a first-party claude.ai session is allowed to satisfy
 * subscription activation; anything else — a console credential, Bedrock,
 * Vertex, an unrecognised shape — is reported as authenticated but unusable,
 * so the orchestrator declines rather than sending a request somebody pays for
 * by the token.
 *
 * The real response carries an e-mail address, an organisation name and an
 * organisation id. None of them is repeated here.
 */
export function parseAuthStatus(result: ProcessResult): AuthResult {
  const status = result.exitCode === 0 ? asObject(result.stdout) : undefined;

  if (status === undefined) {
    return {
      authenticated: false,
      mode: "unknown",
      supportsIntent: false,
      message: "Could not read the authentication status.",
    };
  }

  if (status.loggedIn !== true) {
    return { authenticated: false, mode: "none", supportsIntent: false };
  }

  const authMethod = status.authMethod;
  const apiProvider = status.apiProvider;

  if (authMethod === "claude.ai" && apiProvider === "firstParty") {
    const plan = status.subscriptionType;

    return {
      authenticated: true,
      mode: "subscription_local",
      supportsIntent: true,
      // The plan name is not identifying, and it is what a user recognises.
      ...(typeof plan === "string" ? { accountHint: plan } : {}),
    };
  }

  return {
    authenticated: true,
    mode: "unknown",
    supportsIntent: false,
    message: `Signed in with ${String(authMethod)} via ${String(apiProvider)}, which cannot be used for subscription activation.`,
  };
}

/** Maps a process that never really ran onto the runtime vocabulary. */
function processFailure(result: ProcessResult): AgentObservation | undefined {
  if (result.timedOut) {
    return { kind: "runtime_error", category: "timeout" };
  }

  switch (result.startFailure) {
    case undefined:
      return undefined;
    case "ENOENT":
      return { kind: "runtime_error", category: "executable_missing" };
    case "ENOEXEC":
    case "EACCES":
      return { kind: "runtime_error", category: "broken_install" };
    default:
      return { kind: "runtime_error", category: "unknown" };
  }
}

/**
 * Reads the result document `claude -p --output-format json` prints.
 *
 * Classification comes from `is_error` and `api_error_status`, never from the
 * text of a message. The status field is mapped by its HTTP meaning, which is
 * a standard rather than a provider's phrasing, and a code with no rule is
 * reported as unclassified.
 */
export function parseActivation(result: ProcessResult): AgentObservation {
  const failure = processFailure(result);

  if (failure !== undefined) return failure;

  const document = asObject(result.stdout);

  if (document === undefined) {
    return { kind: "runtime_error", category: "malformed_output" };
  }

  if (document.is_error === false && document.subtype === "success") {
    return { kind: "activated" };
  }

  const detail = clip(
    typeof document.result === "string"
      ? document.result
      : "Claude Code reported a failure with no message.",
  );
  const status = document.api_error_status;

  if (status === 429) {
    // Rate limited. No reset time is offered in this document, so the core
    // walks its backoff ladder rather than being told when to come back.
    return {
      kind: "blocked",
      reason: "rolling_window",
      constraints: [{ type: "rolling_window", confidence: "high" }],
      detail,
    };
  }

  if (status === 401 || status === 403) {
    return { kind: "auth_error", state: "expired", message: detail };
  }

  if (typeof status === "number" && status >= 500) {
    return { kind: "transient_error", category: "provider_unavailable" };
  }

  // ponytail: no rule for a subscription-window exhaustion message, because no
  // fixture of one has been captured. Unclassified is the honest answer and
  // costs an hourly recheck rather than a wrong five-hour wait. Add the rule
  // with the fixture.
  return { kind: "unknown", detail };
}

/** Places Claude Code installs itself that a stripped PATH may not include. */
function fallbackDirectories(): string[] {
  const home = homedir();

  return [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

/** Trims the version line down to the version, when there is one to find. */
function versionOf(line: string | undefined): string | undefined {
  return /^\d+\.\d+\.\d+/.exec(line ?? "")?.[0] ?? line;
}

/**
 * Turns what discovery found into what the orchestrator asks about.
 *
 * A found-but-unrunnable executable is `broken` rather than absent, because
 * the two need different advice: one is "install it", the other is "your
 * wrapper outlived its runtime".
 */
export function toDetection(found: ExecutableDiscovery): DetectionResult {
  if (!found.installed || found.selected === undefined) {
    return { installed: false, health: "unknown" };
  }

  const version = versionOf(found.version);

  return {
    installed: true,
    executable: found.selected.path,
    health: found.health === "healthy" ? "ok" : "broken",
    installHint: found.selected.installHint,
    ...(version === undefined ? {} : { version }),
  };
}

export function createClaudeAdapter(): AgentAdapter {
  return {
    id: "claude",
    displayName: "Claude Code",
    // There is no status command that reports usage, so the activation is the
    // availability check. Asking twice would cost twice.
    capabilities: { probeMode: "activation_is_probe" },

    async detect(context: AdapterContext): Promise<DetectionResult> {
      return toDetection(
        await discoverExecutable(EXECUTABLE, {
          runner: context.runner,
          fallbackDirectories: fallbackDirectories(),
        }),
      );
    },

    async inspectAuth(
      context: AdapterContext,
      detection: DetectionResult,
    ): Promise<AuthResult> {
      return parseAuthStatus(
        await context.runner.run({
          executable: detection.executable ?? EXECUTABLE,
          args: ["auth", "status", "--json"],
          cwd: context.workDir,
          timeoutMs: TIMEOUTS.probe,
        }),
      );
    },

    async activate(
      context: AdapterContext,
      detection: DetectionResult,
    ): Promise<AgentObservation> {
      return parseActivation(
        await context.runner.run({
          executable: detection.executable ?? EXECUTABLE,
          args: [
            "-p",
            ACTIVATION_PROMPT,
            "--output-format",
            "json",
            // No shell or code tools, and no MCP servers from the user's own
            // configuration: the activation must not be able to touch anything.
            "--restricted",
            "--strict-mcp-config",
          ],
          cwd: context.workDir,
          timeoutMs: TIMEOUTS.activate,
        }),
      );
    },
  };
}
