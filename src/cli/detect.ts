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
import { AGENT_IDS } from "#src/core/agent.js";

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

export async function detectCommand(
  context: CommandContext,
): Promise<ExitCode> {
  const { environment } = context;
  const unicode = supportsUnicode(environment.env);
  const lines: string[] = ["Supported coding agents", ""];
  let healthy = true;

  for (const agentId of AGENT_IDS) {
    const adapter = context.registry.get(agentId);
    const adapterContext = {
      runner: context.runner,
      workDir: join(context.paths.workDir, agentId),
      now: environment.now(),
    };
    const detection = await adapter.detect(adapterContext);

    lines.push(adapter.displayName);
    lines.push(`  status       ${describeStatus(detection)}`);

    if (!detection.installed) {
      healthy = false;
      lines.push("");
      continue;
    }

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

    if (detection.health !== "ok") {
      healthy = false;
      lines.push("");
      continue;
    }

    // Only worth asking once the executable answers at all.
    const auth = await adapter.inspectAuth(adapterContext, detection);

    if (!auth.supportsIntent) healthy = false;

    const mark = iconFor(auth.supportsIntent ? "activated" : "auth_required", {
      unicode,
    });

    lines.push(`  auth         ${mark} ${describeAuth(auth)}`);
    lines.push("");
  }

  environment.write(`${lines.join("\n")}\n`);

  // Reporting what is there is not a failure, but a script asking "can this
  // work right now" deserves an answer it can branch on.
  return healthy ? EXIT.ok : EXIT.partial;
}
