/**
 * Reads and validates `config.yaml`.
 *
 * Parsing is separated from reading the file so the whole schema can be tested
 * without a filesystem, and so a caller that already has the text — `doctor`
 * checking a candidate edit, for instance — can validate it in place.
 *
 * Every rejection carries a file, line and column, because a scheduler with a
 * typo in its configuration is silent until the morning it matters.
 */

import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Document,
  type Node,
} from "yaml";

import { AGENT_IDS, isAgentId, type AgentId } from "#src/core/agent.js";
import { LEVELS, type LogLevel } from "#src/logging/log.js";
import { describeValue } from "#src/core/describe.js";
import { parseDuration } from "#src/config/duration.js";
import {
  parseLocalTime,
  parseTimeZone,
  type LocalTime,
} from "#src/core/time.js";

/** The staged backoff used when a provider reports no reset time. */
export const DEFAULT_UNKNOWN_RESET_DELAYS_MS: readonly number[] = [
  300_000, 600_000, 900_000, 1_800_000, 3_600_000,
];

/**
 * Network and provider-outage retries, deliberately shorter and separate.
 *
 * The trailing hour is how the ladder degrades to an hourly health check: the
 * last delay repeats, so no second mechanism is needed for it.
 */
export const DEFAULT_TRANSIENT_DELAYS_MS: readonly number[] = [
  60_000, 300_000, 900_000, 3_600_000,
];

const DEFAULT_NOT_BEFORE: LocalTime = { hour: 7, minute: 0 };
const DEFAULT_RESET_GRACE_MS = 60_000;
const DEFAULT_NORMAL_WINDOW_HORIZON_MS = 18_000_000;
const DEFAULT_LONG_TERM_INTERVAL_MS = 21_600_000;
const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_TELEMETRY_TIMEOUT_MS = 5_000;
const MAX_TELEMETRY_TIMEOUT_MS = 30_000;
const DEFAULT_LOG_LEVEL: LogLevel = "info";
const DEFAULT_SERVICE_NAME = "agent-waker";

/** Per-agent settings; everything not set here falls back to the global value. */
export interface AgentConfig {
  readonly enabled: boolean;
  readonly schedule?: { readonly notBefore: LocalTime };
}

/** A validated `config.yaml`, with every duration already in milliseconds. */
export interface AgentWakerConfig {
  readonly version: 1;
  readonly timezone: string;
  readonly schedule: { readonly notBefore: LocalTime };
  readonly activation: { readonly resetGraceMs: number };
  readonly retry: {
    readonly unknownReset: {
      readonly delaysMs: readonly number[];
      readonly normalWindowHorizonMs: number;
    };
    readonly longTerm: { readonly intervalMs: number };
    readonly transient: { readonly delaysMs: readonly number[] };
  };
  readonly runtime: { readonly local: { readonly tickIntervalMs: number } };
  readonly logging: { readonly level: LogLevel };
  /**
   * OTLP export, absent unless an endpoint is configured.
   *
   * Absence is the off switch. A separate `enabled` key would let a machine
   * name a collector it never talks to, which is a state worth nobody
   * debugging.
   */
  readonly telemetry?: TelemetryConfig;
  readonly agents: Readonly<Record<AgentId, AgentConfig>>;
}

/** Where traces and logs go, when they go anywhere. */
export interface TelemetryConfig {
  /** Collector base URL; `/v1/traces` and `/v1/logs` are appended. */
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly serviceName: string;
  readonly timeoutMs: number;
}

/** One agent's settings after global values and overrides are merged. */
export interface EffectiveAgentConfig {
  readonly agentId: AgentId;
  readonly enabled: boolean;
  readonly timezone: string;
  readonly notBefore: LocalTime;
  readonly resetGraceMs: number;
  readonly unknownResetDelaysMs: readonly number[];
  readonly normalWindowHorizonMs: number;
  readonly longTermRetryMs: number;
  readonly transientDelaysMs: readonly number[];
}

