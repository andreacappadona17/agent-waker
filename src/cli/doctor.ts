/**
 * `doctor`: what is wrong, and what to do about it.
 *
 * A composition of checks rather than a separate code path, so what it reports
 * is what the scheduler actually does. It changes nothing on this machine: it
 * never reinstalls a provider, never restores a file macOS removed, and never
 * changes a setting. A diagnostic that repairs things as it goes cannot be
 * trusted to say what state a machine was in. The one thing it sends is a
 * probe span, and only to a collector the user configured.
 *
 * Remediation is provider-neutral and specific. "Reinstall through an official
 * method" is advice; a command that bypasses a security control is not.
 */

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { schedulerFor, type CommandContext } from "#src/cli/context.js";
import { EXIT, type ExitCode } from "#src/cli/exit.js";
import { iconFor, supportsUnicode } from "#src/cli/format.js";
import { AGENT_IDS, type AgentId } from "#src/core/agent.js";

type Outcome = "pass" | "warn" | "fail";

export interface Check {
  readonly name: string;
  readonly outcome: Outcome;
  /** A path or an exit code; whatever makes the result checkable. */
  readonly evidence?: string;
  /** What the user should do. Absent when there is nothing to do. */
  readonly advice?: readonly string[];
}

export interface Section {
  readonly title: string;
  readonly checks: readonly Check[];
}

const MARK: Readonly<
  Record<Outcome, "activated" | "auth_required" | "unhealthy">
> = {
  pass: "activated",
  warn: "auth_required",
  fail: "unhealthy",
};

/**
 * Whether state can be written back.
 *
 * `access` and nothing else — no probe file and no `mkdir`. A diagnostic that
 * creates the directory it is asking about would be reporting on a machine it
 * had just changed, and would create `~/.local` on the way.
 */
async function writableCheck(directory: string): Promise<Check> {
  const denied = await access(directory, constants.W_OK | constants.X_OK).then(
    () => undefined,
    (error: unknown) => (error as NodeJS.ErrnoException).code ?? "EACCES",
  );

  // Absent is a first run, not a fault: the store creates the directory, with
  // the mode it wants, the first time it saves.
  return denied === undefined || denied === "ENOENT"
    ? {
        name: "state can be written",
        outcome: "pass",
        evidence: directory,
      }
    : {
        name: "state cannot be written",
        outcome: "fail",
        evidence: `${denied}: ${directory}`,
        advice: [
          "agent waker cannot record what it has done, so an agent may be",
          "activated more than once a day, or not at all. Check the ownership",
          "and permissions of:",
          "",
          `  ${directory}`,
        ],
      };
}

/** The scheduler's own health: configuration, state, and the LaunchAgent. */
async function schedulerSection(context: CommandContext): Promise<Section> {
  const checks: Check[] = [
    // Reaching here at all means the file parsed; saying so is still worth a
    // line, because it is the first thing a user wonders about.
    {
      name: "configuration is valid",
      outcome: "pass",
      evidence: context.paths.config,
    },
  ];

  const loaded = await context.store.load();

  checks.push(
    loaded.source === "reset"
      ? {
          name: "state is readable",
          outcome: "warn",
          evidence: context.paths.stateDir,
          advice: [
            "No readable state was found, so agent waker has started over.",
            "An agent may activate once more today than it needed to.",
          ],
        }
      : {
          name:
            loaded.source === "backup"
              ? "state recovered from the backup copy"
              : "state is readable",
          outcome: loaded.source === "backup" ? "warn" : "pass",
          evidence: context.paths.stateDir,
        },
  );

  // Readable is not enough: a tick that cannot save has spent a provider turn
  // and lost the record of spending it, which is the one failure that costs
  // the user something real.
  checks.push(await writableCheck(context.paths.stateDir));

  const scheduler = await schedulerFor(context).inspect();

  if (!scheduler.installed) {
    checks.push({
      name: "scheduler is not installed",
      outcome: "fail",
      advice: [
        "Nothing is waking agent waker, so no activation will happen.",
        "Install it with:",
        "",
        "  agent-waker init",
      ],
    });
  } else if (scheduler.stalePath) {
    // The Node-upgrade case: it looks installed and does nothing.
    checks.push({
      name: "scheduler points at a launcher that has gone",
      outcome: "fail",
      evidence: scheduler.launcherPath,
      advice: [
        "The scheduler points at a launcher that is no longer there, usually",
        "after agent waker was reinstalled or moved. Rebuild it with:",
        "",
        "  agent-waker init --repair",
      ],
    });
  } else {
    checks.push({
      name: "scheduler is installed",
      outcome: "pass",
      evidence: scheduler.plistPath,
    });
    checks.push({
      name: scheduler.loaded
        ? "scheduler is loaded"
        : "scheduler is installed but not loaded",
      outcome: scheduler.loaded ? "pass" : "fail",
      ...(scheduler.loaded
        ? {}
        : {
            advice: [
              "The job is installed but launchd has not loaded it. Reinstall with:",
              "",
              "  agent-waker init --repair",
            ],
          }),
    });
  }

  return { title: "Scheduler", checks };
}

