/**
 * Renders an untrusted value — a configuration entry, a field read back from
 * state — for display in an error message.
 */

// Configured values are echoed back to the user, so cap what we repeat.
const MAX_ECHOED_LENGTH = 64;

/** Renders a value for display. Never throws. */
export function describeValue(value: unknown): string {
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
