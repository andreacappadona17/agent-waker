/**
 * The Codex adapter.
 *
 * Codex streams JSONL events rather than printing one result document, and its
 * login status is a line of prose. So success is taken from the exit status,
 * which the requirements prefer anyway, and only the failure path looks at
 * messages — for the one phrase there is a captured fixture of.
 *
 * Everything else is reported as unclassified. That is not a usage limit, so
 * it never starts a five-hour backoff, and adding a rule later means adding a
 * fixture first.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AdapterContext,
  AgentAdapter,
  AuthResult,
  DetectionResult,
} from "#src/adapters/contract.js";
import {
  missingFlags,
  processFailure,
  toDetection,
} from "#src/adapters/detection.js";
import type { AgentObservation } from "#src/core/observation.js";
import { discoverExecutable } from "#src/process/discovery.js";
import { TIMEOUTS, type ProcessResult } from "#src/process/runner.js";

const EXECUTABLE = "codex";

export const ACTIVATION_PROMPT = "Respond with OK only.";

/**
 * The activation, as a command line.
 *
 * The smoke test reads its flags back off this array, so there is no second
 * list of them to drift out of step with what is actually passed.
 */
const ACTIVATION_ARGS = [
  "exec",
  ACTIVATION_PROMPT,
  "--json",
  // The working directory is a scratch directory, not a repository.
  "--skip-git-repo-check",
  "--sandbox",
  "read-only",
  // A session that leaves nothing behind, which is all a warmup needs.
  "--ephemeral",
] as const;

const MAX_DETAIL_LENGTH = 300;

/** The plan-backed session, which is the only one that warms a usage window. */
const CHATGPT_SESSION = /chatgpt/i;

/**
 * The only failure phrasing there is a captured fixture of.
 *
 * From a real run: "You've hit your usage limit. Upgrade to Pro (…), visit …
 * to purchase more credits or try again at 9:14 PM."
 */
const USAGE_LIMIT = /usage limit/i;

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

function clip(text: string): string {
  return text.length <= MAX_DETAIL_LENGTH
    ? text
    : `${text.slice(0, MAX_DETAIL_LENGTH)}…`;
}

/**
 * Reads `codex login status`.
 *
 * Fails closed. A plan session is recognised; anything else is reported as
 * authenticated but unusable and quoted verbatim, because Codex can also be
 * logged in with an API key, which bills per token and does nothing for the
 * plan's usage window.
 */
export function parseLoginStatus(result: ProcessResult): AuthResult {
  // Observed: `codex login status` exits zero and prints the line on stderr,
  // leaving stdout empty. Both streams are read, so this keeps working if a
  // later version moves it to stdout where it belongs.
  const line = firstLine(result.stdout) || firstLine(result.stderr);

  if (result.exitCode !== 0 || line === "") {
    return { authenticated: false, mode: "none", supportsIntent: false };
  }

  if (CHATGPT_SESSION.test(line)) {
    return {
      authenticated: true,
      mode: "subscription_local",
      supportsIntent: true,
    };
  }

  return {
    authenticated: true,
    mode: "unknown",
    supportsIntent: false,
    message: `Codex reported: ${clip(line)}. That cannot be used for subscription activation.`,
  };
}

/** Every message Codex emitted, newest last. */
function messagesFrom(stdout: string): string[] {
  const messages: string[] = [];

  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;

    let event: unknown;

    try {
      event = JSON.parse(line);
    } catch {
      // A progress line or a partial write. Events are what matter.
      continue;
    }

    if (typeof event !== "object" || event === null || Array.isArray(event))
      continue;

    const record = event as {
      message?: unknown;
      error?: { message?: unknown };
    };
    const message = record.error?.message ?? record.message;

    if (typeof message === "string") messages.push(message);
  }

  return messages;
}

/** Reads the outcome of `codex exec --json`. */
export function parseActivation(result: ProcessResult): AgentObservation {
  const failure = processFailure(result);

  if (failure !== undefined) return failure;

  // Success comes from the process, not from the stream: the requirements ask
  // for exactly that, and it cannot be broken by an event being renamed.
  if (result.exitCode === 0) return { kind: "activated" };

  const detail = clip(
    messagesFrom(result.stdout).at(-1) ?? "Codex exited without reporting why.",
  );

  if (USAGE_LIMIT.test(detail)) {
    // The real message ends "try again at 9:14 PM" — a bare clock time with no
    // date and no zone. Turning that into an instant would be a guess, and a
    // guessed reset is low confidence, which the policy ignores. So no reset is
    // reported and the backoff ladder runs, while the message itself reaches
    // the log where a person can read the time for themselves.
    return {
      kind: "blocked",
      reason: "quota",
      constraints: [{ type: "quota", confidence: "high" }],
      detail,
    };
  }

  // ponytail: no rules for authentication or network failures during an
  // activation, because no fixture of either has been captured. `codex login
  // status` already covers the authentication case before it gets this far.
  // Unclassified costs an hourly recheck; add each rule with its fixture.
  return { kind: "unknown", detail };
}

/** Places Codex installs itself that a stripped PATH may not include. */
function fallbackDirectories(): string[] {
  const home = homedir();

  return [
    join(home, ".local", "bin"),
    join(home, ".codex", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

export function createCodexAdapter(): AgentAdapter {
  return {
    id: "codex",
    displayName: "Codex CLI",
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
      return parseLoginStatus(
        await context.runner.run({
          executable: detection.executable ?? EXECUTABLE,
          args: ["login", "status"],
          cwd: context.workDir,
          timeoutMs: TIMEOUTS.probe,
        }),
      );
    },

    async smokeTest(context, detection): Promise<readonly string[]> {
      // A `--help` that will not run offers nothing, so every flag comes back
      // missing — which is the answer the check wanted anyway, without a
      // branch for it.
      const help = await context.runner.run({
        executable: detection.executable ?? EXECUTABLE,
        args: ["exec", "--help"],
        cwd: context.workDir,
        timeoutMs: TIMEOUTS.detect,
      });

      return missingFlags(help.stdout + help.stderr, ACTIVATION_ARGS);
    },

    async activate(
      context: AdapterContext,
      detection: DetectionResult,
    ): Promise<AgentObservation> {
      return parseActivation(
        await context.runner.run({
          executable: detection.executable ?? EXECUTABLE,
          args: ACTIVATION_ARGS,
          cwd: context.workDir,
          // Observed: with stdin open, `codex exec` reports that it is reading
          // additional input and waits. In a scheduled run that is a hung tick.
          stdin: "closed",
          timeoutMs: TIMEOUTS.activate,
        }),
      );
    },
  };
}
