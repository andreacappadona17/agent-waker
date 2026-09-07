/**
 * OTLP export: traces and logs, over HTTP/JSON, with no SDK.
 *
 * The OpenTelemetry JS SDK exists and is not used here. A tick is a
 * short-lived process (ADR-001) that runs for a second and exits, so the parts
 * of the SDK that earn their weight — batch processors, periodic readers,
 * background flush — are the parts that would have to be defeated. What is
 * left is a JSON body and a POST, which `fetch` already does.
 *
 * The wire format is the thing that has to be right, and it is: any OTLP/HTTP
 * collector accepts this. The transport being fifty lines is not a
 * compatibility statement.
 *
 * Two rules this module exists to keep. Telemetry leaves the machine, so
 * everything on it goes through the same redaction pipeline as the event log —
 * attribute keys, attribute values, span status messages and log bodies alike,
 * with no second path to forget. And a collector that is down, slow or
 * misconfigured must never fail a tick: every failure here is returned, never
 * thrown.
 */

import { randomBytes } from "node:crypto";

import type { Event, LogLevel } from "#src/logging/log.js";
import {
  redactValue,
  secretsFromEnv,
  type JsonValue,
} from "#src/logging/redact.js";

/** OTLP severity numbers, from the logs data model. */
const SEVERITY: Readonly<Record<LogLevel, number>> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
};

/** `SPAN_KIND_INTERNAL`; nothing here is a server or a client of one. */
const SPAN_KIND_INTERNAL = 1;
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;

/** The instrumentation that produced these spans, not the service. */
const SCOPE_NAME = "agent-waker";

// ponytail: traces and logs, no metrics. Every question a counter would answer
// here — activations per day, deferral rate, provider latency — is a query over
// these spans in any OTLP backend. Add a metrics exporter when somebody needs
// pre-aggregation this cannot give them.

// ponytail: configured from config.yaml, not from OTEL_EXPORTER_OTLP_*. A
// launchd agent does not inherit a shell environment, so honouring those
// variables would work when run by hand and silently not under the scheduler,
// which is the failure this codebase is most careful to avoid. Read them only
// if the plist starts passing an environment through.

/** Attribute values, with `undefined` allowed so callers can spread options. */
export type Attributes = Readonly<Record<string, JsonValue | undefined>>;

export interface Span {
  /** A nested span, sharing this one's trace. */
  span(name: string, attributes?: Attributes): Span;
  /** Records an event against this span, so a log line links to its trace. */
  log(event: Event): void;
  end(options?: { attributes?: Attributes; error?: string }): void;
}

export interface Telemetry {
  span(name: string, attributes?: Attributes): Span;
  /** An event with no span of its own. */
  log(event: Event): void;
  /**
   * Sends everything collected so far and empties the buffer.
   *
   * @returns why the export did not happen, or `undefined` when it did. Never
   * throws: a broken collector is not a broken scheduler.
   */
  flush(): Promise<string | undefined>;
}

export interface TelemetryOptions {
  /** Collector base URL; `/v1/traces` and `/v1/logs` are appended. */
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly serviceName: string;
  readonly timeoutMs: number;
  /** Values to treat as secret; defaults to the real environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Further values to mask, on top of the ones the environment names.
   *
   * The export headers go here. Configuration became a place credentials live
   * the moment this module existed, and the redaction pipeline only knew about
   * the environment.
   */
  readonly secrets?: readonly string[];
  /**
   * Wall clock in milliseconds, for span timing.
   *
   * Deliberately not the tick's logical instant: that one is read once and
   * frozen so every scheduling decision shares it, which would make every span
   * zero-length.
   */
  readonly now?: () => number;
  /**
   * Only the call this module makes.
   *
   * Narrower than `fetch` itself, which takes a `Request` and a partial init
   * this never passes. `globalThis.fetch` still assigns to it, and a test can
   * hand over a plain function without a cast.
   */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** OTLP carries 64-bit times as nanosecond strings. */
function nanos(milliseconds: number): string {
  return `${String(Math.trunc(milliseconds))}000000`;
}

/** A JSON value as an OTLP `AnyValue`. */
function anyValue(value: JsonValue | undefined): AnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };

  if (typeof value === "number") {
    // int64 travels as a string in OTLP/JSON; anything else is a double.
    return Number.isSafeInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }

  // `null` has no AnyValue representation, and neither does an `undefined`
  // nested inside an object that the top-level filter never saw. Both become
  // an empty value rather than throwing inside a tick.
  if (value === null || value === undefined) return {};

  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(anyValue) } };
  }

  return {
    kvlistValue: {
      values: Object.entries(value).map(([key, item]) => ({
        key,
        value: anyValue(item),
      })),
    },
  };
}

/** The OTLP wire shapes this module writes. The format is the contract. */
export interface AnyValue {
  readonly stringValue?: string;
  readonly boolValue?: boolean;
  readonly intValue?: string;
  readonly doubleValue?: number;
  readonly arrayValue?: { readonly values: AnyValue[] };
  readonly kvlistValue?: { readonly values: KeyValue[] };
}

export interface KeyValue {
  readonly key: string;
  readonly value: AnyValue;
}

export interface SpanRecord {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: KeyValue[];
  status: { readonly code: number; readonly message?: string };
}

