import { describe, expect, it } from "vitest";

import type { Event } from "#src/logging/log.js";
import {
  createTelemetry,
  NO_TELEMETRY,
  type KeyValue,
  type LogRecord,
  type SpanRecord,
  type Telemetry,
  type TelemetryOptions,
} from "#src/telemetry/otlp.js";

const AT = Date.parse("2026-09-07T05:00:02.000Z");

interface TracePayload {
  readonly resourceSpans: [
    {
      resource: { attributes: KeyValue[] };
      scopeSpans: [{ spans: SpanRecord[] }];
    },
  ];
}

interface LogPayload {
  readonly resourceLogs: [
    {
      resource: { attributes: KeyValue[] };
      scopeLogs: [{ logRecords: LogRecord[] }];
    },
  ];
}

type Fetch = NonNullable<TelemetryOptions["fetch"]>;

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A collector that records what it was sent, and can refuse. */
function collector(
  respond: () => Response = () => new Response("", { status: 200 }),
): { sent: Sent[]; fetch: Fetch } {
  const sent: Sent[] = [];
  const fake: Fetch = (url, init) => {
    sent.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(
        typeof init.body === "string" ? init.body : "null",
      ) as unknown,
    });

    return Promise.resolve(respond());
  };

  return { sent, fetch: fake };
}

function body(sent: Sent | undefined): unknown {
  if (sent === undefined) throw new Error("nothing was sent");

  return sent.body;
}

const spansOf = (sent: Sent | undefined): SpanRecord[] =>
  (body(sent) as TracePayload).resourceSpans[0].scopeSpans[0].spans;

const recordsOf = (sent: Sent | undefined): LogRecord[] =>
  (body(sent) as LogPayload).resourceLogs[0].scopeLogs[0].logRecords;

const resourceOf = (sent: Sent | undefined): KeyValue[] =>
  (body(sent) as TracePayload).resourceSpans[0].resource.attributes;

/** A clock that advances a millisecond per read, so spans have a duration. */
function ticking(from = 1_000): () => number {
  let value = from;

  return () => (value += 1);
}

function telemetry(
  fetch: Fetch,
  options: Partial<TelemetryOptions> = {},
): Telemetry {
  return createTelemetry({
    endpoint: "http://collector.test:4318",
    headers: {},
    serviceName: "agent-waker",
    timeoutMs: 5_000,
    env: {},
    now: ticking(),
    fetch,
    ...options,
  });
}

const event = (overrides: Partial<Event> = {}): Event => ({
  timestamp: AT,
  level: "info",
  event: "agent.activated",
  runtime: "local",
  fields: {},
  ...overrides,
});

/** OTLP attribute lists, back as something worth asserting against. */
const attributes = (list: KeyValue[]): Record<string, unknown> =>
  Object.fromEntries(
    list.map(({ key, value }) => [key, Object.values(value)[0]]),
  );