/**
 * The export, when one is configured.
 *
 * A real span rather than a connection test: reaching the port proves nothing
 * about whether the collector accepts this payload or this credential, which
 * are the two things that actually go wrong.
 */
async function telemetrySection(
  context: CommandContext,
): Promise<Section | undefined> {
  if (context.config.telemetry === undefined) return undefined;

  const { endpoint } = context.config.telemetry;

  context.telemetry.span("agent_waker.doctor").end();

  const failure = await context.telemetry.flush();

  return {
    title: "Telemetry",
    checks: [
      failure === undefined
        ? {
            name: "collector accepted a trace",
            outcome: "pass",
            evidence: endpoint,
          }
        : {
            name: "collector did not accept a trace",
            outcome: "warn",
            evidence: failure,
            advice: [
              "Scheduling is unaffected — agent waker never fails a tick over",
              "telemetry. Traces and logs are not reaching the collector at:",
              "",
              `  ${endpoint}`,
              "",
              "Check that it is running and speaks OTLP over HTTP, or remove the",
              "telemetry block from:",
              "",
              `  ${context.paths.config}`,
            ],
          },
    ],
  };
}

/** One provider: is it there, does it start, and can it do what is wanted. */
async function agentSection(
  context: CommandContext,
  agentId: AgentId,
): Promise<Section> {
  const adapter = context.registry.get(agentId);
  const adapterContext = {
    runner: context.runner,
    workDir: join(context.paths.workDir, agentId),
    now: context.environment.now(),
  };
  const checks: Check[] = [];
  const detection = await adapter.detect(adapterContext);

  if (!detection.installed) {
    checks.push({
      name: "executable found",
      outcome: "fail",
      advice: [
        `${adapter.displayName} is not installed, or is not on the PATH this`,
        "scheduler runs with. Install it through an official method, then run:",
        "",
        `  agent-waker doctor ${agentId}`,
      ],
    });

    return { title: adapter.displayName, checks };
  }

  checks.push({
    name: "executable found",
    outcome: "pass",
    ...(detection.executable === undefined
      ? {}
      : { evidence: detection.executable }),
  });

  if (detection.health !== "ok") {
    // The wrapper outlived what it wraps. Naming the file is the whole point.
    checks.push({
      name: `${adapter.displayName} could not start`,
      outcome: "fail",
      ...(detection.executable === undefined
        ? {}
        : { evidence: detection.executable }),
      advice: [
        "The launcher exists, but something it launches is missing or cannot",
        "be executed. That happens after a runtime upgrade, and when macOS",
        "removes part of an installation.",
        "",
        "Reinstall through an official method, then run:",
        "",
        `  agent-waker doctor ${agentId}`,
        "",
        "agent waker will not restore the installation or bypass a security",
        "control on your behalf.",
      ],
    });

    return { title: adapter.displayName, checks };
  }

  checks.push({
    name: "the CLI starts",
    outcome: "pass",
    ...(detection.version === undefined ? {} : { evidence: detection.version }),
  });

  // Before authentication, because a renamed flag breaks a signed-in agent
  // just as thoroughly, and this costs no quota to find out.
  const missing = await adapter.smokeTest(adapterContext, detection);

  checks.push(
    missing.length === 0
      ? { name: "the activation command is still accepted", outcome: "pass" }
      : {
          name: "the activation command may have changed",
          outcome: "warn",
          evidence: `not offered: ${missing.join(", ")}`,
          advice: [
            `${adapter.displayName} does not offer everything this release of`,
            "agent waker asks it for, so activation may fail even though the",
            "agent is installed and signed in. That usually means the provider",
            "changed its command line in a newer version.",
            "",
            "Check for an agent waker update, and report it if there is none.",
          ],
        },
  );

  const auth = await adapter.inspectAuth(adapterContext, detection);

  if (auth.supportsIntent) {
    checks.push({
      name: "subscription authentication detected",
      outcome: "pass",
      ...(auth.accountHint === undefined ? {} : { evidence: auth.accountHint }),
    });
  } else if (!auth.authenticated) {
    checks.push({
      name: "not authenticated",
      outcome: "fail",
      advice: [
        `Open ${adapter.displayName} once and sign in with your subscription`,
        "account, then run:",
        "",
        `  agent-waker doctor ${agentId}`,
      ],
    });
  } else {
    // Signed in, and with something that cannot do this job.
    checks.push({
      name:
        auth.mode === "api_key"
          ? "API-key authentication detected"
          : "authentication cannot be used for subscription activation",
      outcome: "warn",
      ...(auth.message === undefined ? {} : { evidence: auth.message }),
      advice: [
        "This authentication may bill separately per token, and does not",
        "satisfy the subscription-window activation agent waker exists to do.",
        "",
        "Sign in with subscription-backed authentication for this agent.",
      ],
    });
  }

  return { title: adapter.displayName, checks };
}

