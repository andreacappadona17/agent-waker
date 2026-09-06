import { describe, expect, it } from "vitest";

import {
  ConfigError,
  DEFAULT_TRANSIENT_DELAYS_MS,
  DEFAULT_UNKNOWN_RESET_DELAYS_MS,
  effectiveAgentConfig,
  parseConfig,
} from "#src/config/config.js";

const MINIMAL = `version: 1
timezone: Europe/Rome
`;

/** The example from the product requirements, verbatim in structure. */
const DOCUMENTED = `version: 1

timezone: Europe/Rome

schedule:
  notBefore: "07:00"

activation:
  resetGrace: 1m

retry:
  unknownReset:
    delays: [5m, 10m, 15m, 30m, 60m]
    repeatLastDelay: true
    normalWindowHorizon: 5h
  longTerm:
    interval: 6h

agents:
  claude:
    enabled: true

  codex:
    enabled: true

runtime:
  local:
    tickInterval: 1m
`;

/** Runs the parse and returns the error it was expected to raise. */
const failure = (source: string, file = "config.yaml"): ConfigError => {
  try {
    parseConfig(source, file);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }

  throw new Error("expected parseConfig to reject this source");
};

describe("parseConfig", () => {
  it("reads the documented example", () => {
    expect(parseConfig(DOCUMENTED, "config.yaml")).toEqual({
      version: 1,
      timezone: "Europe/Rome",
      schedule: { notBefore: { hour: 7, minute: 0 } },
      activation: { resetGraceMs: 60_000 },
      retry: {
        unknownReset: {
          delaysMs: [300_000, 600_000, 900_000, 1_800_000, 3_600_000],
          normalWindowHorizonMs: 18_000_000,
        },
        longTerm: { intervalMs: 21_600_000 },
        transient: { delaysMs: DEFAULT_TRANSIENT_DELAYS_MS },
      },
      runtime: { local: { tickIntervalMs: 60_000 } },
      logging: { level: "info" },
      agents: {
        claude: { enabled: true },
        codex: { enabled: true },
      },
    });
  });

  it("fills in every default from a minimal file", () => {
    // `init` writes a full file, but a hand-written one should still work, and
    // the defaults are the documented ones.
    expect(parseConfig(MINIMAL, "config.yaml")).toEqual({
      version: 1,
      timezone: "Europe/Rome",
      schedule: { notBefore: { hour: 7, minute: 0 } },
      activation: { resetGraceMs: 60_000 },
      retry: {
        unknownReset: {
          delaysMs: DEFAULT_UNKNOWN_RESET_DELAYS_MS,
          normalWindowHorizonMs: 18_000_000,
        },
        longTerm: { intervalMs: 21_600_000 },
        transient: { delaysMs: DEFAULT_TRANSIENT_DELAYS_MS },
      },
      runtime: { local: { tickIntervalMs: 60_000 } },
      logging: { level: "info" },
      agents: {
        claude: { enabled: true },
        codex: { enabled: true },
      },
    });
  });

  it("canonicalises the timezone", () => {
    expect(parseConfig("version: 1\ntimezone: us/pacific\n", "c.yaml")).toEqual(
      expect.objectContaining({ timezone: "America/Los_Angeles" }),
    );
  });

  describe("required fields", () => {
    it("requires a version", () => {
      expect(failure("timezone: Europe/Rome\n").message).toMatch(
        /version.*required/,
      );
    });

    it("requires a timezone, because guessing it would be silent", () => {
      expect(failure("version: 1\n").message).toMatch(/timezone.*required/);
    });

    it("refuses a version it does not understand", () => {
      const error = failure("version: 2\ntimezone: Europe/Rome\n");

      expect(error.message).toMatch(/version/);
      expect(error.line).toBe(1);
    });

    it("refuses an empty document", () => {
      expect(failure("").message).toMatch(/version.*required/);
    });

    it("refuses a document that is not a mapping", () => {
      expect(failure("- version: 1\n").message).toMatch(/mapping/);
    });
  });

  describe("positions", () => {
    it("points at the file, line and column of a bad value", () => {
      const error = failure(
        `version: 1
timezone: Europe/Roma
`,
        "/home/dev/.config/agent-waker/config.yaml",
      );

      expect(error.file).toBe("/home/dev/.config/agent-waker/config.yaml");
      expect(error.line).toBe(2);
      expect(error.column).toBe(11);
      expect(error.path).toBe("timezone");
    });

    it("renders as an editor-clickable location", () => {
      const error = failure(`version: 1
timezone: Europe/Rome
schedule:
  notBefore: "7 pm"
`);

      expect(error.message).toBe(
        'config.yaml:4:14: schedule.notBefore: Expected a 24-hour local time such as "07:00", but received "7 pm".',
      );
    });

    it("points inside a list, not at the list", () => {
      const error = failure(`version: 1
timezone: Europe/Rome
retry:
  unknownReset:
    delays:
      - 5m
      - later
`);

      expect(error.line).toBe(7);
      expect(error.path).toBe("retry.unknownReset.delays[1]");
    });

    it("reports a YAML syntax error at the point the parser gives up", () => {
      // Line 3 is where the unterminated flow sequence is finally detected.
      const error = failure("version: 1\nagents: [claude,\ncodex: true\n");

      expect(error.line).toBe(3);
      expect(error.message).toContain("config.yaml:3:1: ");
    });

    it("does not repeat the position inside the message", () => {
      // The YAML parser appends "at line 3, column 1:" to its own text, which
      // would read twice once the location prefix is in front of it.
      expect(
        failure("version: 1\nagents: [claude,\ncodex: true\n").message,
      ).not.toMatch(/at line \d+, column \d+/);
    });

    it("reports a duplicate key", () => {
      // The last value silently wins otherwise, which for `notBefore` means a
      // schedule the user cannot see in their own file.
      expect(failure(`${MINIMAL}timezone: UTC\n`).message).toMatch(
        /duplicate/i,
      );
    });
  });

  describe("telemetry", () => {
    it("is absent unless an endpoint is named", () => {
      expect(parseConfig(MINIMAL, "config.yaml").telemetry).toBeUndefined();
    });

    it("reads an endpoint, with defaults for the rest", () => {
      const config = parseConfig(
        `${MINIMAL}telemetry:\n  endpoint: http://localhost:4318\n`,
        "config.yaml",
      );

      expect(config.telemetry).toEqual({
        endpoint: "http://localhost:4318",
        headers: {},
        serviceName: "agent-waker",
        timeoutMs: 5_000,
      });
    });

    it("reads headers, a service name and a timeout", () => {
      const config = parseConfig(
        [
          MINIMAL,
          "telemetry:",
          "  endpoint: https://collector.example/otlp",
          "  serviceName: waker-laptop",
          "  timeout: 2s",
          "  headers:",
          "    x-scope-orgid: team",
          "",
        ].join("\n"),
        "config.yaml",
      );

      expect(config.telemetry).toEqual({
        endpoint: "https://collector.example/otlp",
        headers: { "x-scope-orgid": "team" },
        serviceName: "waker-laptop",
        timeoutMs: 2_000,
      });
    });

    it("refuses a block that configures an export with nowhere to send it", () => {
      // Silence is this feature's whole failure mode, so a half-written block
      // must not quietly do nothing.
      const error = failure(
        `${MINIMAL}telemetry:\n  serviceName: waker-laptop\n`,
      );

      expect(error.path).toBe("telemetry");
      expect(error.message).toMatch(/telemetry\.endpoint/);
    });

    it.each([
      ["https://id:token@collector.example", /telemetry\.headers/],
      ["http://localhost:4318/?api-key=secret", /telemetry\.headers/],
      ["http://localhost:4318/#frag", /telemetry\.headers/],
    ])("refuses a credential smuggled into %j", (endpoint, expected) => {
      const error = failure(
        `${MINIMAL}telemetry:\n  endpoint: "${endpoint}"\n`,
      );

      expect(error.path).toBe("telemetry.endpoint");
      expect(error.message).toMatch(expected);
    });

    it("bounds the export timeout, so a tick cannot outlive its interval", () => {
      const error = failure(
        `${MINIMAL}telemetry:\n  endpoint: http://localhost:4318\n  timeout: 10m\n`,
      );

      expect(error.path).toBe("telemetry.timeout");
      expect(error.message).toMatch(/30s/);
    });

    it.each([
      ["not-a-url", /url/i],
      ["file:///etc/passwd", /http/i],
      ["ftp://collector.example", /http/i],
    ])("rejects %j as an endpoint", (endpoint, expected) => {
      const error = failure(`${MINIMAL}telemetry:\n  endpoint: ${endpoint}\n`);

      expect(error.message).toMatch(expected);
      expect(error.path).toBe("telemetry.endpoint");
      expect(error.line).toBe(4);
    });

    it("rejects headers that are not a mapping", () => {
      const error = failure(
        `${MINIMAL}telemetry:\n  endpoint: http://localhost:4318\n  headers: nope\n`,
      );

      expect(error.path).toBe("telemetry.headers");
    });

    it("rejects a header value that is not text", () => {
      const error = failure(
        `${MINIMAL}telemetry:\n  endpoint: http://localhost:4318\n  headers:\n    x-count: 3\n`,
      );

      expect(error.message).toMatch(/x-count/);
    });

    it("rejects a blank service name", () => {
      const error = failure(
        `${MINIMAL}telemetry:\n  endpoint: http://localhost:4318\n  serviceName: "  "\n`,
      );

      expect(error.path).toBe("telemetry.serviceName");
    });

    it("rejects a misspelt telemetry key", () => {
      const error = failure(
        `${MINIMAL}telemetry:\n  endpoint: http://localhost:4318\n  servicename: x\n`,
      );

      expect(error.message).toMatch(/unknown/i);
    });
  });

  describe("logging", () => {
    it("defaults to info, so debug output is off", () => {
      expect(parseConfig(MINIMAL, "config.yaml").logging.level).toBe("info");
    });

    it("can be turned up, which is what makes debug events reachable", () => {
      const config = parseConfig(
        `${MINIMAL}logging:\n  level: debug\n`,
        "config.yaml",
      );

      expect(config.logging.level).toBe("debug");
    });

    it("rejects a level it does not have", () => {
      const error = failure(`${MINIMAL}logging:\n  level: verbose\n`);

      expect(error.path).toBe("logging.level");
      expect(error.message).toMatch(/debug, info, warn, error/);
    });
  });

  describe("unknown keys", () => {
    it("rejects a misspelt top-level key", () => {
      // A typo in a scheduler's config is silent until the morning it matters.
      const error = failure(`${MINIMAL}scheduel:\n  notBefore: "07:00"\n`);

      expect(error.message).toMatch(/unknown/i);
      expect(error.path).toBe("scheduel");
      expect(error.line).toBe(3);
    });

    it("rejects a misspelt nested key", () => {
      const error = failure(`${MINIMAL}schedule:\n  notbefore: "07:00"\n`);

      expect(error.path).toBe("schedule.notbefore");
    });

    it("rejects an unknown agent", () => {
      const error = failure(
        `${MINIMAL}agents:\n  cluade:\n    enabled: true\n`,
      );

      expect(error.message).toMatch(/cluade/);
      expect(error.path).toBe("agents.cluade");
    });

    it("names the agents it does know", () => {
      expect(
        failure(`${MINIMAL}agents:\n  gemini:\n    enabled: true\n`),
      ).toHaveProperty("message", expect.stringContaining("claude"));
    });
  });

  describe("value validation", () => {
    it("rejects a non-boolean enabled flag", () => {
      const error = failure(
        `${MINIMAL}agents:\n  claude:\n    enabled: sometimes\n`,
      );

      expect(error.path).toBe("agents.claude.enabled");
      expect(error.message).toMatch(/true or false/);
    });

    it("rejects an empty retry ladder", () => {
      const error = failure(
        `${MINIMAL}retry:\n  unknownReset:\n    delays: []\n`,
      );

      expect(error.message).toMatch(/at least one/);
    });

    it("rejects a zero delay, which would spin", () => {
      const error = failure(
        `${MINIMAL}retry:\n  unknownReset:\n    delays: [0s]\n`,
      );

      expect(error.message).toMatch(/greater than zero/);
    });

    it.each([
      ["retry:\n  unknownReset:\n    normalWindowHorizon: 0s\n"],
      ["retry:\n  longTerm:\n    interval: 0s\n"],
      ["runtime:\n  local:\n    tickInterval: 0s\n"],
    ])("rejects a zero interval in %j", (fragment) => {
      expect(failure(MINIMAL + fragment).message).toMatch(/greater than zero/);
    });

    it("accepts a zero reset grace", () => {
      // Waiting no longer than the provider says is a legitimate choice.
      expect(
        parseConfig(`${MINIMAL}activation:\n  resetGrace: 0s\n`, "config.yaml")
          .activation.resetGraceMs,
      ).toBe(0);
    });

    it("rejects an empty entry in the retry ladder", () => {
      const error = failure(
        `${MINIMAL}retry:\n  unknownReset:\n    delays:\n      - 5m\n      -\n`,
      );

      expect(error.path).toBe("retry.unknownReset.delays[1]");
      expect(error.message).toMatch(/received null/);
    });

    it("rejects an agents section that is not a mapping", () => {
      expect(failure(`${MINIMAL}agents: [claude, codex]\n`).message).toMatch(
        /mapping of agent names/,
      );
    });

    it("rejects a key that is not a plain name", () => {
      // A YAML complex key cannot be a setting name, and reaches the same
      // "unknown key" path as a typo.
      expect(failure(`${MINIMAL}? [a, b]\n: 1\n`).message).toMatch(/unknown/i);
    });

    it("rejects a retry ladder that is not a list", () => {
      const error = failure(
        `${MINIMAL}retry:\n  unknownReset:\n    delays: 5m\n`,
      );

      expect(error.message).toMatch(/list/);
    });

    it("refuses repeatLastDelay: false, which has no defined behaviour yet", () => {
      // Failing closed beats inventing a meaning for the end of the ladder.
      const error = failure(
        `${MINIMAL}retry:\n  unknownReset:\n    repeatLastDelay: false\n`,
      );

      expect(error.message).toMatch(/repeatLastDelay/);
      expect(error.line).toBe(5);
    });

    it("accepts repeatLastDelay: true", () => {
      expect(() =>
        parseConfig(
          `${MINIMAL}retry:\n  unknownReset:\n    repeatLastDelay: true\n`,
          "config.yaml",
        ),
      ).not.toThrow();
    });
  });

  describe("agents", () => {
    it("enables every known agent when the section is absent", () => {
      expect(parseConfig(MINIMAL, "config.yaml").agents).toEqual({
        claude: { enabled: true },
        codex: { enabled: true },
      });
    });

    it("keeps an agent that is not listed enabled", () => {
      expect(
        parseConfig(`${MINIMAL}agents:\n  claude:\n    enabled: false\n`, "c")
          .agents,
      ).toEqual({
        claude: { enabled: false },
        codex: { enabled: true },
      });
    });

    it("reads a per-agent schedule override", () => {
      const config = parseConfig(
        `${MINIMAL}agents:\n  claude:\n    enabled: true\n    schedule:\n      notBefore: "06:45"\n`,
        "config.yaml",
      );

      expect(config.agents.claude.schedule).toEqual({
        notBefore: { hour: 6, minute: 45 },
      });
      expect(config.agents.codex.schedule).toBeUndefined();
    });
  });
});

