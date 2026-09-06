/**
 * `logs`: the recent events, rendered for a person.
 *
 * The file is JSONL because machines read it; this turns it back into
 * something worth scanning. Provider text was redacted on the way in, and is
 * stripped of control characters on the way out: a log line is untrusted
 * content being printed to a terminal.
 */

import type { CommandContext } from "#src/cli/context.js";
import { EXIT, type ExitCode } from "#src/cli/exit.js";
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

function renderEvent(event: StoredEvent, timeZone: string): string {
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(Date.parse(event.timestamp));

  const fields = Object.entries(event.fields)
    .map(([key, value]) => `${key}=${printable(renderValue(value))}`)
    .join(" ");

  return [
    clock,
    event.level.toUpperCase().padEnd(5),
    event.agent ?? "-",
    event.event,
    fields,
  ]
    .filter((part) => part !== "")
    .join("  ")
    .trimEnd();
}

export async function logsCommand(
  context: CommandContext,
  limit = DEFAULT_LIMIT,
): Promise<ExitCode> {
  const events = await readRecentEvents(context.paths.logDir, limit);

  if (events.length === 0) {
    context.environment.write(
      "No events yet. The scheduler writes one every time it runs.\n",
    );

    return EXIT.ok;
  }

  context.environment.write(
    `${events
      .map((event) => renderEvent(event, context.config.timezone))
      .join("\n")}\n`,
  );

  return EXIT.ok;
}