/** Raised when configuration cannot be used, pointing at the offending line. */
export class ConfigError extends Error {
  /** The file the value came from, as given to `parseConfig`. */
  readonly file: string;
  /** Dotted key path, such as `agents.claude.schedule.notBefore`. */
  readonly path: string | undefined;
  /** One-based, matching what an editor shows. */
  readonly line: number | undefined;
  readonly column: number | undefined;

  constructor(options: {
    file: string;
    path?: string | undefined;
    line?: number | undefined;
    column?: number | undefined;
    detail: string;
  }) {
    const at =
      options.line === undefined
        ? ""
        : `:${String(options.line)}:${String(options.column)}`;
    const key = options.path === undefined ? "" : `${options.path}: `;

    super(`${options.file}${at}: ${key}${options.detail}`);
    this.name = "ConfigError";
    this.file = options.file;
    this.path = options.path;
    this.line = options.line;
    this.column = options.column;
  }
}

type Path = readonly (string | number)[];

interface Source {
  readonly doc: Document;
  readonly lines: LineCounter;
  readonly file: string;
  /** Every key path a reader looked at, used to reject the rest. */
  readonly known: Set<string>;
}

/** Renders a path the way a user would write it: `retry.delays[1]`. */
function pathText(path: Path): string {
  return path.reduce<string>((text, part) => {
    if (typeof part === "number") return `${text}[${String(part)}]`;
    return text === "" ? part : `${text}.${part}`;
  }, "");
}

function positionOf(
  src: Source,
  node: unknown,
): { line?: number; column?: number } {
  const range = (node as Node | null)?.range;

  if (range === undefined || range === null) return {};

  const { line, col } = src.lines.linePos(range[0]);
  return { line, column: col };
}

function fail(
  src: Source,
  path: Path,
  detail: string,
  node: unknown = src.doc.getIn(path, true),
): never {
  throw new ConfigError({
    file: src.file,
    path: pathText(path),
    detail,
    ...positionOf(src, node),
  });
}

/** Parses the value at a path, reporting a rejection against that position. */
function parseAt<T>(src: Source, path: Path, parse: (raw: unknown) => T): T {
  try {
    return parse(src.doc.getIn(path));
  } catch (error) {
    fail(src, path, error instanceof Error ? error.message : String(error));
  }
}

/** Reads a key, or `undefined` when it is absent or has no value. */
function optional<T>(
  src: Source,
  path: Path,
  parse: (raw: unknown) => T,
): T | undefined {
  src.known.add(path.join("."));

  const node = src.doc.getIn(path, true);

  return node === undefined || node === null
    ? undefined
    : parseAt(src, path, parse);
}

function required<T>(src: Source, path: Path, parse: (raw: unknown) => T): T {
  const value = optional(src, path, parse);

  if (value === undefined) {
    throw new ConfigError({
      file: src.file,
      path: pathText(path),
      detail: "Missing required key.",
    });
  }

  return value;
}

function parseVersion(raw: unknown): 1 {
  if (raw !== 1) {
    throw new Error(
      `Unsupported config version ${describeValue(raw)}; this build understands version 1.`,
    );
  }

  return 1;
}

function parseBoolean(raw: unknown): boolean {
  if (typeof raw !== "boolean") {
    throw new Error(
      `Expected true or false, but received ${describeValue(raw)}.`,
    );
  }

  return raw;
}

/**
 * A collector URL.
 *
 * Restricted to HTTP and HTTPS because this is the one place the program
 * sends anything off the machine, and `file:` would make it a copier of
 * arbitrary state into arbitrary paths.
 *
 * A credential may not be part of it, in either of the two forms a hosted
 * collector documents. `https://id:token@host` is refused by `fetch` itself,
 * so accepting it here would mean a configuration that validates and then
 * never exports anything; `?api-key=` survives into every diagnostic that
 * prints the endpoint. Both belong in `headers`, where this program already
 * knows not to print them.
 */
