import { describe, expect, it } from "vitest";

import {
  formatLocalTime,
  InvalidLocalTimeError,
  InvalidTimeZoneError,
  localDateAt,
  parseLocalTime,
  parseTimeZone,
  resolveLocalTime,
} from "#src/core/time.js";

/** Reads better in a table than a `Date.parse` call per row. */
const utc = (iso: string): number => Date.parse(`${iso}Z`);

describe("parseTimeZone", () => {
  it.each([
    ["Europe/Rome", "Europe/Rome"],
    ["America/New_York", "America/New_York"],
    ["Australia/Lord_Howe", "Australia/Lord_Howe"],
    ["UTC", "UTC"],
    // ICU canonicalises case, aliases and the legacy US/* names. Accepting them
    // costs nothing and a user who copied one from `date` gets a working config.
    ["europe/rome", "Europe/Rome"],
    ["utc", "UTC"],
    ["US/Pacific", "America/Los_Angeles"],
    ["  Europe/Rome  ", "Europe/Rome"],
  ])("accepts %j as %j", (input, expected) => {
    expect(parseTimeZone(input)).toBe(expected);
  });

  it.each<[input: unknown, description: string]>([
    ["Europe/Roma", "a misspelt name"],
    ["Mars/Olympus_Mons", "an unknown region"],
    ["", "empty string"],
    ["   ", "blank string"],
    ["Z", "a zulu designator"],
    [0, "a number"],
    [true, "a boolean"],
    [null, "null"],
    [undefined, "undefined"],
    [{ name: "Europe/Rome" }, "an object"],
    [["Europe/Rome"], "an array"],
  ])("rejects %j (%s)", (input) => {
    expect(() => parseTimeZone(input)).toThrow(InvalidTimeZoneError);
  });

  it.each(["+05:30", "+0530", "-08:00", "+00:00"])(
    "rejects the fixed offset %j",
    (input) => {
      // Intl accepts these, but a fixed offset cannot express "07:00 local
      // across a daylight-saving change", which is the whole point of the
      // setting. Rejecting beats silently drifting by an hour for half the year.
      expect(() => parseTimeZone(input)).toThrow(InvalidTimeZoneError);
    },
  );

  describe("the error", () => {
    it("names the offending value and suggests the IANA form", () => {
      expect(() => parseTimeZone("Europe/Roma")).toThrow(
        /"Europe\/Roma".*IANA/s,
      );
    });

    it("explains why a fixed offset is refused", () => {
      expect(() => parseTimeZone("+05:30")).toThrow(/daylight saving/);
    });

    it("carries the original value for the config loader", () => {
      expect.assertions(2);

      try {
        parseTimeZone("  Europe/Roma  ");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidTimeZoneError);
        expect((error as InvalidTimeZoneError).value).toBe("  Europe/Roma  ");
      }
    });

    it("does not emit raw terminal escapes from a crafted value", () => {
      const esc = String.fromCharCode(27);
      expect.assertions(1);

      try {
        parseTimeZone(`${esc}[2JEurope/Rome`);
      } catch (error) {
        expect((error as Error).message).not.toContain(esc);
      }
    });
  });
});

