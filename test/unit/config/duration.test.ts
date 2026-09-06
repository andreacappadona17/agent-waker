import { describe, expect, it } from "vitest";

import {
  EXAMPLE_DURATIONS,
  InvalidDurationError,
  parseDuration,
} from "#src/config/duration.js";

describe("parseDuration", () => {
  it.each([
    ["500ms", 500],
    ["30s", 30_000],
    ["1m", 60_000],
    ["5m", 300_000],
    ["60m", 3_600_000],
    ["5h", 18_000_000],
    ["6h", 21_600_000],
    ["7d", 604_800_000],
    ["0s", 0],
    ["  5m  ", 300_000],
    ["5M", 300_000],
    ["2H", 7_200_000],
    ["250MS", 250],
  ])("parses %j", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  // Annotated so mixed rows infer as one tuple type; otherwise the callback
  // is forced to take both columns.
  it.each<[input: unknown, description: string]>([
    ["", "empty string"],
    ["   ", "blank string"],
    ["5", "missing unit"],
    ["m", "missing amount"],
    ["1.5h", "fractional amount"],
    ["5w", "unsupported unit"],
    ["-5m", "negative amount"],
    ["+5m", "signed amount"],
    ["5 m", "internal whitespace"],
    ["5m30s", "compound duration"],
    ["tomorrow", "prose"],
    ["1e3s", "exponent notation"],
    // YAML yields non-strings for `resetGrace: 60`, `resetGrace: yes` and
    // `resetGrace:` with no value, so they reach this parser unnarrowed.
    [60, "a number"],
    [true, "a boolean"],
    [null, "null"],
    [undefined, "undefined"],
    [{ minutes: 5 }, "an object"],
    [["5m"], "an array"],
  ])("rejects %j (%s)", (input) => {
    expect(() => parseDuration(input)).toThrow(InvalidDurationError);
  });

  it.each([
    ["٥m", "arabic-indic digits"],
    ["５m", "full-width digits"],
    ["०१m", "devanagari digits"],
    ["²m", "superscript digits"],
  ])("rejects %j (%s)", (input) => {
    // JS \d is ASCII-only. Pinned so a later change cannot silently accept
    // digits that Number() turns into NaN.
    expect(() => parseDuration(input)).toThrow(InvalidDurationError);
  });

  it.each(["5constructor", "5__proto__", "5toString", "5valueOf"])(
    "rejects the prototype key %j",
    (input) => {
      expect(() => parseDuration(input)).toThrow(InvalidDurationError);
    },
  );

  describe("the safe-integer boundary", () => {
    it("accepts the largest exactly representable duration", () => {
      expect(parseDuration("9007199254740991ms")).toBe(Number.MAX_SAFE_INTEGER);
      expect(parseDuration("104249991d")).toBe(104_249_991 * 86_400_000);
    });

    it("rejects one unit beyond it", () => {
      expect(() => parseDuration("9007199254740992ms")).toThrow(
        InvalidDurationError,
      );
      expect(() => parseDuration("104249992d")).toThrow(InvalidDurationError);
    });

    it("distinguishes an absurd duration from a malformed one", () => {
      // A huge duration is well formed, so offering examples would not help.
      const absurd = (): number => parseDuration("104249992d");

      expect(absurd).toThrow(/is too large; the maximum is 104249991d/);
      expect(absurd).not.toThrow(/Expected a duration such as/);
    });
  });

  describe("the error", () => {
    it("reports the offending value and the example durations", () => {
      expect(() => parseDuration("tomorrow")).toThrow(
        `Expected a duration such as ${EXAMPLE_DURATIONS.join(", ")}, but received "tomorrow".`,
      );
    });

    it("carries the original, untrimmed value for the config loader", () => {
      // A caller matches this against the raw file to find the line.
      expect.assertions(2);

      try {
        parseDuration("   bogus   ");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidDurationError);
        expect((error as InvalidDurationError).value).toBe("   bogus   ");
      }
    });

    it("does not echo an unbounded value", () => {
      expect.assertions(1);

      try {
        parseDuration("x".repeat(5_000_000));
      } catch (error) {
        expect((error as Error).message.length).toBeLessThan(200);
      }
    });

    it("does not emit raw terminal escapes from a crafted value", () => {
      // Config is user-controlled input echoed to a terminal.
      const esc = String.fromCharCode(27);
      const escapedForm = JSON.stringify(esc).slice(1, -1);

      expect.assertions(2);

      try {
        parseDuration(`${esc}[2J${esc}[31mFAKE ERROR`);
      } catch (error) {
        const { message } = error as Error;

        expect(message).not.toContain(esc);
        expect(message).toContain(escapedForm);
      }
    });
  });
});
