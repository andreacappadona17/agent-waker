import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createEventLog } from "#src/logging/log.js";
import { redactValue, type JsonValue } from "#src/logging/redact.js";
import { createTelemetry } from "#src/telemetry/otlp.js";

const AT = Date.parse("2026-09-07T05:00:02.000Z");
const SEED = 0x51ec7;
const fixtures = await Promise.all(
  ["claude/activation-success.json", "codex/activation-usage-limit.jsonl"].map(
    (name) => readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"),
  ),
);

function assertMasked(
  value: unknown,
  credentials: readonly string[],
  expectedMaskedStrings: readonly string[],
  label: string,
): void {
  if (typeof value === "string") {
    for (const credential of credentials) {
      expect(value, label).not.toContain(credential);
      expect(value, label).not.toContain(
        JSON.stringify(credential).slice(1, -1),
      );
    }
    if (value.includes("[redacted]")) {
      expect(expectedMaskedStrings, label).toContain(value);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      assertMasked(item, credentials, expectedMaskedStrings, label);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      assertMasked(key, credentials, expectedMaskedStrings, label);
      assertMasked(item, credentials, expectedMaskedStrings, label);
    }
  }
}

// Synthetic credentials only. A fixed seed makes every failure reproducible.
function cases() {
  let state = SEED;
  const random = (maximum: number): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;

    return (state >>> 0) % maximum;
  };
  const word = (
    length: number,
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ): string =>
    Array.from({ length }, () => alphabet.charAt(random(alphabet.length))).join(
      "",
    );

  return Array.from({ length: 96 }, (_, index) => {
    const suffix = word(index % 24 < 12 ? 20 : 20 + random(80));
    const variants = [
      `sk-ant-api03-${suffix}`,
      `sk-ant-oat01-${suffix}`,
      `sk-${suffix}`,
      `sk-proj-${suffix}`,
      ...["p", "o", "u", "s", "r"].map((kind) => `gh${kind}_${suffix}`),
      `github_pat_${suffix}_${word(20)}`,
      `eyJ${word(8)}.${word(8 + random(40))}.${word(8 + random(40))}`,
      word(16 + random(60), "abcXYZ019.~+/=-"),
    ];
    const credential = variants[index % variants.length] ?? suffix;
    const bearerWhitespace = [" ", "\t", "\n", "\r", "\f", "\v"][
      Math.floor(index / variants.length) % 6
    ];
    const presented =
      index % variants.length === 11
        ? `bEaReR${bearerWhitespace ?? " "}${credential}`
        : credential;
    const delimiters = [" ", ":", "\n", '"', "🧪", "prefix_", "adjacentWord"];
    const before = delimiters[index % delimiters.length] ?? " ";
    const message = `provider returned ${before}${presented}; repeated=${presented}`;
    const envSecret = `env.[${word(16)}]"\\\n`;
    const configSecret = `config.*(${word(16)})?\t`;
    const secrets = [envSecret, configSecret];
    const credentials = [credential, ...secrets];
    const fixture = fixtures[index % fixtures.length] ?? "";
    const fixtureMessage = `${message}; env=${envSecret}; config=${configSecret}`;
    const stdout = fixture.replace(/OK|You've hit your usage limit\./g, () =>
      JSON.stringify(fixtureMessage).slice(1, -1),
    );
    // Independent full-mask templates reject a partial credential match that
    // removes the complete canary but leaves its suffix behind.
    const expectedCredential =
      index % variants.length === 11 ? "Bearer [redacted]" : "[redacted]";
    const expectedMessage = `provider returned ${before}${expectedCredential}; repeated=${expectedCredential}`;
    const expectedStdout = fixture.replace(
      /OK|You've hit your usage limit\./g,
      () =>
        JSON.stringify(
          `${expectedMessage}; env=[redacted]; config=[redacted]`,
        ).slice(1, -1),
    );
    const expectedMaskedStrings = [
      expectedCredential,
      "[redacted]",
      expectedMessage,
      expectedStdout,
      `${expectedMessage} ${"x".repeat(2000 - expectedMessage.length - 1)}… (truncated)`,
    ];
    let nested: JsonValue = {
      [presented]: [message, ...secrets, null, true, index],
    };

    for (let depth = 0; depth < 1 + random(4); depth += 1) {
      nested = random(2) === 0 ? [nested] : { [envSecret]: nested };
    }
    const fields = {
      stdout,
      nested,
      safe: "safe-provider-detail",
      // Exercise masking before truncation, with credentials on both sides.
      oversized: `${message} ${"x".repeat(2000 + random(500))} ${message}`,
    };

    return {
      index,
      credentials,
      expectedMaskedStrings,
      message,
      fields,
      envSecret,
      configSecret,
    };
  });
}

describe("seeded redaction fuzz", () => {
  it("masks generated credentials even when provider text joins them to words", () => {
    for (const {
      index,
      credentials,
      expectedMaskedStrings,
      message,
      fields,
      envSecret,
      configSecret,
    } of cases()) {
      const output = redactValue({ message, fields }, [
        envSecret,
        configSecret,
      ]);

      assertMasked(
        output,
        credentials,
        expectedMaskedStrings,
        `seed ${String(SEED)}, case ${String(index)}`,
      );
      expect(JSON.stringify(output)).toContain("safe-provider-detail");
    }
  });
  it("keeps generated credentials out of event names and fields on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-waker-redaction-"));

    try {
      const corpus = cases();
      for (const { message, fields, envSecret, configSecret } of corpus) {
        const log = createEventLog({
          directory,
          env: { API_TOKEN: envSecret },
          secrets: [configSecret],
        });
        await log.write({
          timestamp: AT,
          level: "info",
          event: message,
          runtime: "local",
          fields,
        });
      }
      const output = await readFile(
        join(directory, "events-2026-09-07.jsonl"),
        "utf8",
      );
      const lines = output.trim().split("\n");

      expect(lines).toHaveLength(corpus.length);
      for (const { index, credentials, expectedMaskedStrings } of corpus) {
        assertMasked(
          JSON.parse(lines[index] ?? "null") as unknown,
          credentials,
          expectedMaskedStrings,
          `seed ${String(SEED)}, case ${String(index)}`,
        );
        expect(output).toContain("safe-provider-detail");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps generated credentials out of span names and exported attributes", async () => {
    for (const {
      index,
      credentials,
      expectedMaskedStrings,
      message,
      fields,
      envSecret,
      configSecret,
    } of cases()) {
      const sent: string[] = [];
      const telemetry = createTelemetry({
        endpoint: "http://collector.test:4318",
        headers: {},
        serviceName: message,
        timeoutMs: 1000,
        env: { API_TOKEN: envSecret },
        secrets: [configSecret],
        now: () => AT,
        fetch: (_url, init) => {
          if (typeof init.body !== "string") throw new Error("missing body");
          sent.push(init.body);

          return Promise.resolve(new Response("", { status: 200 }));
        },
      });

      const span = telemetry.span(message, fields);
      const event = {
        timestamp: AT,
        level: "info",
        event: message,
        runtime: "local",
        fields,
      } as const;
      span.span(message, fields).end({ attributes: fields, error: message });
      span.log(event);
      span.end({ attributes: fields, error: message });
      telemetry.log(event);
      expect(await telemetry.flush()).toBeUndefined();

      expect(sent).toHaveLength(2);
      for (const body of sent) {
        assertMasked(
          JSON.parse(body) as unknown,
          credentials,
          expectedMaskedStrings,
          `seed ${String(SEED)}, case ${String(index)}`,
        );
        expect(body).toContain("safe-provider-detail");
      }
    }
  });
});