describe("effectiveAgentConfig", () => {
  const config = parseConfig(DOCUMENTED, "config.yaml");

  it("takes the global settings when the agent overrides nothing", () => {
    expect(effectiveAgentConfig(config, "codex")).toEqual({
      agentId: "codex",
      enabled: true,
      timezone: "Europe/Rome",
      notBefore: { hour: 7, minute: 0 },
      resetGraceMs: 60_000,
      unknownResetDelaysMs: [300_000, 600_000, 900_000, 1_800_000, 3_600_000],
      normalWindowHorizonMs: 18_000_000,
      longTermRetryMs: 21_600_000,
      transientDelaysMs: DEFAULT_TRANSIENT_DELAYS_MS,
    });
  });

  it("prefers a per-agent notBefore", () => {
    const overridden = parseConfig(
      `${MINIMAL}agents:\n  claude:\n    schedule:\n      notBefore: "06:45"\n`,
      "config.yaml",
    );

    expect(effectiveAgentConfig(overridden, "claude").notBefore).toEqual({
      hour: 6,
      minute: 45,
    });
    expect(effectiveAgentConfig(overridden, "codex").notBefore).toEqual({
      hour: 7,
      minute: 0,
    });
  });

  it("carries the agent's enabled flag", () => {
    const disabled = parseConfig(
      `${MINIMAL}agents:\n  codex:\n    enabled: false\n`,
      "config.yaml",
    );

    expect(effectiveAgentConfig(disabled, "codex").enabled).toBe(false);
    expect(effectiveAgentConfig(disabled, "claude").enabled).toBe(true);
  });
});
