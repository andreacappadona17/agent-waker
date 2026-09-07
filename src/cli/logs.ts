/**
 * `logs`: the recent events, rendered for a person.
 *
 * The file is JSONL because machines read it; this turns it back into
 * something worth scanning. Two views: a sentence per event by default, and
 * the raw record under `--debug`, which is where the process metadata lives.
 *
 * An agent's phase becomes English through the same helper `status` and `run`
 * use, so a history reads in the words the user already learned.
 *
 * Provider text was redacted on the way in, and is stripped of control
 * characters on the way out: a log line is untrusted content being printed to
 * a terminal.
 */

import type { CommandContext } from "#src/cli/context.js";
import { EXIT, type ExitCode } from "#src/cli/exit.js";
import { dayLabel, relativeTime } from "#src/cli/format.js";
import { phaseLabel } from "#src/cli/status.js";
import type { AgentId } from "#src/core/agent.js";
import { isAgentPhase, type AgentPhase } from "#src/core/state.js";
import { formatLocalTime } from "#src/core/time.js";
import { readRecentEvents, type StoredEvent } from "#src/logging/log.js";
import type { JsonValue } from "#src/logging/redact.js";

const DEFAULT_LIMIT = 40;

/**
 * Removes anything that could move the cursor or repaint the screen.
 *
 * Redaction took the credentials out. This takes out the ability to redraw
 * the terminal of whoever reads the log afterwards.
 */
function printable(text: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return text.replaceAll(/[\u0000-\u001f\u007f]/g, " ");
}

/** A field's value, without turning a nested object into "[object Object]". */
function renderValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The day and the clock, so a history spanning midnight is not ambiguous. */
function when(event: StoredEvent, now: number, timeZone: string): string {
  const instant = Date.parse(event.timestamp);

  // A timestamp read back out of a file may not parse, and `Intl` throws on
  // one rather than returning anything printable.
  if (Number.isNaN(instant)) return "unknown time";

  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(instant);

  // The same day `status` and `run` say, with this command's own seconds.
  return `${dayLabel(instant, now, timeZone)} ${clock}`;
}

/** The phase an `agent.<phase>` event is reporting, if it is one. */
function phaseOf(event: StoredEvent): AgentPhase | undefined {
  const suffix = event.event.startsWith("agent.")
    ? event.event.slice("agent.".length)
    : undefined;

  return suffix !== undefined && isAgentPhase(suffix) ? suffix : undefined;
}

/** One event as a sentence, in the vocabulary the other commands use. */
function summarise(event: StoredEvent, notBefore: string): string {
  const phase = phaseOf(event);

  if (phase !== undefined) {
    const reason = event.fields.reason;

    return phaseLabel(
      phase,
      typeof reason === "string" ? reason : undefined,
      notBefore,
    );
  }

  switch (event.event) {
    case "scheduler.tick":
      return "Scheduler ran";
    case "state.recovered":
      return "State recovered from the backup copy";
    case "state.reset":
      return "State was unreadable and has started over";
    case "telemetry.export_failed":
      return "Telemetry export failed";
    default:
      // A build that writes an event this one does not know about still shows
      // it, rather than dropping a line out of a history.
      return event.event;
  }
}

/** What is worth adding after the summary: when it retries, or how long it took. */
function trailer(event: StoredEvent, now: number, timeZone: string): string {
  const next = event.fields.nextAttemptAt;

  if (typeof next === "string") {
    return `next check ${relativeTime(Date.parse(next), now, timeZone)}`;
  }

  const duration = event.fields.durationMs;

  return typeof duration === "number" ? `${(duration / 1000).toFixed(1)}s` : "";
}

/** The raw record, for when the sentence is not enough. */
function renderVerbose(
  event: StoredEvent,
  now: number,
  timeZone: string,
): string {
  const fields = Object.entries(event.fields)
    .map(([key, value]) => `${key}=${printable(renderValue(value))}`)
    .join(" ");

  return [
    when(event, now, timeZone),
    event.level.toUpperCase().padEnd(5),
    event.agent ?? "-",
    event.event,
    fields,
  ]
    .filter((part) => part !== "")
    .join("  ")
    .trimEnd();
}

export interface LogsOptions {
  readonly limit?: number;
  /** Restrict to these agents, as `agent-waker logs codex` does. */
  readonly agents?: readonly AgentId[];
  /** The raw record rather than a sentence, and the debug events with it. */
  readonly verbose?: boolean;
}

export async function logsCommand(
  context: CommandContext,
  options: LogsOptions = {},
): Promise<ExitCode> {
  const { limit = DEFAULT_LIMIT, agents = [], verbose = false } = options;
  const now = context.environment.now();
  const timeZone = context.config.timezone;
  const notBefore = formatLocalTime(context.config.schedule.notBefore);
  const filtering = agents.length > 0 || !verbose;

  // ponytail: read ten times the asked-for limit when filtering, because the
  // filter runs afterwards — the last twenty Codex events should not come back
  // as two because the other eighteen were Claude's. The ceiling is a day's
  // events being more than ten times the limit, which needs a filter inside
  // `readRecentEvents` rather than a wider read out here.
  const events = (
    await readRecentEvents(context.paths.logDir, filtering ? limit * 10 : limit)
  )
    .filter(
      (event) =>
        agents.length === 0 ||
        (event.agent !== undefined && agents.includes(event.agent)),
    )
    // A no-op tick is written at debug and must not appear by default
    // (UX §14); the same rule hides anything else written at that level.
    .filter((event) => verbose || event.level !== "debug")
    .slice(-limit);

  if (events.length === 0) {
    context.environment.write(
      agents.length > 0
        ? `No events yet for ${agents.join(", ")}.\n`
        : "No events yet. The scheduler writes one every time it runs.\n",
    );

    return EXIT.ok;
  }

  if (verbose) {
    context.environment.write(
      `${events
        .map((event) => renderVerbose(event, now, timeZone))
        .join("\n")}\n`,
    );

    return EXIT.ok;
  }

  const width = Math.max(
    ...events.map((event) => (event.agent ?? "").length),
    "scheduler".length,
  );

  const lines = events.map((event) =>
    printable(
      `${when(event, now, timeZone)}  ${(event.agent ?? "scheduler").padEnd(
        width,
      )}  ${summarise(event, notBefore)} ${trailer(event, now, timeZone)}`.trimEnd(),
    ),
  );

  context.environment.write(
    ["Recent agent waker events", "", ...lines, ""].join("\n"),
  );

  return EXIT.ok;
}
