/**
 * The command router.
 *
 * Argument parsing is hand-rolled rather than delegated. The surface is a
 * dozen flags across a dozen commands, a parser library is a dependency and a
 * migration, and the one behaviour that matters here — that `--` and unknown
 * flags are refused rather than quietly ignored — is easier to guarantee than
 * to configure.
 */

import { EXIT, type ExitCode } from "#src/cli/exit.js";
import {
  isConfigurationProblem,
  openContext,
  type CliEnvironment,
} from "#src/cli/context.js";
import { statusCommand } from "#src/cli/status.js";
import { tickCommand } from "#src/cli/tick.js";
import { AGENT_IDS, isAgentId, type AgentId } from "#src/core/agent.js";

const USAGE = `agent waker — align coding-agent subscription windows with when you work.

Usage:
  agent-waker <command> [options]

Commands:
  status            What each agent is doing, and what happens next
  tick              Run one scheduling pass; this is what the scheduler calls
  run [agent]       Evaluate now rather than waiting for the schedule
  help              Show this message

Options:
  -h, --help        Show this message
  -v, --version     Show the version

Exit codes:
  0  success, or a tick that completed
  1  the command failed
  2  the configuration or the command line is wrong
  3  something needs attention
  4  unsupported on this platform
`;

export interface ParsedCommand {
  readonly command: string;
  readonly agents: readonly AgentId[];
  readonly flags: ReadonlySet<string>;
}

/** Splits the command line, refusing anything not recognised. */
export function parseArguments(argv: readonly string[]): ParsedCommand {
  const [first] = argv;
  // A leading flag means there is no command: `agent-waker --version` asks a
  // question rather than naming something to do.
  const named = first !== undefined && !first.startsWith("-");
  const command = named ? first : "help";
  const rest = named ? argv.slice(1) : argv;
  const agents: AgentId[] = [];
  const flags = new Set<string>();

  for (const argument of rest) {
    if (argument.startsWith("-")) {
      flags.add(argument);
      continue;
    }

    if (!isAgentId(argument)) {
      throw new Error(
        `Unknown agent "${argument}". This build supports ${AGENT_IDS.join(", ")}.`,
      );
    }

    agents.push(argument);
  }

  return { command, agents, flags };
}

/**
 * Runs one command.
 *
 * Returns an exit code rather than exiting, so the whole router is testable
 * and nothing calls `process.exit` in the middle of a write.
 */
export async function run(environment: CliEnvironment): Promise<ExitCode> {
  let parsed: ParsedCommand;

  try {
    parsed = parseArguments(environment.argv);
  } catch (error) {
    environment.writeError(`${(error as Error).message}\n`);
    return EXIT.usage;
  }

  // Version before help, so `--version` on its own answers the question asked
  // rather than the one the default command would have answered.
  if (parsed.flags.has("-v") || parsed.flags.has("--version")) {
    environment.write(`${VERSION}\n`);
    return EXIT.ok;
  }

  if (
    parsed.command === "help" ||
    parsed.flags.has("-h") ||
    parsed.flags.has("--help")
  ) {
    environment.write(USAGE);
    return EXIT.ok;
  }

  if (!COMMANDS.has(parsed.command)) {
    environment.writeError(
      `Unknown command "${parsed.command}". Run \`agent-waker help\`.\n`,
    );
    return EXIT.usage;
  }

  try {
    const context = await openContext(environment);

    switch (parsed.command) {
      case "status":
        return await statusCommand(context);
      case "tick":
        return await tickCommand(context);
      case "run":
        // Evaluate now, but still respect what the provider says.
        return await tickCommand(context, {
          force: true,
          ...(parsed.agents.length > 0 ? { only: parsed.agents } : {}),
        });
      default:
        return EXIT.usage;
    }
  } catch (error) {
    environment.writeError(`${(error as Error).message}\n`);

    return isConfigurationProblem(error) ? EXIT.usage : EXIT.failed;
  }
}

const COMMANDS = new Set(["status", "tick", "run"]);

// Kept here rather than read from package.json: the built CLI runs from dist,
// where the manifest is not necessarily beside it.
const VERSION = "0.1.0";
