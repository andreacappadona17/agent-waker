/**
 * Calendar and timezone arithmetic for the scheduling core.
 *
 * The product promise is wall-clock intent: `07:00 Europe/Rome` means 07:00 on
 * the local clock whatever the offset is that day. Everything here therefore
 * converts between a named IANA zone and absolute instants, and never applies a
 * fixed offset of its own.
 *
 * `Intl` is the timezone database. Node ships full ICU, so a dependency would
 * buy a nicer API over the same data.
 */

import { describeValue } from "#src/core/describe.js";

/** An absolute point in time, as milliseconds since the Unix epoch, UTC. */
export type Instant = number;

/** A calendar date in some named timezone, as `YYYY-MM-DD`. */
export type LocalDate = string;

/** A time on a local clock. Minute granularity; `notBefore` needs no more. */
export interface LocalTime {
  readonly hour: number;
  readonly minute: number;
}

const DAY_MS = 86_400_000;

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// A single-digit hour is accepted; a single-digit minute is not, because "7:0"
// is more likely a typo than an intent.
const LOCAL_TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/** Raised when a configured value cannot be used as a timezone. */
export class InvalidTimeZoneError extends Error {
  /** The original value, untrimmed, so a caller can find it in the source file. */
  readonly value: unknown;

  constructor(value: unknown, message: string) {
    super(message);
    this.name = "InvalidTimeZoneError";
    this.value = value;
  }
}

/** Raised when a configured value cannot be used as a local time. */
export class InvalidLocalTimeError extends Error {
  /** The original value, untrimmed, so a caller can find it in the source file. */
  readonly value: unknown;

  constructor(value: unknown, message: string) {
    super(message);
    this.name = "InvalidLocalTimeError";
    this.value = value;
  }
}

/**
 * Validates a timezone and returns ICU's canonical spelling of it.
 *
 * Accepts what ICU accepts, so `europe/rome` and the legacy `US/Pacific` work,
 * minus fixed offsets.
 *
 * @throws {InvalidTimeZoneError} when the value is not a usable IANA zone.
 */
export function parseTimeZone(input: unknown): string {
  const text = typeof input === "string" ? input.trim() : "";

  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat("en-US", {
      timeZone: text,
    }).resolvedOptions().timeZone;
  } catch {
    throw new InvalidTimeZoneError(
      input,
      `Unknown timezone ${describeValue(input)}. Use an IANA name such as Europe/Rome or America/New_York.`,
    );
  }

  // ICU accepts "+05:30" and keeps it in offset form. A fixed offset cannot
  // express "07:00 local across a daylight-saving change", so taking one would
  // silently drift by an hour for half the year.
  if (canonical.startsWith("+") || canonical.startsWith("-")) {
    throw new InvalidTimeZoneError(
      input,
      `Timezone ${describeValue(input)} is a fixed offset, which does not follow daylight saving. Use an IANA name such as Europe/Rome.`,
    );
  }

  return canonical;
}

/**
 * Parses a 24-hour local time such as `07:00`.
 *
 * Takes `unknown` because YAML yields a number for an unquoted `0700`, and
 * under YAML 1.1 rules an unquoted `7:00` is the sexagesimal number 420.
 *
 * @throws {InvalidLocalTimeError} when the value is not a 24-hour clock time.
 */
export function parseLocalTime(input: unknown): LocalTime {
  const text = typeof input === "string" ? input.trim() : "";
  const match = LOCAL_TIME_PATTERN.exec(text);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);

  if (match === null || hour > 23 || minute > 59) {
    // A number almost always means an unquoted YAML scalar, so say so.
    const hint =
      typeof input === "number"
        ? " Quote the value so YAML does not read it as a number."
        : "";

    throw new InvalidLocalTimeError(
      input,
      `Expected a 24-hour local time such as "07:00", but received ${describeValue(input)}.${hint}`,
    );
  }

  return { hour, minute };
}

/** Renders a local time back as `HH:MM`, canonicalised. */
export function formatLocalTime(time: LocalTime): string {
  const pad = (value: number): string => String(value).padStart(2, "0");

  return `${pad(time.hour)}:${pad(time.minute)}`;
}

// Constructing a formatter costs far more than using one, and a tick resolves
// the same handful of zones repeatedly.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);

  if (formatter === undefined) {
    // The locale is pinned: a system locale can otherwise select a non-Gregorian
    // calendar or non-ASCII digits, and both break Number().
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }

  return formatter;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Reads the local clock in `timeZone` at an instant. */
function wallClockAt(instant: Instant, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);

  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
  };
}

/** Builds the instant a wall clock would show if the zone were UTC. */
function asIfUtc(clock: WallClock): number {
  // Not Date.UTC: it maps years 0-99 into the 1900s, and a date read back from
  // a state file is not guaranteed to be recent.
  const date = new Date(0);
  date.setUTCFullYear(clock.year, clock.month - 1, clock.day);
  date.setUTCHours(clock.hour, clock.minute, 0, 0);
  return date.getTime();
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetMsAt(instant: Instant, timeZone: string): number {
  return asIfUtc(wallClockAt(instant, timeZone)) - instant;
}

/** The calendar date showing in `timeZone` at an instant. */
export function localDateAt(instant: Instant, timeZone: string): LocalDate {
  const { year, month, day } = wallClockAt(instant, timeZone);
  const pad = (value: number, width: number): string =>
    String(value).padStart(width, "0");

  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * Resolves a wall-clock time in a named zone to an absolute instant.
 *
 * Daylight saving makes this a lookup rather than an addition:
 *
 * - a time inside a spring-forward gap never occurs, and is moved forward by
 *   the size of the gap, so `02:30` on a day that skips 02:00-03:00 becomes
 *   `03:30`. A schedule set for a missing minute still runs that morning;
 * - a time inside a fall-back overlap occurs twice, and resolves to the first
 *   occurrence, so the day's activation is not delayed by an hour.
 *
 * @throws {RangeError} when the date is not a real `YYYY-MM-DD` calendar date.
 */
export function resolveLocalTime(
  date: LocalDate,
  time: LocalTime,
  timeZone: string,
): Instant {
  const match = LOCAL_DATE_PATTERN.exec(date);

  if (match === null) {
    throw new RangeError(
      `Expected a date such as "2026-09-06", but received ${describeValue(date)}.`,
    );
  }

  const target: WallClock = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: time.hour,
    minute: time.minute,
  };
  const wall = asIfUtc(target);

  // Catches 2026-02-30, which would otherwise roll silently into March.
  if (localDateAt(wall, "UTC") !== date) {
    throw new RangeError(`No such date: ${describeValue(date)}.`);
  }

  // A day either side brackets any transition on the target date, which gives
  // both the offset before it and the offset after it. Applying each yields the
  // candidate instants; a transition-free date yields one.
  const offsets = new Set([
    offsetMsAt(wall - DAY_MS, timeZone),
    offsetMsAt(wall + DAY_MS, timeZone),
  ]);
  const candidates = [...offsets].map((offset) => wall - offset);
  const occurrences = candidates.filter(
    (candidate) => asIfUtc(wallClockAt(candidate, timeZone)) === wall,
  );

  // No occurrence means the wall time falls in a gap. The larger candidate is
  // the one built from the pre-transition offset, which lands past the
  // transition — the requested time shifted forward by the gap.
  return occurrences.length > 0
    ? Math.min(...occurrences)
    : Math.max(...candidates);
}