export interface LogRecord {
  readonly timeUnixNano: string;
  readonly severityNumber: number;
  readonly severityText: string;
  readonly body: AnyValue;
  readonly attributes: KeyValue[];
  readonly traceId: string;
  readonly spanId?: string;
}

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const {
    endpoint,
    headers,
    serviceName,
    timeoutMs,
    env = process.env,
    secrets: extraSecrets = [],
    now = Date.now,
    fetch: send = globalThis.fetch,
  } = options;

  const secrets = [...secretsFromEnv(env), ...extraSecrets];
  // One trace per process. A tick is the unit of work, so this is the unit of
  // trace, and a `run` that spans two agents shows both under one root.
  const traceId = randomBytes(16).toString("hex");
  const spans: SpanRecord[] = [];
  const logs: LogRecord[] = [];

  const redact = (text: string): string => redactValue(text, secrets) as string;

  const attributesOf = (given: Attributes = {}): KeyValue[] =>
    Object.entries(given).flatMap(([key, value]) =>
      value === undefined
        ? []
        : [{ key: redact(key), value: anyValue(redactValue(value, secrets)) }],
    );

  const logRecord = (event: Event, spanId?: string): LogRecord => ({
    timeUnixNano: nanos(event.timestamp),
    severityNumber: SEVERITY[event.level],
    severityText: event.level.toUpperCase(),
    body: { stringValue: redact(event.event) },
    attributes: attributesOf({
      ...event.fields,
      ...(event.agent === undefined ? {} : { "agent.id": event.agent }),
      "agent_waker.runtime": event.runtime,
    }),
    traceId,
    ...(spanId === undefined ? {} : { spanId }),
  });

  const open = (
    name: string,
    parentSpanId: string | undefined,
    given: Attributes = {},
  ): Span => {
    const spanId = randomBytes(8).toString("hex");
    const collected: SpanRecord = {
      traceId,
      spanId,
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      name,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: nanos(now()),
      attributes: attributesOf(given),
      status: { code: STATUS_UNSET },
    };

    spans.push(collected);

    return {
      span: (childName, childAttributes) =>
        open(childName, spanId, childAttributes),
      log: (event) => {
        logs.push(logRecord(event, spanId));
      },
      end: ({ attributes, error } = {}) => {
        collected.endTimeUnixNano = nanos(now());
        collected.attributes.push(...attributesOf(attributes));

        if (error !== undefined) {
          collected.status = { code: STATUS_ERROR, message: redact(error) };
        }
      },
    };
  };

  // ponytail: `timeoutMs` bounds how long `flush` waits, not how long the
  // process lives. `AbortSignal.timeout` abandons the request on schedule but
  // does not tear down undici's pending TCP connect, which holds the event loop
  // until its own 10s connectTimeout: measured on Node 24.14.0, a blackholed
  // collector (SYN dropped, not refused) rejects at `timeoutMs` and then exits
  // at ~10.5s whatever this is set to. Only ticks with something to export pay
  // it, and an idle process outliving its work by 10s of a 60s interval blocks
  // nothing — the lock is long released and the failure is already logged.
  // Nor is it the one-line fix this comment used to promise: `connect:
  // { timeout }` needs an undici `Agent`, and Node exports no dispatcher, so
  // the upgrade is a runtime dependency, or an unref'd `net.connect` pre-flight
  // ahead of the POST. Take one if a tick ever has to be dead before the next
  // one starts.
  const post = async (
    path: string,
    body: unknown,
  ): Promise<string | undefined> => {
    const url = `${endpoint.replace(/\/+$/, "")}${path}`;

    try {
      const response = await send(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        // A redirect would re-send the headers, and one of them is usually the
        // collector's credential. `authorization` is stripped across origins;
        // `x-honeycomb-team`, `dd-api-key` and the rest are not.
        redirect: "error",
      });

      // The URL is echoed, the headers are not: one of them may be a token.
      return response.ok
        ? undefined
        : `${url} responded ${String(response.status)}`;
    } catch (error) {
      return `${url}: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  return {
    span: (name, attributes) => open(name, undefined, attributes),
    log: (event) => {
      logs.push(logRecord(event));
    },
    async flush(): Promise<string | undefined> {
      const resource = {
        attributes: attributesOf({ "service.name": serviceName }),
      };
      const scope = { name: SCOPE_NAME };
      // A tick that threw leaves its spans open, and OTLP requires an end
      // time. Closing them here beats dropping the one trace that would have
      // said what went wrong.
      const ended = nanos(now());

      for (const span of spans) span.endTimeUnixNano ??= ended;

      const pending = [...spans];
      const pendingLogs = [...logs];

      // Cleared before the await, so a failed export is dropped rather than
      // resent on top of the next tick's data.
      spans.length = 0;
      logs.length = 0;

      const failures = (
        await Promise.all([
          pending.length === 0
            ? undefined
            : post("/v1/traces", {
                resourceSpans: [
                  { resource, scopeSpans: [{ scope, spans: pending }] },
                ],
              }),
          pendingLogs.length === 0
            ? undefined
            : post("/v1/logs", {
                resourceLogs: [
                  {
                    resource,
                    scopeLogs: [{ scope, logRecords: pendingLogs }],
                  },
                ],
              }),
        ])
      ).filter((failure) => failure !== undefined);

      return failures.length === 0 ? undefined : failures.join("; ");
    },
  };
}

const NOOP_SPAN: Span = {
  span: () => NOOP_SPAN,
  log: () => undefined,
  end: () => undefined,
};

/** What the rest of the program uses when telemetry is off, which is default. */
export const NO_TELEMETRY: Telemetry = {
  span: () => NOOP_SPAN,
  log: () => undefined,
  flush: () => Promise.resolve(undefined),
};