function parseEndpoint(raw: unknown): string {
  // Deliberately never echoes the value it rejected. Every other reader in
  // this file quotes what it received, which is the more helpful message — but
  // a mistyped endpoint is usually a pasted one, and the paste that gets
  // mistyped is the credentialed form a hosted collector hands out. The file,
  // line and column point at it; stderr does not need a copy.
  if (typeof raw !== "string") {
    throw new Error("Expected a URL.");
  }

  // Tested against the text rather than the parsed URL: `new URL` reports an
  // empty `search` for a bare `?`, which still breaks the path this is joined
  // to.
  if (raw.includes("?") || raw.includes("#")) {
    throw new Error(
      "The endpoint is a base URL; `/v1/traces` and `/v1/logs` are added to it. Move a query string or fragment into telemetry.headers.",
    );
  }

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error("Expected a URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Expected an http:// or https:// URL.");
  }

  if (url.username !== "" || url.password !== "") {
    throw new Error(
      "A user name or password in the endpoint cannot be sent, and would be printed by `agent-waker doctor`. Put the credential in telemetry.headers instead.",
    );
  }

  return raw;
}

function parseLogLevel(raw: unknown): LogLevel {
  const level = LEVELS.find((candidate) => candidate === raw);

  if (level === undefined) {
    throw new Error(
      `Expected one of ${LEVELS.join(", ")}, but received ${describeValue(raw)}.`,
    );
  }

  return level;
}

function parseServiceName(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`Expected a name, but received ${describeValue(raw)}.`);
  }

  return raw;
}

/** Export headers, which is where a collector's credential lives. */
function parseHeaders(raw: unknown): Record<string, string> {
  // A nested mapping arrives as a YAML node rather than a plain object; every
  // other reader in this file takes a scalar and never meets one.
  const mapping: unknown = isMap(raw) ? (raw.toJSON() as unknown) : raw;

  if (
    typeof mapping !== "object" ||
    mapping === null ||
    Array.isArray(mapping)
  ) {
    throw new Error(
      `Expected a mapping of header names to values, but received ${describeValue(raw)}.`,
    );
  }

  return Object.fromEntries(
    Object.entries(mapping).map(([name, value]) => {
      if (typeof value !== "string") {
        throw new Error(
          `Expected header ${name} to be text, but received ${describeValue(value)}.`,
        );
      }

      return [name, value];
    }),
  );
}

/**
 * The export timeout, bounded above.
 *
 * A tick is a short-lived process and launchd will not start another while one
 * is still running, so a long timeout against an unreachable collector does
 * not just slow a tick down — it swallows the ticks that should have happened
 * meanwhile. This is the one way telemetry could degrade scheduling.
 */
function parseTelemetryTimeout(raw: unknown): number {
  const milliseconds = parsePositiveDuration(raw);

  if (milliseconds > MAX_TELEMETRY_TIMEOUT_MS) {
    throw new Error(
      `Expected at most 30s, but received ${describeValue(raw)}. A tick must finish before the next one is due.`,
    );
  }

  return milliseconds;
}

/** A duration that would otherwise let a retry loop spin. */
function parsePositiveDuration(raw: unknown): number {
  const milliseconds = parseDuration(raw);

  if (milliseconds <= 0) {
    throw new Error(
      `Expected a duration greater than zero, but received ${describeValue(raw)}.`,
    );
  }

  return milliseconds;
}

/** Reads a retry ladder, pointing at the offending entry rather than the list. */
function optionalDurationList(
  src: Source,
  path: Path,
): readonly number[] | undefined {
  src.known.add(path.join("."));

  const node = src.doc.getIn(path, true);

  if (node === undefined || node === null) return undefined;
  if (!isSeq(node)) fail(src, path, "Expected a list of durations.");
  if (node.items.length === 0) fail(src, path, "Expected at least one delay.");

  // An entry is never absent the way a map key can be: YAML gives an empty
  // list item a null scalar, which the duration parser rejects by itself.
  return node.items.map((_, index) =>
    parseAt(src, [...path, index], parsePositiveDuration),
  );
}

