import { describe, expect, it } from "vitest";

import {
  ASCII_LABELS,
  colourise,
  dayLabel,
  iconFor,
  relativeTime,
  supportsColour,
  supportsUnicode,
  table,
} from "#src/cli/format.js";

const utc = (iso: string): number => Date.parse(iso);

/** 2026-09-07, a Monday, in Europe/Rome (CEST, UTC+2). */
const at = (localTime: string, day = "07"): number =>
  utc(`2026-09-${day}T${localTime}:00.000Z`) - 2 * 3_600_000;

const now = at("09:00");
const zone = "Europe/Rome";

describe("relativeTime", () => {
  it("says nothing when there is nothing to say", () => {
    expect(relativeTime(undefined, now, zone)).toBe("—");
  });

  it.each([
    ["07:00", "07", "today 07:00"],
    ["23:59", "07", "today 23:59"],
    ["07:00", "08", "tomorrow 07:00"],
    ["07:00", "06", "yesterday 07:00"],
  ])("renders %s on the %sth as %j", (time, day, expected) => {
    expect(relativeTime(at(time, day), now, zone)).toBe(expected);
  });

  it("names the weekday within the coming week", () => {
    // The weekly-limit case: a day name is what the user needs to read.
    expect(relativeTime(at("14:01", "10"), now, zone)).toBe("Thu 14:01");
  });

  it("falls back to a date once a weekday would be ambiguous", () => {
    // Exactly a week out is the same weekday as today, so naming it says
    // nothing. This is the boundary, and a weekly reset can land on it.
    expect(relativeTime(at("14:01", "14"), now, zone)).toBe("2026-09-14 14:01");
    expect(relativeTime(at("14:01", "21"), now, zone)).toBe("2026-09-21 14:01");
  });

  it("names a weekday in the recent past too", () => {
    expect(relativeTime(at("07:00", "03"), now, zone)).toBe("Thu 07:00");
  });

  it("follows the configured zone, not the machine's", () => {
    // 22:30Z is the next day in Rome and the same day in Los Angeles.
    const instant = utc("2026-09-07T22:30:00.000Z");

    expect(relativeTime(instant, now, zone)).toBe("tomorrow 00:30");
    expect(relativeTime(instant, now, "America/Los_Angeles")).toBe(
      "today 15:30",
    );
  });

  it("keeps the wall clock across a daylight-saving change", () => {
    // 07:00 the morning after the clocks go back is still 07:00.
    const sunday = Date.parse("2026-10-25T06:00:00.000Z");
    const monday = Date.parse("2026-10-26T06:00:00.000Z");

    expect(relativeTime(monday, sunday, zone)).toBe("tomorrow 07:00");
  });
});

describe("dayLabel", () => {
  it("names the day without a clock, so a caller can add its own", () => {
    expect(dayLabel(at("09:30"), now, zone)).toBe("today");
    expect(dayLabel(at("07:00", "08"), now, zone)).toBe("tomorrow");
    expect(dayLabel(at("07:00", "06"), now, zone)).toBe("yesterday");
  });
});

describe("relativeTime, given a timestamp that did not parse", () => {
  it("says so rather than throwing", () => {
    // `logs` reads timestamps out of a file, and `Intl` throws a RangeError on
    // an unparseable one rather than returning anything printable.
    expect(() => relativeTime(Number.NaN, now, zone)).not.toThrow();
    expect(relativeTime(Number.NaN, now, zone)).toBe("—");
  });
});

