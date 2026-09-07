/**
 * The event log: one JSON object per line, one file per local day.
 *
 * A day per file rather than size-based rotation. Retention then costs a
 * directory listing and a few unlinks, there is no rename to lose a line
 * across, and `logs` can read the newest file without parsing the older ones.
 *
 * Redaction happens inside `write`, not around it. A caller cannot forget it,
 * which is the only property that makes it worth having.
 */

import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { AgentId } from "#src/core/agent.js";
import { localDateAt, type Instant } from "#src/core/time.js";
import {
  redactValue,
  secretsFromEnv,
  type JsonValue,
} from "#src/logging/redact.js";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const DAY_MS = 86_400_000;

const FILE_PREFIX = "events-";
const FILE_SUFFIX = ".jsonl";
const FILE_PATTERN = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Ordered, so a configured level admits everything at or above it. */
export const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** One thing that happened, in the vocabulary the CLI renders. */
export interface Event {
  readonly timestamp: Instant;
  readonly level: LogLevel;
  /** Dotted name, such as `agent.activation.blocked`. */
  readonly event: string;
  readonly agent?: AgentId;
  readonly runtime: "local" | "github";
  readonly fields: Readonly<Record<string, JsonValue>>;
}

export interface EventLog {
  write(event: Event): Promise<void>;
}

export interface EventLogOptions {
  readonly directory: string;
  /** Debug is off by default; the log is for diagnosis, not for tracing. */
  readonly level?: LogLevel;
  /** Names the day's file, so a log file matches the day the user worked. */
  readonly timezone?: string;
  readonly retentionDays?: number;
  /** Values to treat as secret; defaults to the real environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Further values to mask, such as credentials read from configuration. */
  readonly secrets?: readonly string[];
}

function fileNameFor(timestamp: Instant, timezone: string): string {
  return `${FILE_PREFIX}${localDateAt(timestamp, timezone)}${FILE_SUFFIX}`;
}

/** Opens an event log, creating its directory on first write. */
export function createEventLog(options: EventLogOptions): EventLog {
  const {
    directory,
    level = "info",
    timezone = "UTC",
    retentionDays = 14,
    env = process.env,
    secrets: extraSecrets = [],
  } = options;

  const minimum = LEVELS.indexOf(level);
  const secrets = [...secretsFromEnv(env), ...extraSecrets];
  let pruned = false;

  /** Drops files past the retention window. Once per process is enough. */
  const prune = async (now: Instant): Promise<void> => {
    const cutoff = localDateAt(now - retentionDays * DAY_MS, timezone);

    for (const name of await readdir(directory)) {
      const date = FILE_PATTERN.exec(name)?.[1];

      // Compares as text because ISO dates sort chronologically, and skips
      // anything this log did not write.
      if (date !== undefined && date < cutoff) {
        await rm(join(directory, name), { force: true });
      }
    }
  };

  return {
    async write(event: Event): Promise<void> {
      await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });

      // Before the level filter, not after. Most ticks are no-ops and no-ops
      // log at debug, so pruning behind the filter would mean a machine whose
      // agents are all disabled never deletes an old file again.
      if (!pruned) {
        pruned = true;
        await prune(event.timestamp);
      }

      if (LEVELS.indexOf(event.level) < minimum) return;

      const record = {
        timestamp: new Date(event.timestamp).toISOString(),
        level: event.level,
        event: event.event,
        ...(event.agent === undefined ? {} : { agent: event.agent }),
        runtime: event.runtime,
        fields: redactValue({ ...event.fields }, secrets),
      };

      await appendFile(
        join(directory, fileNameFor(event.timestamp, timezone)),
        `${JSON.stringify(record)}\n`,
        { encoding: "utf8", mode: FILE_MODE },
      );
    },
  };
}

/** An event as it comes back off disk, with its timestamp still a string. */
export interface StoredEvent {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly agent?: AgentId;
  readonly runtime: "local" | "github";
  readonly fields: Record<string, JsonValue>;
}

function parseLine(line: string): StoredEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    const candidate = parsed as Partial<StoredEvent>;

    return typeof candidate.event === "string" &&
      typeof candidate.timestamp === "string"
      ? (parsed as StoredEvent)
      : undefined;
  } catch {
    // A line torn by a crash, or edited by hand. One bad line is not a reason
    // to refuse to show the rest.
    return undefined;
  }
}

/**
 * Reads the most recent events, oldest first, across day files.
 *
 * @param keep applied before the limit, so asking for the last twenty of one
 * agent's events reads back as far as it has to rather than returning the two
 * that survived a filter of the last twenty of everything.
 */
export async function readRecentEvents(
  directory: string,
  limit: number,
  keep: (event: StoredEvent) => boolean = () => true,
): Promise<StoredEvent[]> {
  let names: string[];

  try {
    names = await readdir(directory);
  } catch {
    return [];
  }

  const days = names.filter((name) => FILE_PATTERN.test(name)).toSorted();
  const collected: StoredEvent[] = [];

  // Newest file first, stopping as soon as there is enough to answer with.
  for (const name of days.toReversed()) {
    const text = await readFile(join(directory, name), "utf8");
    const events = text
      .split("\n")
      .map(parseLine)
      .filter((event) => event !== undefined)
      .filter(keep);

    collected.unshift(...events);

    if (collected.length >= limit) break;
  }

  return collected.slice(-limit);
}