function render(sections: readonly Section[], unicode: boolean): string {
  const lines: string[] = ["agent waker doctor", ""];
  const advice: string[] = [];

  for (const section of sections) {
    lines.push(section.title);

    for (const check of section.checks) {
      lines.push(
        `  ${iconFor(MARK[check.outcome], { unicode })} ${check.name}`,
      );

      if (check.evidence !== undefined) lines.push(`      ${check.evidence}`);

      if (check.advice !== undefined) {
        advice.push("", `${section.title}: ${check.name}`, "", ...check.advice);
      }
    }

    lines.push("");
  }

  return [...lines, ...advice].join("\n");
}

/** Runs every check, or only those for the named agents. */
export async function doctorCommand(
  context: CommandContext,
  agents: readonly AgentId[],
): Promise<ExitCode> {
  const chosen = agents.length > 0 ? agents : AGENT_IDS;
  const sections: Section[] = [];

  // Only when looking at everything: asked about one agent, answer about it.
  if (agents.length === 0) {
    sections.push(await schedulerSection(context));

    const telemetry = await telemetrySection(context);

    if (telemetry !== undefined) sections.push(telemetry);
  }

  for (const agentId of chosen) {
    sections.push(await agentSection(context, agentId));
  }

  const all = sections.flatMap((section) => section.checks);
  const failed = all.filter((check) => check.outcome !== "pass");
  const unicode = supportsUnicode(context.environment.env);

  context.environment.write(
    `${render(sections, unicode)}${
      failed.length === 0
        ? "No problems found.\n"
        : `\n${
            failed.length === 1
              ? "1 thing needs"
              : `${String(failed.length)} things need`
          } attention.\n`
    }`,
  );

  return failed.length === 0 ? EXIT.ok : EXIT.partial;
}
