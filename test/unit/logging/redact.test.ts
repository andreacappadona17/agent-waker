import { describe, expect, it } from "vitest";

import { redactValue, secretsFromEnv } from "#src/logging/redact.js";

/**
 * Canaries. None of these is a real credential, but each is shaped like one, so
 * a regression in the patterns below shows up as a test failure rather than as
 * a token in somebody's log file.
 */
const CANARIES = {
  anthropicApiKey: `sk-ant-api03-${"a".repeat(95)}`,
  anthropicOauth: `sk-ant-oat01-${"b".repeat(90)}`,
  openAiKey: `sk-proj-${"c".repeat(48)}`,
  githubToken: `ghp_${"d".repeat(36)}`,
  githubFineGrained: `github_pat_${"e".repeat(22)}_${"f".repeat(59)}`,
  jwt: `eyJhbGciOiJIUzI1NiJ9.${"g".repeat(40)}.${"h".repeat(43)}`,
} as const;

describe("redactValue", () => {
  it.each(Object.entries(CANARIES))("masks %s", (_name, canary) => {
    const redacted = redactValue(`token is ${canary}`, []);

    expect(redacted).not.toContain(canary);
    expect(redacted).toContain("[redacted]");
  });

  it("masks a bearer header without losing the shape of the line", () => {
    expect(redactValue(`Authorization: Bearer ${"z".repeat(40)}`, [])).toBe(
      "Authorization: Bearer [redacted]",
    );
  });

  it("masks a known environment value wherever it appears", () => {
    // The strongest rule: what we know is secret, rather than what looks it.
    const value = "hunter2-correct-horse";

    expect(redactValue(`login failed for ${value} in ${value}`, [value])).toBe(
      "login failed for [redacted] in [redacted]",
    );
  });

  it("masks a known value that no pattern would have caught", () => {
    expect(redactValue("password=swordfish", ["swordfish"])).toBe(
      "password=[redacted]",
    );
  });

  it("leaves ordinary text alone", () => {
    const message = "claude 2.1.4 rate limit resets at 08:23";

    expect(redactValue(message, [])).toBe(message);
  });

  it("does not mask something merely short and hex-looking", () => {
    // Version strings and commit hashes are not credentials.
    expect(redactValue("built from a1b2c3d", [])).toBe("built from a1b2c3d");
  });

  it("walks into objects and arrays", () => {
    expect(
      redactValue(
        {
          stderr: [`failed: ${CANARIES.githubToken}`],
          nested: { header: `Bearer ${"y".repeat(40)}` },
          exitCode: 1,
          ok: false,
          missing: null,
        },
        [],
      ),
    ).toEqual({
      stderr: ["failed: [redacted]"],
      nested: { header: "Bearer [redacted]" },
      exitCode: 1,
      ok: false,
      missing: null,
    });
  });

  it("redacts keys as well as values", () => {
    // An adapter that logs a map keyed by account would otherwise leak it.
    expect(redactValue({ [CANARIES.githubToken]: "seen" }, [])).toEqual({
      "[redacted]": "seen",
    });
  });

  it("truncates a long string rather than storing model output", () => {
    const long = "x".repeat(10_000);
    const redacted = redactValue(long, []) as string;

    expect(redacted.length).toBeLessThan(3_000);
    expect(redacted).toMatch(/truncated/);
  });

  it("ignores an empty secret, which would match everywhere", () => {
    expect(redactValue("anything", ["", "  "])).toBe("anything");
  });

  it("treats a secret as literal text, not as a pattern", () => {
    // An environment value containing regex metacharacters must not break the
    // redactor or match more than itself.
    expect(
      redactValue("a.c-and-then-some and abcXand-then-some", [
        "a.c-and-then-some",
      ]),
    ).toBe("[redacted] and abcXand-then-some");
  });

  it("ignores a secret too short to be one", () => {
    // A one-character "secret" matches between every character and would blank
    // the whole log; a short tenant id would redact an ordinary word. Both
    // reach here now that configuration can name secrets, which the
    // environment reader filtered on its own.
    expect(redactValue("team of 1 sent a token", ["1", "team"])).toBe(
      "team of 1 sent a token",
    );
  });
});

describe("secretsFromEnv", () => {
  it("picks the values of variables that name themselves as secret", () => {
    expect(
      secretsFromEnv({
        ANTHROPIC_API_KEY: "value-one-long-enough",
        GITHUB_TOKEN: "value-two-long-enough",
        MY_SECRET: "value-three-long-enough",
        DB_PASSWORD: "value-four-long-enough",
        AWS_CREDENTIALS: "value-five-long-enough",
      }).toSorted(),
    ).toEqual(
      [
        "value-one-long-enough",
        "value-two-long-enough",
        "value-three-long-enough",
        "value-four-long-enough",
        "value-five-long-enough",
      ].toSorted(),
    );
  });

  it("ignores variables that are not credentials", () => {
    expect(
      secretsFromEnv({
        HOME: "/Users/dev",
        PATH: "/usr/bin:/bin",
        TERM: "xterm",
      }),
    ).toEqual([]);
  });

  it("ignores a value too short to be worth redacting", () => {
    // Redacting "1" or "true" would blank out half of every log line.
    expect(secretsFromEnv({ API_KEY: "1", TOKEN_ENABLED: "true" })).toEqual([]);
  });

  it("ignores a variable that is not set", () => {
    expect(secretsFromEnv({ ANTHROPIC_API_KEY: undefined })).toEqual([]);
  });

  it("does not care about case", () => {
    expect(secretsFromEnv({ my_token: "value-long-enough-here" })).toEqual([
      "value-long-enough-here",
    ]);
  });
});
