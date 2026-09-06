/**
 * The `status` view: the command a user runs every morning.
 *
 * Three UX rules shape all of it. Deferment is normal, so a limited window
 * reads as a state rather than as a failure. Never imply an exact time the
 * product cannot guarantee, so an unknown reset says it is unknown instead of
 * inventing one. And when something does need a person, say which layer failed
 * and what to run next.
 *
 * Rendering is pure: a view in, a string out. What the terminal can display is
 * passed in rather than sniffed here.
 */

import { schedulerFor, type CommandContext } from "#src/cli/context.js";
import { EXIT, type ExitCode } from "#src/cli/exit.js";
import {
  colourise,
  iconFor,
  relativeTime,
  supportsColour,
  supportsUnicode,
  platformName,
  table,
  type Colour,
} from "#src/cli/format.js";
import { effectiveAgentConfig } from "#src/config/config.js";
import { AGENT_IDS, type AgentId } from "#src/core/agent.js";
import { cycleStartAt, type AgentPhase } from "#src/core/state.js";
import { formatLocalTime, type Instant } from "#src/core/time.js";

export interface StatusAgentView {
  readonly agentId: AgentId;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly phase: AgentPhase;
  readonly reason?: string;
  readonly lastAttemptAt?: Instant;
  readonly lastActivationAt?: Instant;
  readonly nextAttemptAt?: Instant;
  readonly blockedUntil?: Instant;
  readonly retryHorizonEndsAt?: Instant;
  /** When the next daily cycle opens, which is the answer once today is done. */
  readonly nextCycleAt: Instant;
}

export interface StatusView {
  readonly now: Instant;
  readonly timezone: string;
  /** The configured `notBefore`, already formatted. */
  readonly notBefore: string;
  readonly runtime: "local" | "github";
  readonly platform: string;
  readonly scheduler: {
    readonly installed: boolean;
    readonly loaded: boolean;
    readonly stalePath: boolean;
  };
  readonly agents: readonly StatusAgentView[];
}

const DAY_MS = 86_400_000;

export interface RenderOptions {
  readonly colour: boolean;
  readonly unicode: boolean;
}

/** What to call each phase, in the user's terms rather than the model's. */
function stateLabel(agent: StatusAgentView, view: StatusView): string {
  if (!agent.enabled) return "Disabled";

  switch (agent.phase) {
    case "activated":
      return "Activated";
    case "ready":
      return "Due now";
    case "idle":
      // Naming the time answers the question the user actually has.
      return `Waiting for ${view.notBefore}`;
    case "waiting_known_reset":
      return "Usage window limited";
    case "waiting_unknown_reset":
      return "Limited · reset unknown";
    case "long_term_block":
      return "Long-term limit";
    case "transient_error":
      return "Network problem";
    case "auth_required":
      return agent.reason === "api_billing_only"
        ? "API-key authentication"
        : agent.reason === "not_authenticated"
          ? "Sign-in required"
          : "Authentication problem";
    case "unhealthy":
      return "Installation problem";
    case "failed":
      return "Unrecognised response";
  }
}

function stateColour(agent: StatusAgentView): Colour {
  if (!agent.enabled) return "grey";

  switch (agent.phase) {
    case "activated":
      return "green";
    case "unhealthy":
    case "failed":
      return "red";
    case "auth_required":
      return "yellow";
    default:
      return "yellow";
  }
}

/** Phases that no amount of waiting will clear. */
function needsPerson(agent: StatusAgentView): boolean {
  return (
    agent.phase === "unhealthy" ||
    agent.phase === "auth_required" ||
    agent.phase === "failed"
  );
}

function nextAction(agent: StatusAgentView, view: StatusView): string {
  if (!agent.enabled) return "—";
  if (needsPerson(agent)) return "needs attention";

  const when =
    agent.phase === "activated" ? agent.nextCycleAt : agent.nextAttemptAt;

  return relativeTime(when ?? agent.nextCycleAt, view.now, view.timezone);
}

/**
 * The paragraph under the table, when there is something worth explaining.
 *
 * Only for states a person might otherwise misread: a limit that is not a
 * fault, or a fault that needs a specific next command.
 */
function detail(agent: StatusAgentView, view: StatusView): string[] {
  const when = (instant: Instant | undefined): string =>
    relativeTime(instant, view.now, view.timezone);

  switch (agent.phase) {
    case "waiting_known_reset":
      return [
        `  The current window resets at ${when(agent.blockedUntil)}.`,
        `  agent waker will check again at ${when(agent.nextAttemptAt)}.`,
      ];
    case "waiting_unknown_reset":
      return [
        "  The provider did not expose a reset time.",
        `  Normal retries continue until ${when(agent.retryHorizonEndsAt)}.`,
      ];
    case "long_term_block":
      return [
        `  ${agent.displayName} stayed limited beyond the normal recovery window.`,
        `  agent waker has switched to infrequent checks, next at ${when(agent.nextAttemptAt)}.`,
      ];
    case "unhealthy":
      return [
        "  The command was found, but it cannot be launched.",
        `  Run \`agent-waker doctor ${agent.agentId}\`.`,
      ];
    case "auth_required":
      return agent.reason === "api_billing_only"
        ? [
            "  agent waker does not use API-key billing for subscription-window",
            "  activation, because that bills per token for a window you already",
            `  pay for. Sign in with a subscription account, then run \`agent-waker doctor ${agent.agentId}\`.`,
          ]
        : [
            `  ${agent.displayName} needs to be signed in again.`,
            `  Run \`agent-waker doctor ${agent.agentId}\`.`,
          ];
    case "failed":
      return [
        `  ${agent.displayName} answered in a way agent waker did not recognise.`,
        `  Run \`agent-waker doctor ${agent.agentId}\`; this is usually a provider update.`,
      ];
    default:
      return [];
  }
}