describe("parseLocalTime", () => {
  it.each([
    ["00:00", 0, 0],
    ["07:00", 7, 0],
    ["06:45", 6, 45],
    ["23:59", 23, 59],
    // A single-digit hour is what people type; canonicalising beats refusing.
    ["7:00", 7, 0],
    ["  07:00  ", 7, 0],
  ])("parses %j as %i:%i", (input, hour, minute) => {
    expect(parseLocalTime(input)).toEqual({ hour, minute });
  });

  it.each<[input: unknown, description: string]>([
    ["24:00", "an hour past midnight"],
    ["23:60", "a minute past the hour"],
    ["-1:00", "a negative hour"],
    ["07", "no minutes"],
    ["07:00:00", "seconds"],
    ["0700", "no separator"],
    ["07:0", "a single-digit minute"],
    ["7 pm", "a meridiem"],
    ["noon", "prose"],
    ["07:00 Europe/Rome", "a trailing timezone"],
    ["", "empty string"],
    ["   ", "blank string"],
    // YAML 1.1 reads an unquoted `7:00` as sexagesimal 420, and an unquoted
    // `0700` as a number, so both reach this parser unnarrowed.
    [420, "a number"],
    [700, "an unquoted digit run"],
    [true, "a boolean"],
    [null, "null"],
    [undefined, "undefined"],
    [{ hour: 7, minute: 0 }, "an object"],
    [["07:00"], "an array"],
  ])("rejects %j (%s)", (input) => {
    expect(() => parseLocalTime(input)).toThrow(InvalidLocalTimeError);
  });

  it.each([
    ["０７:００", "full-width digits"],
    ["٠٧:٠٠", "arabic-indic digits"],
  ])("rejects %j (%s)", (input) => {
    expect(() => parseLocalTime(input)).toThrow(InvalidLocalTimeError);
  });

  describe("the error", () => {
    it("shows the expected form and the offending value", () => {
      expect(() => parseLocalTime("7 pm")).toThrow(
        /"07:00".*but received "7 pm"/s,
      );
    });

    it("tells a YAML author to quote a value that parsed as a number", () => {
      expect(() => parseLocalTime(420)).toThrow(/quote/i);
    });

    it("carries the original, untrimmed value for the config loader", () => {
      expect.assertions(2);

      try {
        parseLocalTime("  7 pm  ");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidLocalTimeError);
        expect((error as InvalidLocalTimeError).value).toBe("  7 pm  ");
      }
    });
  });
});

describe("localDateAt", () => {
  it.each([
    ["Europe/Rome", "2026-09-06T22:30:00", "2026-09-07"],
    ["America/Los_Angeles", "2026-09-06T22:30:00", "2026-09-06"],
    ["UTC", "2026-09-06T22:30:00", "2026-09-06"],
    // Crossing the year boundary backwards, and zero padding on both fields.
    ["America/New_York", "2026-01-01T00:30:00", "2025-12-31"],
    ["UTC", "2026-02-03T12:00:00", "2026-02-03"],
    // Kiribati is UTC+14, the far side of the date line.
    ["Pacific/Kiritimati", "2026-09-06T11:00:00", "2026-09-07"],
  ])("in %s, %s is %s", (timeZone, instant, expected) => {
    expect(localDateAt(utc(instant), timeZone)).toBe(expected);
  });

  it("follows the local clock across a daylight-saving change", () => {
    // Both instants are 22:30Z, either side of the CET/CEST change at 01:00Z on
    // 2026-03-29. The extra hour of offset tips the second into the next day.
    expect(localDateAt(utc("2026-03-28T22:30:00"), "Europe/Rome")).toBe(
      "2026-03-28",
    );
    expect(localDateAt(utc("2026-03-29T22:30:00"), "Europe/Rome")).toBe(
      "2026-03-30",
    );
  });
});