/** Rejects keys no reader asked for, so a typo is loud rather than ignored. */
function rejectUnknownKeys(src: Source): void {
  // Every proper prefix of every known path, so "is this key an interior node
  // on the way to something a reader asked for?" is one lookup rather than a
  // scan of the whole schema per key.
  const interior = new Set<string>();

  for (const path of src.known) {
    const parts = path.split(".");

    for (let index = 1; index < parts.length; index += 1) {
      interior.add(parts.slice(0, index).join("."));
    }
  }
  const walk = (node: unknown, prefix: readonly string[]): void => {
    if (!isMap(node)) return;

    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
      const path = key === undefined ? [...prefix, "?"] : [...prefix, key];
      const dotted = path.join(".");

      if (src.known.has(dotted)) continue;

      if (!interior.has(dotted)) {
        throw new ConfigError({
          file: src.file,
          path: pathText(path),
          detail: "Unknown key.",
          ...positionOf(src, pair.key),
        });
      }

      walk(pair.value, path);
    }
  };

  walk(src.doc.contents, []);
}

/** Checks the agent section names agents this build supports. */
function rejectUnknownAgents(src: Source): void {
  const node = src.doc.getIn(["agents"], true);

  if (node === undefined || node === null) return;
  if (!isMap(node)) fail(src, ["agents"], "Expected a mapping of agent names.");

  for (const pair of node.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : undefined;

    if (isAgentId(key)) continue;

    throw new ConfigError({
      file: src.file,
      path: pathText(["agents", key ?? "?"]),
      detail: `Unknown agent ${describeValue(key)}. This build supports ${AGENT_IDS.join(", ")}.`,
      ...positionOf(src, pair.key),
    });
  }
}

function readAgents(src: Source): Record<AgentId, AgentConfig> {
  const agents = {} as Record<AgentId, AgentConfig>;

  for (const agentId of AGENT_IDS) {
    // Absent means enabled: a user who never opens the file gets both agents.
    const enabled =
      optional(src, ["agents", agentId, "enabled"], parseBoolean) ?? true;
    const notBefore = optional(
      src,
      ["agents", agentId, "schedule", "notBefore"],
      parseLocalTime,
    );

    agents[agentId] =
      notBefore === undefined
        ? { enabled }
        : { enabled, schedule: { notBefore } };
  }

  return agents;
}

/** Turns a YAML parse failure into the same shape as a validation failure. */
function rejectSyntaxErrors(doc: Document, file: string): void {
  const [error] = doc.errors;

  if (error === undefined) return;

  // "Map keys must be unique" undersells the consequence, which is that the
  // value the user can see in their file is not the one that will be used.
  const detail =
    error.code === "DUPLICATE_KEY"
      ? "Duplicate key. The last value silently wins, which is rarely what you meant."
      : error.message
          .split("\n")[0]
          ?.replace(/ at line \d+, column \d+:?$/, ".");

  throw new ConfigError({
    file,
    detail: detail ?? error.message,
    line: error.linePos?.[0].line,
    column: error.linePos?.[0].col,
  });
}

/**
 * Validates `config.yaml` text.
 *
 * @param file the path to name in errors; this function reads nothing.
 * @throws {ConfigError} for a syntax error, an unknown key, or a value that
 * cannot be used.
 */
