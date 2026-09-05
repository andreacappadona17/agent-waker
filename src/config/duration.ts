/**
 * Duration strings used throughout agent waker configuration, for example
 * `resetGrace: 1m` or `normalWindowHorizon: 5h`.
 *
 * Only single-unit, whole-number durations are accepted. Compound values such
 * as `1h30m` are rejected so that configuration stays unambiguous.
 */

/**
 * A Map rather than an object literal: the key comes from a regular expression
 * match, so a miss must return `undefined` rather than reach a prototype
 * member such as `constructor`.
 */
const UNIT_MS = new Map<string, number>([
  ["ms", 1],
  ["s", 1_000],
  ["m", 60_000],
  ["h", 3_600_000],
  ["d", 86_400_000],
]);

/**
 * The trailing `$` is load-bearing. Unanchored, `500ms` matches the `m` branch
 * and silently parses as 500 minutes. Alternation order is *not* load-bearing:
 * with the anchor in place the engine backtracks and `ms` still wins.
 */
const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

/**
 * Kept as a list, not a pre-joined string, because UX.md section 19 renders
 * these one per line. Presentation belongs to the CLI, not to this module.
 */
export const EXAMPLE_DURATIONS: readonly string[] = [
  "30s",
  "1m",
  "5m",
  "5h",
  "7d",
];

/** Configured values are echoed back to the user, so cap what we repeat. */
const MAX_ECHOED_LENGTH = 64;

/** Raised when a configured value cannot be used as a duration. */
export class InvalidDurationError extends Error {
  /**
   * The original value, untrimmed. The configuration loader uses it to locate
   * the offending line in the source file when reporting the error.
   */
  readonly value: unknown;

  constructor(value: unknown, message: string) {
    super(message);
    this.name = "InvalidDurationError";
    this.value = value;
  }
}

/**
 * Renders an untrusted configuration value for display. Never throws, never
 * emits raw control characters, and never echoes an unbounded string.
 */
function describe(value: unknown): string {
  switch (typeof value) {
    case "string": {
      const clipped =
        value.length > MAX_ECHOED_LENGTH
          ? `${value.slice(0, MAX_ECHOED_LENGTH)}…`
          : value;
      // JSON.stringify escapes control characters, so a crafted config value
      // cannot inject terminal escape sequences into agent waker's output.
      return JSON.stringify(clipped);
    }
    case "number":
    case "boolean":
    case "bigint":
    case "undefined":
      return String(value);
    default:
      // Objects, arrays, symbols and functions are described by shape only;
      // stringifying them could re-introduce raw control characters.
      return value === null ? "null" : `a ${typeof value}`;
  }
}

/**
 * Parses a duration into milliseconds.
 *
 * Accepts `unknown` because durations arrive from parsed YAML, where
 * `resetGrace: 1m` is a string but `resetGrace: 60` is a number and
 * `resetGrace: yes` is a boolean. Handling those here keeps the actionable
 * error message in one place instead of at every call site.
 *
 * @throws {InvalidDurationError} when the value is not a supported duration,
 * or when it is too large to represent exactly.
 */
export function parseDuration(input: unknown): number {
  const text = typeof input === "string" ? input.trim().toLowerCase() : "";
  const [, amount = "", unit = ""] = DURATION_PATTERN.exec(text) ?? [];
  const multiplier = UNIT_MS.get(unit);

  if (multiplier === undefined) {
    throw new InvalidDurationError(
      input,
      `Expected a duration such as ${EXAMPLE_DURATIONS.join(", ")}, but received ${describe(input)}.`,
    );
  }

  const milliseconds = Number(amount) * multiplier;

  // A well-formed but absurd duration is a different mistake from a malformed
  // one, so it gets a message the user can act on.
  if (!Number.isSafeInteger(milliseconds)) {
    const maximum = Math.floor(Number.MAX_SAFE_INTEGER / multiplier);
    throw new InvalidDurationError(
      input,
      `Duration ${describe(input)} is too large; the maximum is ${String(maximum)}${unit}.`,
    );
  }

  return milliseconds;
}
