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
import { createStateStore, type StateStore } from "#src/state/store.js";

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
): Promise<CommandContext> {
  const paths = resolvePaths(environment.env, environment.home);

  let source: string;

  try {
    source = await readFile(paths.config, "utf8");
  } catch {
    throw new NotInitialisedError(paths.config);
  }

  const config = parseConfig(source, paths.config);

  // Providers are spawned with this as their working directory. Spawning into
  // a directory that does not exist fails with ENOENT, which is
  // indistinguishable from a missing executable, so it is created before any
  // adapter runs. One per agent, so neither can see what the other left.
  await mkdir(paths.workDir, { recursive: true });

  for (const agentId of AGENT_IDS) {
    await mkdir(join(paths.workDir, agentId), { recursive: true });
  }

  return {
    environment,
    paths,
    config,
    store: createStateStore(paths.stateDir),
    log: createEventLog({
      directory: paths.logDir,
      timezone: config.timezone,
      env: environment.env,
    }),
    registry: environment.registry ?? defaultRegistry(),
    runner: environment.runner ?? createProcessRunner({ env: environment.env }),
  };
}

/** Whether an error is one the user can fix in their configuration. */
export function isConfigurationProblem(error: unknown): boolean {
  return error instanceof ConfigError || error instanceof NotInitialisedError;
}
