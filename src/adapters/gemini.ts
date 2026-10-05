/** Gemini CLI v0.62.0 native OAuth validation. Credentials remain provider-owned. */
import type { AuthResult } from "#src/adapters/contract.js";
import type { ProcessResult } from "#src/process/runner.js";
const TURN_LIMIT_MESSAGE =
  "Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.";
function object(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
export function parseAuthStatus(result: ProcessResult): AuthResult {
  if (
    result.timedOut ||
    result.signal !== null ||
    result.startFailure !== undefined ||
    result.truncated.stdout ||
    result.truncated.stderr
  )
    return { authenticated: false, mode: "unknown", supportsIntent: false };
  if (result.exitCode === 41)
    return { authenticated: false, mode: "none", supportsIntent: false };
  const payload = result.stderr.startsWith("[ERROR] ")
    ? object(result.stderr.slice(8))
    : undefined;
  const error = payload?.error;
  if (
    result.exitCode === 53 &&
    error !== null &&
    typeof error === "object" &&
    !Array.isArray(error)
  ) {
    const record = error as Record<string, unknown>;
    if (
      record.type === "FatalTurnLimitedError" &&
      record.message === TURN_LIMIT_MESSAGE &&
      record.code === 53
    )
      return {
        authenticated: true,
        mode: "subscription_local",
        supportsIntent: true,
      };
  }
  return { authenticated: false, mode: "unknown", supportsIntent: false };
}

import type { AgentObservation } from "#src/core/observation.js";
import { processFailure } from "#src/adapters/detection.js";
export function parseActivation(result: ProcessResult): AgentObservation {
  const failure = processFailure(result);
  if (failure !== undefined) return failure;
  if (
    result.signal !== null ||
    result.truncated.stdout ||
    result.truncated.stderr
  )
    return {
      kind: "unknown",
      detail: "Gemini CLI returned an unclassified terminal result.",
    };
  const document = object(result.stdout);
  if (result.exitCode === 0)
    return typeof document?.response === "string" &&
      document.error === undefined
      ? { kind: "activated" }
      : {
          kind: "unknown",
          detail: "Gemini CLI returned no native terminal success response.",
        };
  if (result.exitCode === 41)
    return {
      kind: "auth_error",
      state: "expired",
      message: "Gemini OAuth authentication failed.",
    };
  const terminal =
    object(result.stdout) ?? object(result.stderr.replace(/^\[ERROR\] /, ""));
  const error = terminal?.error;
  const message =
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "";
  const evidence = message || result.stderr;
  const relativeReset = /Your quota will reset after ([\dhms.]+)\./.exec(
    evidence,
  )?.[1];
  if (
    result.exitCode !== null &&
    /(?:reason:\s*['"]QUOTA_EXHAUSTED['"]|Your quota will reset after \d)/.test(
      evidence,
    )
  )
    return {
      kind: "blocked",
      reason: "quota",
      constraints: [{ type: "quota", confidence: "high" }],
      detail:
        relativeReset === undefined
          ? "Gemini CLI reported exhausted usage quota; the absolute reset is unknown."
          : `Gemini CLI reported exhausted usage quota; reset after ${relativeReset}. The absolute reset is unknown.`,
    };
  return {
    kind: "unknown",
    detail: "Gemini CLI returned an unclassified terminal result.",
  };
}

import {
  mkdir,
  writeFile,
  lstat,
  readdir,
  mkdtemp,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import type {
  AgentAdapter,
  AdapterContext,
  DetectionResult,
} from "#src/adapters/contract.js";
import { createStateStore, LockedError } from "#src/state/store.js";
import { missingFlags, toDetection } from "#src/adapters/detection.js";
import { discoverExecutable } from "#src/process/discovery.js";
import { TIMEOUTS } from "#src/process/runner.js";

const ARGS = [
  "--prompt",
  "Respond with OK only.",
  "--output-format",
  "json",
  "--ignore-env",
  "-e",
  "none",
  "--allowed-mcp-server-names",
] as const;
const SUPPORTED_VERSION = "0.62.0";

/** Exclusive temporary directory and rename: no credential reads or linked writes. */
async function controlFile(path: string, contents: string): Promise<void> {
  const scratch = await mkdtemp(join(dirname(path), ".controls-"));
  try {
    const temporary = join(scratch, "settings");
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
/** Native storage migrates hash identifiers to registry slugs under this root.
 * Scan metadata for every identifier rather than opening the private registry.
 * A memory directory is customization, even if empty; history stays untouched.
 */
async function privateMemoryAbsent(native: string): Promise<boolean> {
  try {
    const temporary = join(native, "tmp");
    const info = await lstat(temporary).catch((error: unknown) => {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return undefined;
      throw error;
    });
    if (info === undefined) return true;
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    for (const project of await readdir(temporary, { withFileTypes: true })) {
      if (project.isSymbolicLink()) return false;
      if (!project.isDirectory()) continue;
      const memory = await lstat(join(temporary, project.name, "memory")).catch(
        (error: unknown) => {
          if (
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return undefined;
          throw error;
        },
      );
      if (memory !== undefined) return false;
    }
    return true;
  } catch {
    // Inaccessible metadata is not evidence that private context is absent.
    return false;
  }
}
async function environment(
  context: AdapterContext,
  turns: number,
): Promise<Record<string, string> | undefined> {
  const home = context.providerHome;
  if (
    home === undefined ||
    resolve(context.workDir) !== join(resolve(home), "work")
  )
    return undefined;
  // A provider-managed profile may contain auth files. Never open any of them.
  // Only app-owned controls are written; customization is rejected before startup.
  for (const directory of [home, context.workDir, join(home, ".gemini")]) {
    const info = await lstat(directory).catch(() => undefined);
    if (info?.isSymbolicLink()) return undefined;
  }
  await mkdir(context.workDir, { recursive: true, mode: 0o700 });
  if ((await readdir(context.workDir)).length !== 0) return undefined;
  const native = join(home, ".gemini");
  if (!(await privateMemoryAbsent(native))) return undefined;
  for (const name of [
    ".env",
    "extensions",
    "agents",
    "commands",
    "GEMINI.md",
    "policies",
    "skills",
    "hooks",
  ]) {
    if (await lstat(join(native, name)).catch(() => undefined))
      return undefined;
  }
  const nativeSettings = join(native, "settings.json");
  if ((await lstat(nativeSettings).catch(() => undefined))?.isSymbolicLink())
    return undefined;
  // This is a dedicated profile: replace customization without reading a
  // settings document that could itself contain MCP headers or env secrets.
  await mkdir(native, { recursive: true, mode: 0o700 });
  const settings = {
    model: { maxSessionTurns: turns },
    context: { memoryBoundaryMarkers: [] },
    security: {
      auth: {
        selectedType: "oauth-personal",
        enforcedType: "oauth-personal",
        useExternal: false,
      },
    },
    billing: { overageStrategy: "never" },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false, logPrompts: false },
    tools: { core: [], discoveryCommand: "", callCommand: "", sandbox: false },
    skills: { enabled: false },
    hooksConfig: { enabled: false },
    mcp: { serverCommand: "" },
    mcpServers: {},
    general: { checkpointing: { enabled: false } },
    ide: { enabled: false },
    experimental: {
      enableAgents: false,
      adk: { agentSessionNoninteractiveEnabled: false },
    },
    advanced: {
      ignoreLocalEnv: true,
      excludedEnvVars: [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_ACCESS_TOKEN",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_CLOUD_QUOTA_PROJECT",
        "CLOUD_SHELL",
        "GEMINI_CLI_EXP_AGENT",
      ],
    },
  };
  // Native system scopes require root ownership. Explicit absent paths keep
  // host defaults/overrides out; all effective controls live in the user scope.
  const settingsPath = join(home, "absent-system-settings.json");
  const defaultsPath = join(home, "absent-system-defaults.json");
  for (const path of [settingsPath, defaultsPath]) {
    if (await lstat(path).catch(() => undefined)) return undefined;
  }
  if (
    (await lstat(join(home, ".env")).catch(() => undefined))?.isSymbolicLink()
  )
    return undefined;
  await controlFile(nativeSettings, JSON.stringify(settings));
  await controlFile(join(home, ".env"), "");
  return {
    HOME: home,
    GEMINI_CLI_HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath,
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: defaultsPath,
    GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: "false",
    GEMINI_CLI_EXP_AGENT: "false",
    NO_BROWSER: "true",
  };
}
/** User settings must remain fixed until native startup has consumed them.
 * Reuse the existing cross-process lock; overlapping readiness checks decline.
 */
async function invoke(
  context: AdapterContext,
  detection: DetectionResult,
  turns: number,
  args: readonly string[],
  timeoutMs: number,
): Promise<ProcessResult | undefined> {
  const home = context.providerHome;
  if (
    home === undefined ||
    resolve(context.workDir) !== join(resolve(home), "work")
  )
    return undefined;
  const controls = join(home, ".agent-waker-controls");
  const lock = join(controls, "lock");
  for (const path of [home, controls, lock]) {
    const info = await lstat(path).catch(() => undefined);
    if (
      info?.isSymbolicLink() ||
      (path === lock &&
        info !== undefined &&
        (!info.isFile() || info.nlink !== 1))
    )
      return undefined;
  }
  try {
    return await createStateStore(controls).withLock(async () => {
      const env = await environment(context, turns);
      if (env === undefined) return undefined;
      return context.runner.run({
        executable: detection.executable ?? "gemini",
        args,
        cwd: context.workDir,
        env,
        stdin: "closed",
        timeoutMs,
      });
    });
  } catch (error: unknown) {
    if (error instanceof LockedError) return undefined;
    throw error;
  }
}
export function createGeminiAdapter(): AgentAdapter {
  return {
    id: "gemini",
    displayName: "Gemini CLI",
    capabilities: {
      probeMode: "activation_is_probe",
      exactReset: false,
      weeklyLimitDetection: false,
    },
    async detect(context) {
      const found = await discoverExecutable("gemini", {
        runner: context.runner,
        fallbackDirectories: [
          join(homedir(), ".local", "bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
        ],
      });
      const detected = toDetection(found);
      // Discovery's generic semver extraction drops prerelease suffixes. Guard
      // the full native line so preview builds cannot masquerade as supported.
      return detected.health === "ok" &&
        found.version?.trim() !== SUPPORTED_VERSION
        ? { ...detected, health: "unknown" }
        : detected;
    },
    async inspectAuth(context, detection) {
      if (detection.version !== SUPPORTED_VERSION || detection.health !== "ok")
        return {
          authenticated: false,
          mode: "unknown",
          supportsIntent: false,
          message: "Gemini CLI 0.62.0 is required.",
        };
      const result = await invoke(
        context,
        detection,
        0,
        [...ARGS, `agent-waker-no-mcp-${randomUUID()}`],
        TIMEOUTS.probe,
      );
      return result === undefined
        ? {
            authenticated: false,
            mode: "unknown",
            supportsIntent: false,
            message:
              "Gemini profile is unavailable, busy or customized. See Gemini setup instructions.",
          }
        : parseAuthStatus(result);
    },
    async smokeTest(context, detection) {
      const result = await invoke(
        context,
        detection,
        0,
        ["--help"],
        TIMEOUTS.detect,
      );
      if (result === undefined) return missingFlags("", ARGS);
      return missingFlags(
        result.exitCode === 0 ? result.stdout + result.stderr : "",
        ARGS,
      );
    },
    async activate(context, detection, auth) {
      if (
        detection.version !== SUPPORTED_VERSION ||
        detection.health !== "ok" ||
        !auth.authenticated ||
        !auth.supportsIntent ||
        auth.mode !== "subscription_local"
      )
        return {
          kind: "auth_error",
          state: "unsupported_auth",
          message: "Gemini requires supported native OAuth authentication.",
        };
      const result = await invoke(
        context,
        detection,
        1,
        [...ARGS, `agent-waker-no-mcp-${randomUUID()}`],
        TIMEOUTS.activate,
      );
      return result === undefined
        ? { kind: "runtime_error", category: "unknown" }
        : parseActivation(result);
    },
  };
}
