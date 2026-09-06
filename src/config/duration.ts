/**
 * Parses the duration strings used in configuration, such as `1m` or `5h`.
 *
 * Single unit, whole numbers only. `1h30m` is rejected so configuration values
 * stay unambiguous.
 */

// A Map, not an object literal: the key comes from a regex match, so a miss
// must return undefined rather than find something on Object.prototype.
const UNIT_MS = new Map<string, number>([
  ["ms", 1],
  ["s", 1_000],
  ["m", 60_000],
  ["h", 3_600_000],
  ["d", 86_400_000],
]);

// The trailing $ matters: unanchored, "500ms" matches the "m" branch and parses
// as 500 minutes.
const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

// A list rather than a joined string, so a caller can render one per line.
export const EXAMPLE_DURATIONS: readonly string[] = [
  "30s",
  "1m",
  "5m",
  "5h",
  "7d",
];

// Configured values are echoed back to the user, so cap what we repeat.
const MAX_ECHOED_LENGTH = 64;

/** Raised when a configured value cannot be used as a duration. */
export class InvalidDurationError extends Error {
  /** The original value, untrimmed, so a caller can find it in the source file. */
  readonly value: unknown;

  constructor(value: unknown, message: string) {
    super(message);
    this.name = "InvalidDurationError";
    this.value = value;
  }
}

/** Renders an untrusted configuration value for display. Never throws. */
function describe(value: unknown): string {
  switch (typeof value) {
    case "string": {
      const clipped =
        value.length > MAX_ECHOED_LENGTH
          ? `${value.slice(0, MAX_ECHOED_LENGTH)}…`
          : value;
      // JSON.stringify escapes control characters, so a crafted value cannot
      // inject terminal escapes into our output.
      return JSON.stringify(clipped);
    }
    case "number":
    case "boolean":
    case "bigint":
    case "undefined":
      return String(value);
    default:
      // Shape only; stringifying could reintroduce control characters.
      return value === null ? "null" : `a ${typeof value}`;
  }
}

/**
 * Parses a duration into milliseconds.
 *
 * Takes `unknown` because YAML yields a number for `resetGrace: 60` and a
 * boolean for `resetGrace: yes`.
 *
 * @throws {InvalidDurationError} when the value is not a supported duration, or
 * is too large to represent exactly.
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

  // Too large is a different mistake from malformed, so it gets its own message.
  if (!Number.isSafeInteger(milliseconds)) {
    const maximum = Math.floor(Number.MAX_SAFE_INTEGER / multiplier);
    throw new InvalidDurationError(
      input,
      `Duration ${describe(input)} is too large; the maximum is ${String(maximum)}${unit}.`,
    );
  }

  return milliseconds;
}
