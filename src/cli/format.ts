/**
 * Turning state into something worth reading in a terminal.
 *
 * Two rules run through all of it. Text carries the meaning and an icon only
 * reinforces it, so a terminal without Unicode loses decoration rather than
 * information. And a time is shown the way a person would say it — "tomorrow
 * 07:00", not an ISO timestamp — in the timezone the schedule is written in,
 * which is not always the one the machine is set to.
 */

import type { AgentPhase } from "#src/core/state.js";
import { localDateAt, type Instant } from "#src/core/time.js";

/** Same width for every one, so a table stays aligned when things go wrong. */
export const ASCII_LABELS = {
  ok: "OK  ",
  wait: "WAIT",
  warn: "WARN",
  error: "ERR ",
  off: "OFF ",
  unknown: "?   ",
} as const;

const UNICODE_ICONS = {
  ok: "✓",
  wait: "⏳",
  warn: "!",
  error: "✗",
  off: "○",
  unknown: "?",
} as const;

type IconName = keyof typeof ASCII_LABELS;

const PHASE_ICONS: Readonly<Record<AgentPhase, IconName>> = {
  activated: "ok",
  waiting_known_reset: "wait",
  waiting_unknown_reset: "wait",
  long_term_block: "wait",
  transient_error: "wait",
  auth_required: "warn",
  unhealthy: "error",
  failed: "error",
  idle: "off",
  ready: "unknown",
};

/** Picks the mark for a phase, or the word for a terminal that needs one. */
export function iconFor(
  phase: AgentPhase,
  options: { unicode: boolean },
): string {
  const name = PHASE_ICONS[phase];

  return options.unicode ? UNICODE_ICONS[name] : ASCII_LABELS[name];
}

const COLOURS = {
  green: 32,
  yellow: 33,
  red: 31,
  grey: 90,
} as const;

export type Colour = keyof typeof COLOURS;

export function colourise(
  text: string,
  colour: Colour,
  enabled: boolean,
): string {
  return enabled ? `\u001b[${String(COLOURS[colour])}m${text}\u001b[39m` : text;
}

/**
 * Whether to colour the output.
 *
 * `NO_COLOR` is honoured by presence rather than by value, which is what the
 * convention says, and a pipe gets no colour because the thing on the other
 * end is usually not a terminal.
 */
export function supportsColour(context: {
  env: Readonly<Record<string, string | undefined>>;
  isTty: boolean;
}): boolean {
  if (context.env.NO_COLOR !== undefined) return false;
  if (context.env.TERM === "dumb") return false;

  return context.isTty;
}

/** Whether the terminal can be trusted with anything outside ASCII. */
export function supportsUnicode(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  // The shell's own precedence: LC_ALL wins, then LC_CTYPE, then LANG.
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "";

  return /utf-?8/i.test(locale);
}

/** What people call the platform, rather than what Node calls it. */
export function platformName(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

const MILLISECONDS_PER_DAY = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function clockAt(instant: Instant, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
}

function weekdayAt(instant: Instant, timeZone: string): string {
  const index = new Date(
    `${localDateAt(instant, timeZone)}T00:00:00Z`,
  ).getUTCDay();

  return WEEKDAYS[index] ?? "";
}

/** Whole local days between two instants, by calendar date rather than hours. */
function dayDistance(from: Instant, to: Instant, timeZone: string): number {
  const day = (instant: Instant): number =>
    Date.parse(`${localDateAt(instant, timeZone)}T00:00:00Z`);

  return Math.round((day(to) - day(from)) / MILLISECONDS_PER_DAY);
}

/**
 * Which day an instant falls on, the way somebody would say it out loud.
 *
 * Relative while that is unambiguous, then a weekday for the surrounding week
 * — which is what a weekly limit needs — and a plain date beyond that.
 * Separate from the clock because `logs` says the same day and its own
 * seconds, and reading the day back off a formatted string is not a seam.
 */
export function dayLabel(
  instant: Instant,
  now: Instant,
  timeZone: string,
): string {
  const days = dayDistance(now, instant, timeZone);

  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";

  // A weekday only says which day while there is one of each to choose from.
  if (Math.abs(days) < 7) return weekdayAt(instant, timeZone);

  return localDateAt(instant, timeZone);
}

/** Renders an instant the way somebody would say it out loud. */
export function relativeTime(
  instant: Instant | undefined,
  now: Instant,
  timeZone: string,
): string {
  // NaN as well as absent: a timestamp read back out of the log may not parse,
  // and `Intl` throws on one rather than returning anything printable.
  if (instant === undefined || Number.isNaN(instant)) return "—";

  return `${dayLabel(instant, now, timeZone)} ${clockAt(instant, timeZone)}`;
}

// Colour is invisible but not free: it makes a cell wider than it looks.
// eslint-disable-next-line no-control-regex -- matching escape sequences is the point
const ANSI_PATTERN = /\u001b\[\d+m/g;

// Display columns, not characters. `⏳` is drawn two columns wide, so padding
// it as one leaves every cell to its right a column short. Emoji presentation
// is the property that terminals draw double-width — no width table needed for
// the handful of glyphs here — and segmenting into graphemes first keeps a
// cluster that spans several code points, as anything pasted into a log field
// may, from counting once per code point.
const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });
const DOUBLE_WIDTH = /\p{Emoji_Presentation}/u;

function visibleWidth(text: string): number {
  let width = 0;

  for (const { segment } of GRAPHEMES.segment(text.replace(ANSI_PATTERN, ""))) {
    width += DOUBLE_WIDTH.test(segment) ? 2 : 1;
  }

  return width;
}

/** Lays out a header, a rule and some rows, padding to the visible width. */
export function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((header, column) =>
    Math.max(
      visibleWidth(header),
      ...rows.map((row) => visibleWidth(row[column] ?? "")),
    ),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) =>
        // The last column is never padded: trailing spaces show up in diffs
        // and in anything the user copies out.
        column === cells.length - 1
          ? cell
          : cell +
            " ".repeat(Math.max(0, (widths[column] ?? 0) - visibleWidth(cell))),
      )
      .join("  ")
      .trimEnd();

  const rule = "─".repeat(
    widths.reduce((total, width) => total + width + 2, -2),
  );

  return [line(headers), rule, ...rows.map(line)].join("\n");
}
