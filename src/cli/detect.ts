/**
 * `detect`: what is installed, and whether it can be used.
 *
 * Read-only by contract. It changes nothing, installs nothing, and repairs
 * nothing — a diagnostic that fixes things as a side effect is one nobody can
 * trust to tell them what state they are actually in.
 */

import { join } from "node:path";

import type { AuthResult, DetectionResult } from "#src/adapters/contract.js";
import type { CommandContext } from "#src/cli/context.js";
import { EXIT, type ExitCode } from "#src/cli/exit.js";
import { iconFor, supportsUnicode } from "#src/cli/format.js";
import { AGENT_IDS, type AgentId } from "#src/core/agent.js";

const INSTALL_HINTS: Readonly<Record<string, string>> = {
  native: "native install",
  homebrew: "Homebrew",
  npm: "npm",
  nvm: "npm via nvm",
  unknown: "unknown",
};

/** Says what the credential is, in the words a user would use. */
function describeAuth(auth: AuthResult): string {
  if (!auth.authenticated) return "not signed in";

  switch (auth.mode) {
    case "subscription_local":
    case "subscription_oauth_ci":
      return auth.accountHint === undefined
        ? "subscription"
        : `subscription (${auth.accountHint})`;
    case "api_key":
      return "API key — cannot be used for subscription activation";
    case "cloud_provider":
      return "cloud provider — cannot be used for subscription activation";
    default:
      return "unrecognised — cannot be used for subscription activation";
  }
}

function describeStatus(detection: DetectionResult): string {
  if (!detection.installed) return "not installed";

  return detection.health === "ok" ? "healthy" : "found, but will not run";
}

/** What one agent looks like right now. */
export interface AgentSurvey {
  readonly agentId: AgentId;
  readonly displayName: string;
  readonly detection: DetectionResult;
  /** Absent when the executable never answered, so nothing was asked. */
  readonly auth?: AuthResult;
  /** Installed, runnable, and signed in with something that can be used. */
  readonly ready: boolean;
}

/**
 * Asks every adapter what it finds.
 *
 * Separate from the command because `init` needs the answers rather than the
 * rendering: it default-selects the agents that are ready, and must not
 * default-select the ones that are not (UX §6.4).
 */
export async function surveyAgents(
  context: CommandContext,
): Promise<AgentSurvey[]> {
  const surveys: AgentSurvey[] = [];

  for (const agentId of AGENT_IDS) {
    const adapter = context.registry.get(agentId);
    const adapterContext = {
      runner: context.runner,
      workDir: join(context.paths.workDir, agentId),
      now: context.environment.now(),
    };
    const detection = await adapter.detect(adapterContext);
    // Only worth asking once the executable answers at all.
    const auth =
      detection.installed && detection.health === "ok"
        ? await adapter.inspectAuth(adapterContext, detection)
        : undefined;

    surveys.push({
      agentId,
      displayName: adapter.displayName,
      detection,
      ...(auth === undefined ? {} : { auth }),
      ready: auth?.supportsIntent === true,
    });
  }

  return surveys;
}

/** Renders a survey the way `detect` prints it. */
export function renderDetection(
  surveys: readonly AgentSurvey[],
  options: { unicode: boolean },
): string {
  const lines: string[] = ["Supported coding agents", ""];

  for (const { displayName, detection, auth } of surveys) {
    lines.push(displayName);
    lines.push(`  status       ${describeStatus(detection)}`);

    if (detection.installed) {
      if (detection.version !== undefined) {
        lines.push(`  version      ${detection.version}`);
      }

      if (detection.executable !== undefined) {
        lines.push(`  executable   ${detection.executable}`);
      }

      if (detection.installHint !== undefined) {
        lines.push(
          `  install      ${INSTALL_HINTS[detection.installHint] ?? detection.installHint}`,
        );
      }
    }

    if (auth !== undefined) {
      lines.push(
        `  auth         ${iconFor(
          auth.supportsIntent ? "activated" : "auth_required",
          options,
        )} ${describeAuth(auth)}`,
      );
    }

    lines.push("");
  }

  return lines.join("\n");
}

export async function detectCommand(
  context: CommandContext,
): Promise<ExitCode> {
  const { environment } = context;
  const surveys = await surveyAgents(context);

  environment.write(
    `${renderDetection(surveys, { unicode: supportsUnicode(environment.env) })}\n`,
  );

  // Reporting what is there is not a failure, but a script asking "can this
  // work right now" deserves an answer it can branch on.
  return surveys.every((survey) => survey.ready) ? EXIT.ok : EXIT.partial;
}