export function parseConfig(source: string, file: string): AgentWakerConfig {
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines });

  rejectSyntaxErrors(doc, file);

  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new ConfigError({
      file,
      detail: "Expected the file to be a mapping of settings.",
      ...positionOf({ doc, lines, file, known: new Set() }, doc.contents),
    });
  }

  const src: Source = { doc, lines, file, known: new Set() };
  // Read before anything else, and in this order. `version` decides whether
  // any other key means what this build thinks it means, so a v9 file must be
  // told that rather than told its collector URL is malformed.
  const version = required(src, ["version"], parseVersion);
  const timezone = required(src, ["timezone"], parseTimeZone);
  const telemetry = readTelemetry(src);

  const config: AgentWakerConfig = {
    version,
    timezone,
    schedule: {
      notBefore:
        optional(src, ["schedule", "notBefore"], parseLocalTime) ??
        DEFAULT_NOT_BEFORE,
    },
    activation: {
      // Zero is legitimate: it means trust the provider's reset time exactly.
      resetGraceMs:
        optional(src, ["activation", "resetGrace"], parseDuration) ??
        DEFAULT_RESET_GRACE_MS,
    },
    retry: {
      unknownReset: {
        delaysMs:
          optionalDurationList(src, ["retry", "unknownReset", "delays"]) ??
          DEFAULT_UNKNOWN_RESET_DELAYS_MS,
        normalWindowHorizonMs:
          optional(
            src,
            ["retry", "unknownReset", "normalWindowHorizon"],
            parsePositiveDuration,
          ) ?? DEFAULT_NORMAL_WINDOW_HORIZON_MS,
      },
      longTerm: {
        intervalMs:
          optional(
            src,
            ["retry", "longTerm", "interval"],
            parsePositiveDuration,
          ) ?? DEFAULT_LONG_TERM_INTERVAL_MS,
      },
      transient: {
        delaysMs:
          optionalDurationList(src, ["retry", "transient", "delays"]) ??
          DEFAULT_TRANSIENT_DELAYS_MS,
      },
    },
    runtime: {
      local: {
        tickIntervalMs:
          optional(
            src,
            ["runtime", "local", "tickInterval"],
            parsePositiveDuration,
          ) ?? DEFAULT_TICK_INTERVAL_MS,
      },
    },
    logging: {
      level:
        optional(src, ["logging", "level"], parseLogLevel) ?? DEFAULT_LOG_LEVEL,
    },
    ...(telemetry === undefined ? {} : { telemetry }),
    agents: (rejectUnknownAgents(src), readAgents(src)),
  };

  // v0.1 has no defined behaviour past the end of the ladder, so the key is
  // read and refused rather than accepted and ignored.
  const repeatPath = ["retry", "unknownReset", "repeatLastDelay"];

  if (optional(src, repeatPath, parseBoolean) === false) {
    fail(
      src,
      repeatPath,
      "repeatLastDelay: false is not supported yet; the last delay always repeats.",
    );
  }

  rejectUnknownKeys(src);

  return config;
}

/** Reads the telemetry block, which is absent until an endpoint is named. */
function readTelemetry(src: Source): TelemetryConfig | undefined {
  const block = src.doc.getIn(["telemetry"], true);

  // `telemetry: http://localhost:4318` on one line is the likeliest way to
  // write this wrong, and every reader below would look for keys inside it and
  // find none. Silence is this feature's whole failure mode.
  if (block !== undefined && block !== null && !isMap(block)) {
    fail(src, ["telemetry"], "Expected a mapping, with an endpoint inside it.");
  }

  const endpoint = optional(src, ["telemetry", "endpoint"], parseEndpoint);
  // Read whether or not there is an endpoint, so each key is registered and a
  // typo inside the block is still an unknown key rather than silence. No
  // defaults yet: an explicitly empty value still means the block was written.
  const headers = optional(src, ["telemetry", "headers"], parseHeaders);
  const serviceName = optional(
    src,
    ["telemetry", "serviceName"],
    parseServiceName,
  );
  const timeout = optional(
    src,
    ["telemetry", "timeout"],
    parseTelemetryTimeout,
  );

  if (endpoint === undefined) {
    if ([headers, serviceName, timeout].some((value) => value !== undefined)) {
      fail(
        src,
        ["telemetry"],
        "Nothing is exported without telemetry.endpoint. Add it, or remove this block.",
      );
    }

    return undefined;
  }

  return {
    endpoint,
    headers: headers ?? {},
    serviceName: serviceName ?? DEFAULT_SERVICE_NAME,
    timeoutMs: timeout ?? DEFAULT_TELEMETRY_TIMEOUT_MS,
  };
}

/** Merges the global settings with one agent's overrides. */
export function effectiveAgentConfig(
  config: AgentWakerConfig,
  agentId: AgentId,
): EffectiveAgentConfig {
  const agent = config.agents[agentId];

  return {
    agentId,
    enabled: agent.enabled,
    timezone: config.timezone,
    notBefore: agent.schedule?.notBefore ?? config.schedule.notBefore,
    resetGraceMs: config.activation.resetGraceMs,
    unknownResetDelaysMs: config.retry.unknownReset.delaysMs,
    normalWindowHorizonMs: config.retry.unknownReset.normalWindowHorizonMs,
    longTermRetryMs: config.retry.longTerm.intervalMs,
    transientDelaysMs: config.retry.transient.delaysMs,
  };
}