describe("iconFor", () => {
  it.each([
    ["activated", "✓"],
    ["waiting_known_reset", "⏳"],
    ["waiting_unknown_reset", "⏳"],
    ["long_term_block", "⏳"],
    ["auth_required", "!"],
    ["unhealthy", "✗"],
    ["failed", "✗"],
    ["idle", "○"],
    ["ready", "?"],
  ] as const)("marks %s with %s", (phase, icon) => {
    expect(iconFor(phase, { unicode: true })).toBe(icon);
  });

  it("falls back to words a non-Unicode terminal can print", () => {
    // Text has to carry the meaning; the icon only reinforces it.
    expect(iconFor("activated", { unicode: false })).toBe(ASCII_LABELS.ok);
    expect(iconFor("unhealthy", { unicode: false })).toBe(ASCII_LABELS.error);
  });

  it("uses fallbacks that are all the same width", () => {
    // Otherwise the table stops lining up the moment something goes wrong.
    const widths = new Set(
      Object.values(ASCII_LABELS).map((label) => label.length),
    );

    expect(widths.size).toBe(1);
  });
});

describe("supportsColour", () => {
  it("is on for an interactive terminal", () => {
    expect(supportsColour({ env: {}, isTty: true })).toBe(true);
  });

  it("is off when the output is a pipe", () => {
    expect(supportsColour({ env: {}, isTty: false })).toBe(false);
  });

  it.each(["1", "", "true", "0"])(
    "is off when NO_COLOR is set to %j",
    (value) => {
      // The convention is presence, not value: even an empty NO_COLOR counts.
      expect(supportsColour({ env: { NO_COLOR: value }, isTty: true })).toBe(
        false,
      );
    },
  );

  it("is off when the terminal says it is dumb", () => {
    expect(supportsColour({ env: { TERM: "dumb" }, isTty: true })).toBe(false);
  });
});

describe("supportsUnicode", () => {
  it.each(["en_GB.UTF-8", "C.UTF-8", "en_US.utf8"])(
    "is on for the locale %j",
    (value) => {
      expect(supportsUnicode({ LC_ALL: value })).toBe(true);
    },
  );

  it.each([{ LANG: "C" }, { LC_ALL: "POSIX" }, {}])("is off for %j", (env) => {
    expect(supportsUnicode(env)).toBe(false);
  });

  it("prefers LC_ALL over LANG, as the shell does", () => {
    expect(supportsUnicode({ LC_ALL: "C", LANG: "en_GB.UTF-8" })).toBe(false);
  });
});

describe("colourise", () => {
  it("wraps text in the requested colour", () => {
    expect(colourise("ok", "green", true)).toBe("\u001b[32mok\u001b[39m");
  });

  it("leaves text alone when colour is off", () => {
    expect(colourise("ok", "green", false)).toBe("ok");
  });
});

describe("table", () => {
  const rows = [
    ["Claude Code", "Activated", "today 07:00"],
    ["Codex", "Usage window limited", "08:24"],
  ];

  it("lines the columns up", () => {
    const lines = table(["Agent", "State", "Next action"], rows).split("\n");
    const starts = lines.slice(2).map((line) =>
      line.lastIndexOf(
        line
          .trimEnd()
          .split(/\s{2,}/)
          .at(-1) ?? "",
      ),
    );

    expect(new Set(starts).size).toBe(1);
  });

  it("puts a rule under the header", () => {
    const [, rule] = table(["Agent", "State", "Next"], rows).split("\n");

    expect(rule).toMatch(/^─+$/);
  });

  it("measures the visible width, not the escape codes", () => {
    // A coloured cell is longer than it looks, and padding by length would
    // knock every column after it out of alignment.
    const coloured = table(
      ["A", "B"],
      [[colourise("ok", "green", true), "second"]],
    );
    const plain = table(["A", "B"], [["ok", "second"]]);

    // Two sequences per cell, opening and reset, neither of them visible.
    const overhead = colourise("ok", "green", true).length - "ok".length;

    expect(coloured.indexOf("second")).toBe(plain.indexOf("second") + overhead);
  });

  it("does not pad the last column", () => {
    // Trailing whitespace shows up in diffs and in copied output.
    for (const line of table(["A", "B"], rows).split("\n")) {
      expect(line).toBe(line.trimEnd());
    }
  });
});