function schedulerLine(view: StatusView, options: RenderOptions): string {
  const { installed, loaded, stalePath } = view.scheduler;

  if (!installed) {
    return `Scheduler   ${iconFor("idle", options)} not installed — run \`agent-waker init\``;
  }

  if (stalePath) {
    return `Scheduler   ${iconFor("unhealthy", options)} stale — it points at a file that has moved; run \`agent-waker doctor\``;
  }

  if (!loaded) {
    return `Scheduler   ${iconFor("auth_required", options)} installed but not loaded — run \`agent-waker doctor\``;
  }

  return `Scheduler   ${iconFor("activated", options)} running`;
}

/**
 * Replaces the typography with characters any terminal can print.
 *
 * Applied once at the end rather than threaded through every helper, so no
 * call site can forget it. The final catch-all keeps the promise absolute: in
 * ASCII mode the output is ASCII, even if a glyph is added here later and
 * nobody remembers to map it.
 */
function toAscii(text: string): string {
  return text
    .replaceAll("·", "-")
    .replaceAll("─", "-")
    .replaceAll("—", "-")
    .replaceAll(/[^\u0020-\u007e\n]/g, "?");
}

/** Renders the whole view. */
export function renderStatus(view: StatusView, options: RenderOptions): string {
  const rows = view.agents.map((agent) => [
    agent.displayName,
    `${iconFor(agent.enabled ? agent.phase : "idle", options)} ${colourise(
      stateLabel(agent, view),
      stateColour(agent),
      options.colour,
    )}`,
    relativeTime(
      agent.lastActivationAt ?? agent.lastAttemptAt,
      view.now,
      view.timezone,
    ),
    nextAction(agent, view),
  ]);

  const details = view.agents.flatMap((agent) => {
    const lines = detail(agent, view);

    return lines.length === 0 ? [] : ["", agent.displayName, ...lines];
  });

  const rendered = [
    "agent waker",
    `Runtime: ${view.runtime} · ${view.platform}`,
    `Desired activation: ${view.notBefore} ${view.timezone}`,
    "",
    table(["Agent", "State", "Last activation", "Next action"], rows),
    ...details,
    "",
    schedulerLine(view, options),
    "",
  ].join("\n");

  return options.unicode ? rendered : toAscii(rendered);
}

/**
 * `status`: the command a user runs every morning.
 *
 * Reporting is not failing, so this exits zero whatever it finds. `doctor` is
 * the command whose exit code means healthy.
 */
export async function statusCommand(
  context: CommandContext,
): Promise<ExitCode> {
  const { environment, config } = context;
  const now = environment.now();
  const loaded = await context.store.load();
  const scheduler = await schedulerFor(context).inspect();

  const agents = AGENT_IDS.map((agentId) => {
    const effective = effectiveAgentConfig(config, agentId);
    const state = loaded.state.agents[agentId];
    const todayOpens = cycleStartAt(effective, now);
    // Before the day's cycle opens the answer is today; after it, tomorrow.
    const nextCycleAt =
      now < todayOpens ? todayOpens : cycleStartAt(effective, now + DAY_MS);

    return {
      agentId,
      displayName: context.registry.get(agentId).displayName,
      enabled: effective.enabled,
      phase: state.phase,
      nextCycleAt,
      ...(state.reason === undefined ? {} : { reason: state.reason }),
      ...(state.lastAttemptAt === undefined
        ? {}
        : { lastAttemptAt: state.lastAttemptAt }),
      ...(state.lastActivationAt === undefined
        ? {}
        : { lastActivationAt: state.lastActivationAt }),
      ...(state.nextAttemptAt === undefined
        ? {}
        : { nextAttemptAt: state.nextAttemptAt }),
      ...(state.blockedUntil === undefined
        ? {}
        : { blockedUntil: state.blockedUntil }),
      ...(state.retryHorizonEndsAt === undefined
        ? {}
        : { retryHorizonEndsAt: state.retryHorizonEndsAt }),
    };
  });

  environment.write(
    renderStatus(
      {
        now,
        timezone: config.timezone,
        notBefore: formatLocalTime(config.schedule.notBefore),
        runtime: "local",
        platform: platformName(environment.platform),
        scheduler,
        agents,
      },
      {
        colour: supportsColour({
          env: environment.env,
          isTty: environment.isTty,
        }),
        unicode: supportsUnicode(environment.env),
      },
    ),
  );

  return EXIT.ok;
}
