/**
 * What every command needs before it can do anything: where the files are,
 * what the configuration says, and how to reach the outside world.
 *
 * Assembled once and injected, so a command is a pure-ish function of its
 * context and the tests never touch the real home directory.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { createClaudeAdapter } from "#src/adapters/claude.js";
import { createCodexAdapter } from "#src/adapters/codex.js";
import {
  createRegistry,
  type AdapterRegistry,
} from "#src/adapters/registry.js";
import {
  ConfigError,
  parseConfig,
  type AgentWakerConfig,
} from "#src/config/config.js";
import { resolvePaths, type Paths } from "#src/cli/paths.js";
import { AGENT_IDS } from "#src/core/agent.js";
import type { Instant } from "#src/core/time.js";
import { createEventLog, type EventLog } from "#src/logging/log.js";
import {
  createProcessRunner,
  type ProcessRunner,
} from "#src/process/runner.js";
import {
  createLaunchdScheduler,
  LAUNCHER_NAME,
  type SchedulerDriver,
} from "#src/schedulers/launchd.js";
import { createStateStore, type StateStore } from "#src/state/store.js";
import {
  createTelemetry,
  NO_TELEMETRY,
  type Telemetry,
} from "#src/telemetry/otlp.js";

/** Everything the process supplies, gathered so tests can supply it instead. */
export interface CliEnvironment {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly platform: string;
  readonly uid: number;
  readonly isTty: boolean;
  readonly now: () => Instant;
  write(text: string): void;
  writeError(text: string): void;
  /** The interpreter and script to record in the scheduler's launcher. */
  readonly execPath: string;
  readonly entrypoint: string;
  /** What the machine's clock is set to, offered as the default at setup. */
  readonly systemTimezone: string;
  /**
   * Asks the user something, or returns the fallback when nobody is there.
   *
   * Absent whenever input is not a terminal, which is what makes `init` safe
   * to run from a script.
   */
  readonly ask?: (question: string, fallback: string) => Promise<string>;
  /** Overridden in tests; the real adapters otherwise. */
  readonly registry?: AdapterRegistry;
  readonly runner?: ProcessRunner;
}

export interface CommandContext {
  readonly environment: CliEnvironment;
  readonly paths: Paths;
  readonly config: AgentWakerConfig;
  readonly store: StateStore;
  readonly log: EventLog;
  /** OTLP export, or a sink that drops everything when it is not configured. */
  readonly telemetry: Telemetry;
  readonly registry: AdapterRegistry;
  readonly runner: ProcessRunner;
}

/** Raised when there is no configuration to work from yet. */
export class NotInitialisedError extends Error {
  constructor(path: string) {
    super(
      `No configuration at ${path}. Run \`agent-waker init\` to create one.`,
    );
    this.name = "NotInitialisedError";
  }
}

/** The scheduler driver, wired to this machine's resolved paths. */
export function schedulerFor(context: CommandContext): SchedulerDriver {
  return createLaunchdScheduler({
    runner: context.runner,
    home: context.environment.home,
    uid: context.environment.uid,
    launcherPath: join(context.paths.launcherDir, LAUNCHER_NAME),
  });
}

/** The adapters this build ships. */
export function defaultRegistry(): AdapterRegistry {
  return createRegistry([createClaudeAdapter(), createCodexAdapter()]);
}

/**
 * Loads configuration and opens everything that depends on it.
 *
 * @throws {NotInitialisedError} when the file is not there yet.
 * @throws {ConfigError} when it is there and cannot be used.
 */
export async function openContext(
  environment: CliEnvironment,
  options: { allowMissingConfig?: boolean } = {},
): Promise<CommandContext> {
  const paths = resolvePaths(environment.env, environment.home);
  const source = await readFile(paths.config, "utf8").catch(() => undefined);

  if (source === undefined && options.allowMissingConfig !== true) {
    throw new NotInitialisedError(paths.config);
  }

  // `init` and `uninstall` have to work before there is a file, and after one
  // has been removed. They get the defaults, which is what init would write.
  const config =
    source === undefined
      ? parseConfig(
          `version: 1\ntimezone: ${environment.systemTimezone}\n`,
          paths.config,
        )
      : parseConfig(source, paths.config);

  // Providers are spawned with this as their working directory. Spawning into
  // a directory that does not exist fails with ENOENT, which is
  // indistinguishable from a missing executable, so it is created before any
  // adapter runs. One per agent, so neither can see what the other left.
  await mkdir(paths.workDir, { recursive: true });

  for (const agentId of AGENT_IDS) {
    await mkdir(join(paths.workDir, agentId), { recursive: true });
  }

  // Configuration became somewhere credentials live the moment telemetry did.
  // The redaction pipeline only knew about the environment, so the collector's
  // own token is named to it explicitly.
  const telemetrySecrets = Object.values(config.telemetry?.headers ?? {});

  return {
    environment,
    paths,
    config,
    store: createStateStore(paths.stateDir),
    log: createEventLog({
      directory: paths.logDir,
      timezone: config.timezone,
      level: config.logging.level,
      env: environment.env,
      secrets: telemetrySecrets,
    }),
    telemetry:
      config.telemetry === undefined
        ? NO_TELEMETRY
        : createTelemetry({
            ...config.telemetry,
            env: environment.env,
            secrets: telemetrySecrets,
          }),
    registry: environment.registry ?? defaultRegistry(),
    runner: environment.runner ?? createProcessRunner({ env: environment.env }),
  };
}

/** Whether an error is one the user can fix in their configuration. */
export function isConfigurationProblem(error: unknown): boolean {
  return error instanceof ConfigError || error instanceof NotInitialisedError;
}