describe("createTelemetry", () => {
  it("posts spans to the OTLP traces endpoint", async () => {
    const { sent, fetch } = collector();
    const otel = telemetry(fetch);

    otel.span("agent_waker.tick", { "agent_waker.runtime": "local" }).end();

    expect(await otel.flush()).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("http://collector.test:4318/v1/traces");

    const [span] = spansOf(sent[0]);

    expect(span?.name).toBe("agent_waker.tick");
    expect(span?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span?.parentSpanId).toBeUndefined();
    expect(Number(span?.endTimeUnixNano)).toBeGreaterThan(
      Number(span?.startTimeUnixNano),
    );
    expect(attributes(span?.attributes ?? [])).toEqual({
      "agent_waker.runtime": "local",
    });
  });

  it("names the service on the resource", async () => {
    const { sent, fetch } = collector();
    const otel = telemetry(fetch, { serviceName: "waker-1" });

    otel.span("agent_waker.tick").end();
    await otel.flush();

    expect(attributes(resourceOf(sent[0]))).toEqual({
      "service.name": "waker-1",
    });
  });

  it("closes a span the caller never ended, which OTLP requires", async () => {
    const { sent, fetch } = collector();
    const otel = telemetry(fetch);

    // What a tick that threw part-way leaves behind. Dropping the trace would
    // lose exactly the one that says what went wrong.
    otel.span("agent_waker.tick");
    await otel.flush();

    expect(spansOf(sent[0])[0]?.endTimeUnixNano).toBeDefined();
  });

  it("nests child spans under their parent in the same trace", async () => {
    const { sent, fetch } = collector();
    const otel = telemetry(fetch);
    const root = otel.span("agent_waker.tick");
    const child = root.span("agent.activation", { "agent.id": "codex" });

    child.span("provider.exec").end();
    child.end();
    root.end();
    await otel.flush();

    const spans = spansOf(sent[0]);
    const byName = new Map(spans.map((span) => [span.name, span]));

    expect(spans).toHaveLength(3);
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
    expect(byName.get("agent.activation")?.parentSpanId).toBe(
      byName.get("agent_waker.tick")?.spanId,
    );
    expect(byName.get("provider.exec")?.parentSpanId).toBe(
      byName.get("agent.activation")?.spanId,
    );
  });

  it("posts events to the OTLP logs endpoint, linked to their span", async () => {
    const { sent, fetch } = collector();
    const otel = telemetry(fetch);
    const span = otel.span("agent.activation");

    span.log(event({ agent: "claude", fields: { durationMs: 1800 } }));
    span.end();
    await otel.flush();

    const traces = sent.find((request) => request.url.endsWith("/v1/traces"));
    const logs = sent.find((request) => request.url.endsWith("/v1/logs"));
    const [record] = recordsOf(logs);

    expect(record?.body).toEqual({ stringValue: "agent.activated" });
    expect(record?.severityNumber).toBe(9);
    expect(record?.severityText).toBe("INFO");
    expect(record?.timeUnixNano).toBe(`${String(AT)}000000`);
    expect(record?.spanId).toBe(spansOf(traces)[0]?.spanId);
    expect(attributes(record?.attributes ?? [])).toEqual({
      durationMs: "1800",
      "agent.id": "claude",
      "agent_waker.runtime": "local",
    });
  });

  it("maps every level onto an OTLP severity", async () => {
    const { sent, fetch } = collector();
    const otel = telemetry(fetch);

    for (const level of ["debug", "info", "warn", "error"] as const) {
      otel.log(event({ level }));
    }

    await otel.flush();

    expect(recordsOf(sent[0]).map((record) => record.severityNumber)).toEqual([
      5, 9, 13, 17,
    ]);
  });

  it("marks a failed span, and carries the reason", async () => {
    const { sent, fetch } = collector();
    const otel = telemetry(fetch);

    otel.span("agent.activation").end({ error: "broken_install" });
    await otel.flush();

    expect(spansOf(sent[0])[0]?.status).toEqual({
      code: 2,
      message: "broken_install",
    });
  });

  it("redacts secrets before anything leaves the machine", async () => {
    const { sent, fetch } = collector();
    const otel = telemetry(fetch, { env: { SOME_API_KEY: "canary-secret-1" } });

    otel
      .span("agent.activation", { note: "env value canary-secret-1" })
      .end({ error: "failed with canary-secret-1" });
    otel.log(
      event({ fields: { detail: "Bearer abcdefghijklmnopqrstuvwxyz012345" } }),
    );

    await otel.flush();

    const body = JSON.stringify(sent);

    expect(body).not.toContain("canary-secret-1");
    expect(body).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(body).toContain("[redacted]");
  });

  it("masks a secret it was handed, not only ones from the environment", async () => {
    const { sent, fetch } = collector();
    const otel = telemetry(fetch, {
      headers: { "x-honeycomb-team": "header-canary-token" },
      secrets: ["header-canary-token"],
    });

    otel.span("agent.activation", { note: "sent header-canary-token" }).end();
    await otel.flush();

    expect(JSON.stringify(sent[0]?.body)).not.toContain("header-canary-token");
  });

  it("refuses to follow a redirect, which would re-send the headers", async () => {
    const seen: (string | undefined)[] = [];
    const otel = telemetry((_url, init) => {
      seen.push(init.redirect);

      return Promise.resolve(new Response("", { status: 200 }));
    });

    otel.span("agent_waker.tick").end();
    await otel.flush();

    expect(seen).toEqual(["error"]);
  });

  it("survives an undefined nested inside a field", async () => {
    const { sent, fetch } = collector();
    const otel = telemetry(fetch);

    // Not reachable from a typed caller today. It is the one place a telemetry
    // defect could throw inside a tick, so it returns an empty value instead.
    otel.log(
      event({
        fields: { nested: { missing: undefined } } as unknown as Record<
          string,
          never
        >,
      }),
    );

    await expect(otel.flush()).resolves.toBeUndefined();
    expect(attributes(recordsOf(sent[0])[0]?.attributes ?? [])).toMatchObject({
      nested: { values: [{ key: "missing", value: {} }] },
    });
  });

  it("sends nothing when nothing was recorded", async () => {
    const { sent, fetch } = collector();

    expect(await telemetry(fetch).flush()).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("reports a refusal rather than throwing", async () => {
    const { fetch } = collector(
      () => new Response("nope", { status: 401, statusText: "Unauthorized" }),
    );
    const otel = telemetry(fetch);

    otel.span("agent_waker.tick").end();

    await expect(otel.flush()).resolves.toContain("responded 401");
  });

  it("reports an unreachable collector rather than throwing", async () => {
    const otel = telemetry(() => Promise.reject(new Error("ECONNREFUSED")));

    otel.span("agent_waker.tick").end();

    await expect(otel.flush()).resolves.toContain("ECONNREFUSED");
  });

  it("never echoes the export headers, which may hold a credential", async () => {
    const { fetch } = collector(() => new Response("", { status: 403 }));
    const otel = telemetry(fetch, {
      headers: { authorization: "Bearer collector-canary-token" },
    });

    otel.span("agent_waker.tick").end();

    expect(await otel.flush()).not.toContain("collector-canary-token");
  });

  it("sends the configured headers", async () => {
    const { sent, fetch } = collector();
    const otel = telemetry(fetch, { headers: { "x-scope-orgid": "team" } });

    otel.span("agent_waker.tick").end();
    await otel.flush();

    expect(sent[0]?.headers).toMatchObject({
      "content-type": "application/json",
      "x-scope-orgid": "team",
    });
  });

  it("does not resend what a failed export already tried", async () => {
    let status = 500;
    const { sent, fetch } = collector(() => new Response("", { status }));
    const otel = telemetry(fetch);

    otel.span("first").end();
    expect(await otel.flush()).toBeDefined();

    status = 200;
    otel.span("second").end();
    await otel.flush();

    expect(spansOf(sent[1]).map((span) => span.name)).toEqual(["second"]);
  });

  it("keeps a trailing slash on the endpoint out of the path", async () => {
    const { sent, fetch } = collector();
    const otel = telemetry(fetch, { endpoint: "http://collector.test:4318/" });

    otel.span("agent_waker.tick").end();
    await otel.flush();

    expect(sent[0]?.url).toBe("http://collector.test:4318/v1/traces");
  });

  it("carries a nested field through as an OTLP kvlist", async () => {
    const { sent, fetch } = collector();
    const otel = telemetry(fetch);

    otel.log(
      event({
        fields: { limits: { weekly: true }, tried: [1, 2], ratio: 0.5 },
      }),
    );
    await otel.flush();

    expect(attributes(recordsOf(sent[0])[0]?.attributes ?? [])).toEqual({
      limits: { values: [{ key: "weekly", value: { boolValue: true } }] },
      tried: { values: [{ intValue: "1" }, { intValue: "2" }] },
      ratio: 0.5,
      "agent_waker.runtime": "local",
    });
  });
});

describe("NO_TELEMETRY", () => {
  it("swallows everything and reports no failure", async () => {
    const span = NO_TELEMETRY.span("agent_waker.tick", { a: 1 });

    span.span("child").log(event());
    span.end({ error: "ignored" });
    NO_TELEMETRY.log(event());

    await expect(NO_TELEMETRY.flush()).resolves.toBeUndefined();
  });
});
