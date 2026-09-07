/**
 * The command router.
 *
 * Argument parsing is hand-rolled rather than delegated. The surface is a
 * handful of options across a dozen commands, a parser library is a dependency
 * and a migration, and the behaviour that matters most here — that an unknown
 * command, option or agent is refused rather than quietly ignored — is easier
 * to guarantee than to configure.
 */

import {
  isConfigurationProblem,
  openContext,
  type CliEnvironment,
} from "#src/cli/context.js";
import { detectCommand } from "#src/cli/detect.js";
import { initCommand, repairCommand } from "#src/cli/init.js";
import { uninstallCommand } from "#src/cli/uninstall.js";
import { doctorCommand } from "#src/cli/doctor.js";
import { EXIT, type ExitCode } from "#src/cli/exit.js";
import { platformName } from "#src/cli/format.js";
import { logsCommand } from "#src/cli/logs.js";
import { runCommand } from "#src/cli/run.js";
import { scheduleSetCommand, setEnabledCommand } from "#src/cli/schedule.js";
import { statusCommand } from "#src/cli/status.js";
import { tickCommand } from "#src/cli/tick.js";
import { AGENT_IDS, isAgentId, type AgentId } from "#src/core/agent.js";

const USAGE = `agent waker — align coding-agent subscription windows with when you work.

Usage:
  agent-waker <command> [options]

Commands:
  status                  What each agent is doing, and what happens next
  doctor [agent...]       Check everything, and say what to do about it
  detect                  What is installed, and whether it can be used
  tick                    Run one scheduling pass; the scheduler calls this
  run [agent...]          Evaluate now rather than waiting for the schedule
  logs [agent...]         Recent events
  schedule set <time>     Change the desired activation time
  enable <agent...>       Include an agent in the daily cycle
  disable <agent...>      Leave an agent out of it
  init                    Set up the configuration and the scheduler
  uninstall               Remove what agent waker installed
  help                    Show this message

Options:
  --timezone <zone>       With schedule set, change the zone as well
  --limit <n>             With logs, how many events to show
  --time <hh:mm>          With init, the desired activation time
  --repair                With init, rebuild the scheduler only
  --logs                  With uninstall, remove the logs too
  --debug                 With logs, the raw records rather than a summary
  -y, --yes               Do not ask for confirmation
  -h, --help              Show this message
  -v, --version           Show the version

Exit codes:
  0  success, or a tick that completed
  1  the command failed
  2  the configuration or the command line is wrong
  3  something needs attention
  4  unsupported on this platform
`;

/**
 * Why there is nothing to do here.
 *
 * ponytail: one supported platform, so one message. It becomes a lookup
 * against the available scheduler drivers when systemd lands.
 */
const unsupportedPlatform = (platform: string): string =>
  `agent waker runs on macOS, and this is ${platformName(platform)}.
Scheduling needs a launchd agent, which only macOS has. Linux support is
planned and not in this build.
`;

/** Commands whose positional arguments name agents. */
const AGENT_COMMANDS = new Set(["run", "enable", "disable", "doctor", "logs"]);

/** Options that consume the argument after them. */
const VALUE_OPTIONS = new Set(["--timezone", "--limit", "--time"]);

/** Flags that are options rather than mistakes. */
const KNOWN_FLAGS = new Set(["--repair", "--logs", "--debug", "-y", "--yes"]);

const COMMANDS = new Set([
  "status",
  "doctor",
  "init",
  "uninstall",
  "detect",
  "tick",
  "run",
  "logs",
  "schedule",
  "enable",
  "disable",
]);

// Kept here rather than read from package.json: the built CLI runs from dist,
// where the manifest is not necessarily beside it.
const VERSION = "0.1.0";

export interface ParsedCommand {
  readonly command: string;
  /** Everything after the command that was not an option. */
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

/** Splits the command line. Commands validate their own positionals. */
export function parseArguments(argv: readonly string[]): ParsedCommand {
  const [first] = argv;
  // A leading flag means there is no command: `agent-waker --version` asks a
  // question rather than naming something to do.
  const named = first !== undefined && !first.startsWith("-");
  const command = named ? first : "help";
  const rest = named ? argv.slice(1) : argv;

  const positionals: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] ?? "";