describe("resolveLocalTime", () => {
  it.each([
    // The product promise: 07:00 Europe/Rome is 07:00 local in both CET and
    // CEST, so the instant differs by an hour across the year.
    ["Europe/Rome", "2026-01-15", "2026-01-15T06:00:00"],
    ["Europe/Rome", "2026-07-15", "2026-07-15T05:00:00"],
    // A half-hour zone with no daylight saving at all.
    ["Asia/Kolkata", "2026-06-15", "2026-06-15T01:30:00"],
    ["UTC", "2026-06-15", "2026-06-15T07:00:00"],
  ])("resolves 07:00 %s on %s to %s", (timeZone, date, expected) => {
    expect(resolveLocalTime(date, { hour: 7, minute: 0 }, timeZone)).toBe(
      utc(expected),
    );
  });

  describe("a spring-forward gap", () => {
    // Europe/Rome 2026-03-29: 02:00 CET becomes 03:00 CEST, so 02:00-02:59
    // never happens on the local clock.
    it("moves a time inside the gap forward by the size of the gap", () => {
      expect(
        resolveLocalTime("2026-03-29", { hour: 2, minute: 30 }, "Europe/Rome"),
      ).toBe(utc("2026-03-29T01:30:00"));
    });

    it("resolves the first missing minute to the transition itself", () => {
      expect(
        resolveLocalTime("2026-03-29", { hour: 2, minute: 0 }, "Europe/Rome"),
      ).toBe(utc("2026-03-29T01:00:00"));
    });

    it("leaves the minute before the gap alone", () => {
      expect(
        resolveLocalTime("2026-03-29", { hour: 1, minute: 59 }, "Europe/Rome"),
      ).toBe(utc("2026-03-29T00:59:00"));
    });

    it("leaves the first minute after the gap alone", () => {
      expect(
        resolveLocalTime("2026-03-29", { hour: 3, minute: 0 }, "Europe/Rome"),
      ).toBe(utc("2026-03-29T01:00:00"));
    });

    it("handles a thirty-minute gap", () => {
      // Australia/Lord_Howe 2026-10-04: 02:00 +10:30 becomes 02:30 +11:00.
      expect(
        resolveLocalTime(
          "2026-10-04",
          { hour: 2, minute: 15 },
          "Australia/Lord_Howe",
        ),
      ).toBe(utc("2026-10-03T15:45:00"));
    });

    it("handles a southern-hemisphere gap", () => {
      // America/Los_Angeles 2026-03-08: 02:00 PST becomes 03:00 PDT.
      expect(
        resolveLocalTime(
          "2026-03-08",
          { hour: 2, minute: 30 },
          "America/Los_Angeles",
        ),
      ).toBe(utc("2026-03-08T10:30:00"));
    });
  });

  describe("a fall-back ambiguity", () => {
    // Europe/Rome 2026-10-25: 03:00 CEST becomes 02:00 CET, so 02:00-02:59
    // happens twice.
    it("picks the first occurrence", () => {
      expect(
        resolveLocalTime("2026-10-25", { hour: 2, minute: 30 }, "Europe/Rome"),
      ).toBe(utc("2026-10-25T00:30:00"));
    });

    it("picks the first occurrence of the boundary minute", () => {
      expect(
        resolveLocalTime("2026-10-25", { hour: 2, minute: 0 }, "Europe/Rome"),
      ).toBe(utc("2026-10-25T00:00:00"));
    });

    it("leaves an unambiguous time later the same day alone", () => {
      expect(
        resolveLocalTime("2026-10-25", { hour: 3, minute: 0 }, "Europe/Rome"),
      ).toBe(utc("2026-10-25T02:00:00"));
    });

    it("handles a thirty-minute overlap", () => {
      // Australia/Lord_Howe 2026-04-05: 02:00 +11:00 becomes 01:30 +10:30.
      expect(
        resolveLocalTime(
          "2026-04-05",
          { hour: 1, minute: 45 },
          "Australia/Lord_Howe",
        ),
      ).toBe(utc("2026-04-04T14:45:00"));
    });
  });

  it("round-trips every local date it produces", () => {
    // The pair has to compose: policy resolves notBefore for the local date of
    // `now`, so a date localDateAt returns must always resolve back into the
    // same day. Walks a whole year of a zone that changes offset twice.
    const timeZone = "Europe/Rome";
    const start = utc("2026-01-01T00:00:00");

    for (let day = 0; day < 365; day += 1) {
      const instant = start + day * 86_400_000;
      const date = localDateAt(instant, timeZone);
      const resolved = resolveLocalTime(date, { hour: 7, minute: 0 }, timeZone);

      expect(localDateAt(resolved, timeZone)).toBe(date);
    }
  });

  it("rejects a malformed local date", () => {
    // State is read back from a file a user can edit, so the shape is checked.
    expect(() =>
      resolveLocalTime("2026-9-6", { hour: 7, minute: 0 }, "Europe/Rome"),
    ).toThrow(/2026-9-6/);
  });

  it("rejects a date that does not exist", () => {
    expect(() =>
      resolveLocalTime("2026-02-30", { hour: 7, minute: 0 }, "Europe/Rome"),
    ).toThrow(/2026-02-30/);
  });
});

describe("formatLocalTime", () => {
  it.each([
    [{ hour: 7, minute: 0 }, "07:00"],
    [{ hour: 0, minute: 0 }, "00:00"],
    [{ hour: 23, minute: 59 }, "23:59"],
    [{ hour: 6, minute: 45 }, "06:45"],
  ])("renders %j as %j", (time, expected) => {
    expect(formatLocalTime(time)).toBe(expected);
  });

  it("round-trips whatever the parser accepts", () => {
    // A single-digit hour comes back padded, which is the canonical form.
    expect(formatLocalTime(parseLocalTime("7:00"))).toBe("07:00");
  });
});