    if (!argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }

    const [name = argument, inline] = argument.includes("=")
      ? argument.split("=", 2)
      : [argument, undefined];

    if (!VALUE_OPTIONS.has(name)) {
      flags.add(argument);
      continue;
    }

    const value = inline ?? rest[++index];

    if (value === undefined) {
      throw new Error(`${name} needs a value.`);
    }

    options.set(name, value);
  }

  return { command, positionals, options, flags };
}

/** Present-or-absent, so an unset option is left out rather than undefined. */
function toOption<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/** Narrows positionals to agents, naming anything that is not one. */
function asAgents(positionals: readonly string[]): AgentId[] {
  return positionals.map((value) => {
    if (!isAgentId(value)) {
      throw new Error(
        `Unknown agent "${value}". This build supports ${AGENT_IDS.join(", ")}.`,
      );
    }

    return value;
  });
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

  // Before anything reads a file. `help` and `--version` are answered above,
  // because a user asking what this is deserves an answer wherever they are.
  if (environment.platform !== "darwin") {
    environment.writeError(unsupportedPlatform(environment.platform));

    return EXIT.unsupported;
  }

  if (!COMMANDS.has(parsed.command)) {
    environment.writeError(
      `Unknown command "${parsed.command}". Run \`agent-waker help\`.\n`,
    );

    return EXIT.usage;
  }

  const [unknownFlag] = [...parsed.flags].filter(
    (flag) => !KNOWN_FLAGS.has(flag),
  );

  if (unknownFlag !== undefined) {
    environment.writeError(
      `Unknown option "${unknownFlag}". Run \`agent-waker help\`.\n`,
    );

    return EXIT.usage;
  }

  let agents: AgentId[];

  try {
    // Before the configuration is touched: naming an agent that does not exist
    // is a more specific answer than "you have not run init".
    agents = AGENT_COMMANDS.has(parsed.command)
      ? asAgents(parsed.positionals)
      : [];
  } catch (error) {
    environment.writeError(`${(error as Error).message}\n`);

    return EXIT.usage;
  }

  // These two are what a machine runs before it has a configuration, and
  // after it no longer wants one.
  const allowMissingConfig =
    parsed.command === "init" || parsed.command === "uninstall";

  try {
    const context = await openContext(environment, { allowMissingConfig });

    switch (parsed.command) {
      case "status":
        return await statusCommand(context);
      case "detect":
        return await detectCommand(context);
      case "doctor":
        return await doctorCommand(context, agents);
      case "init":
        return parsed.flags.has("--repair")
          ? await repairCommand(context)
          : await initCommand(context, {
              ...toOption("time", parsed.options.get("--time")),
              ...toOption("timezone", parsed.options.get("--timezone")),
            });
      case "uninstall":
        return await uninstallCommand(context, {
          includeLogs: parsed.flags.has("--logs"),
          assumeYes: parsed.flags.has("-y") || parsed.flags.has("--yes"),
        });
      case "tick":
        return await tickCommand(context);
      case "run":
        // Evaluate now, but still respect what the provider says.
        return await runCommand(context, agents);
      case "logs": {
        const limit = Number(parsed.options.get("--limit") ?? 40);

        if (!Number.isInteger(limit) || limit <= 0) {
          environment.writeError("--limit needs a whole number above zero.\n");

          return EXIT.usage;
        }

        return await logsCommand(context, {
          limit,
          agents,
          verbose: parsed.flags.has("--debug"),
        });
      }
      case "schedule": {
        const [subcommand, time] = parsed.positionals;

        if (subcommand !== "set") {
          environment.writeError(
            "The only schedule command is `agent-waker schedule set <time>`.\n",
          );

          return EXIT.usage;
        }

        return await scheduleSetCommand(
          context,
          time,
          parsed.options.get("--timezone"),
        );
      }
      case "enable":
      case "disable":
        return await setEnabledCommand(
          context,
          agents,
          parsed.command === "enable",
        );
      default:
        return EXIT.usage;
    }
  } catch (error) {
    environment.writeError(`${(error as Error).message}\n`);

    return isConfigurationProblem(error) ? EXIT.usage : EXIT.failed;
  }
}
