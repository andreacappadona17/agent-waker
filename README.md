# agent waker

Align coding-agent subscription windows with when you work.

[![CI](https://github.com/andreacappadona17/agent-waker/actions/workflows/ci.yml/badge.svg)](https://github.com/andreacappadona17/agent-waker/actions/workflows/ci.yml)
[![CodeQL](https://github.com/andreacappadona17/agent-waker/actions/workflows/codeql.yml/badge.svg)](https://github.com/andreacappadona17/agent-waker/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **macOS and Linux.** Scheduling uses a launchd agent on macOS or a
> `systemd --user` timer on Linux, including WSL with systemd enabled.

## The problem

Coding-agent subscriptions increasingly use rolling usage windows, and when your
window starts depends on when you make your first request. Start work at 09:00
but don't prompt an agent until 10:00, and you have quietly pushed your usable
capacity an hour later than you wanted.

Doing this by hand is worse than it sounds. A blind `"hello"` at 07:00 fails if
your current window does not reset until 08:23. Each agent resets at a different
time. Your laptop is asleep at the retry. And a naive cron script either gives
up on the first rate-limit error or polls the provider all morning.

## What agent waker does

You declare the earliest time you want your agents to be usable. It works out
the rest, independently for each agent:

| Situation                              | What happens                                            |
| -------------------------------------- | ------------------------------------------------------- |
| Agent is available                     | One minimal activation, then done for the day           |
| Blocked, provider reports a reset time | Waits until just after the reset, making **zero** calls |
| Blocked, no reset time reported        | Staged backoff, bounded, then infrequent checks         |
| Weekly limit and rolling limit both    | The later reset wins                                    |
| Laptop asleep at the retry             | Runs the overdue check on wake; nothing is lost         |
| Broken install or expired login        | Reported as such, never mistaken for a usage limit      |

There is no daemon. A native scheduler wakes a short-lived process every five
minutes, which reads state, does only what is due, and exits. Due activations
and retries may run up to five minutes after their scheduled time while the
computer is awake; the next tick catches up overdue work after sleep. Provider
CLIs are invoked only when an agent is actually due, not on every tick.

Linux needs systemd with a running user manager, `systemctl`, and an
absolute `XDG_RUNTIME_DIR` from a logged-in session. Containers and distributions without
systemd cannot install the schedule. WSL must have
[systemd enabled](https://learn.microsoft.com/en-us/windows/wsl/systemd) and a
running Linux instance; the timer cannot start a stopped WSL instance.

The Linux timer catches up once after missed wall-clock wakes; that tick handles
every due Cycle. It cannot wake a suspended computer. Without user lingering,
the schedule runs while the user manager is running, usually from login until
logout. Optional [user lingering](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)
keeps the manager running after logout and starts it at boot; this is a user or
administrator choice and agent waker never enables it automatically.

After upgrading an existing installation, run `agent-waker init --repair` to
replace its one-minute schedule. Legacy `runtime.local.tickInterval: 1m`
configuration remains readable; new and repaired schedules always use five
minutes.

## What it looks like

The command you use day to day is `agent-waker status`:

```text
agent waker
Runtime: local · macOS
Desired activation: 07:00 Europe/Rome

Agent        State                  Last activation  Next action     Reset confidence
────────────────────────────────────────────────────────────────────────────────────────────────────────
Claude Code ✓ Activated             today 07:00      tomorrow 07:00  no recorded reset sources
Codex       ⏳ Usage window limited  today 07:00      today 08:24     100% provider-stated (1/1)

Codex
  Current window resets at 08:23.
  agent waker will check again at 08:24.
```

`status` shows the share of retained blocked observations whose scheduling
used a provider-stated reset; `doctor` also reports the stated-vs-guessed counts.
This is source evidence, not measured prediction accuracy. It uses local logs
without a telemetry collector: the default retention is 14 days, older records
without `reset_source` are excluded, and `logging.level: warn` or `error` omits
these observations. Missing evidence is shown explicitly.

## Supported agents

| Agent             | Local activation | Reset detection      | GitHub Actions  |
| ----------------- | ---------------- | -------------------- | --------------- |
| Claude Code       | yes              | best effort          | planned         |
| Codex             | yes              | best effort          | not supported\* |
| Gemini CLI 0.62.0 | opt-in OAuth     | quota, reset unknown | not supported   |

\* Codex's official GitHub Action is API-key oriented. agent waker will not
silently substitute API-key billing for subscription usage.

Gemini uses a dedicated native login profile and remains disabled on upgrades
until enabled. See [Gemini setup and limitations](docs/gemini-cli/gemini-development.md).

## Commands

| Command                           | Purpose                                     |
| --------------------------------- | ------------------------------------------- |
| `agent-waker init`                | Interactive setup and scheduler install     |
| `agent-waker status`              | What each agent is doing and what is next   |
| `agent-waker run [agent...]`      | Evaluate agents now, rather than waiting    |
| `agent-waker detect`              | Inspect installed agents and native login   |
| `agent-waker doctor [agent...]`   | Diagnose install, auth and runtime problems |
| `agent-waker logs [agent...]`     | Recent events; `--debug` for raw records    |
| `agent-waker schedule set [time]` | Preview and change desired activation times |
| `agent-waker enable <agent...>`   | Include an agent in the daily cycle         |
| `agent-waker disable <agent...>`  | Leave an agent out of it                    |
| `agent-waker uninstall`           | Remove agent waker, leave your agents alone |
| `agent-waker tick`                | One scheduling pass; the scheduler calls it |

`--version` prints the version and `help` prints the above. Exit codes are part
of the contract: `0` success or a tick that deferred, `1` failed, `2` bad
configuration or command line, `3` something needs attention, `4` unsupported
platform.

## Install

```bash
npm install -g @andreacappadona17/agent-waker
agent-waker status
```

The package is scoped; the command is not.

Set it up when you are ready to have it run on its own:

```bash
agent-waker init                   # asks which agents, and from what time
agent-waker init --agents claude --time 07:00 --timezone Europe/Rome
```

Preview setup before installing anything:

```bash
agent-waker init --dry-run --agents claude,codex --time 07:00 --timezone Europe/Rome
agent-waker init --agents claude,codex --time 07:00 --timezone Europe/Rome --agent-times claude=07:00,codex=08:00
```

`init --dry-run` validates and shows the effective schedule and installation
paths without writing configuration, backups, logs, state or scheduler files.
It does not run provider checks or activate agents. Without `--agents`, it uses
existing enabled choices, or the config defaults on first setup; actual setup
checks readiness before offering first-run choices.

Change the schedule with a preview of each agent's effective time:

```bash
agent-waker schedule set                             # guided in a terminal
agent-waker schedule set 06:45 --dry-run              # preview without writing
agent-waker schedule set 08:00 --agent codex          # keep Claude's time
agent-waker schedule set 07:00 --timezone Europe/Rome --yes
agent-waker schedule set 07:00,16:00                  # two daily windows
agent-waker schedule set 08:00,18:00 --agent codex    # replace Codex’s windows
```

In a terminal, `schedule set` asks for a missing time and confirms the resolved
plan before writing. `--yes` skips confirmation; without a terminal, supply the
time and the plan is shown before applying it. Global changes preserve existing
per-agent overrides; use `--agent` to change an individual override. Times are
earliest desired activation times, so a provider limit can delay activation.

Each configured window has a separate Cycle per agent and local date, with at
most one successful activation. A delayed tick catches up every still-due
window; unsuccessful attempts keep that window's retry policy. Reordering
windows preserves completion. Changing a time creates a new window.
`run` evaluates all unfinished configured windows for today, even before their
floors, and leaves completed Cycles alone.

Setup accepts the same comma-separated list with `--time`. For multiple
per-agent setup times, quote the `|`-separated override:

```bash
agent-waker init --time 07:00,16:00 --agent-times 'claude=07:00|16:00,codex=08:00|18:00'
```

Existing single-window configurations continue to work. On the first tick after
an upgrade, existing state is assigned to the earliest effective configured
window; other configured windows have independent Cycles. The old state did
not record its window's time, so an edit made before the upgrade cannot be
reconstructed.

**Check the schedule before removing an nvm version.** `agent-waker doctor`
checks the recorded interpreter and entry point, and warns about version-specific
nvm paths while they still work. `agent-waker init --repair` selects and verifies
a stable Node >=24 installation, keeping its stable alias across upgrades.
It changes only the schedule, preserving your configuration and activation state.

If only nvm Node is installed, repair leaves the schedule untouched and explains
the prerequisite. For example, with Apple Silicon Homebrew:

```bash
brew install node@24
agent-waker init --repair --node-path /opt/homebrew/opt/node@24/bin/node
```

Intel Homebrew uses `/usr/local/opt/node@24/bin/node`; another stable installation
can be supplied with `--node-path`. A symlink back into an nvm version is refused.
If agent waker itself was installed globally under nvm, reinstall it using the
stable Node installation and run repair before removing the old nvm version.
Repair reports a missing entry point and does not reinstall the package for you.

On Linux, use a stable Node >=24 system installation and pass its absolute
path with `--node-path` when needed. Unit files live under
`${XDG_CONFIG_HOME:-~/.config}/systemd/user/`; the launcher and configuration
use the same resolved XDG locations as the CLI. `agent-waker init --repair`
reloads the manager and restarts the timer after updating the files. Early
service failures are available through `journalctl --user -u agent-waker.service`;
normal scheduling history remains in `agent-waker logs`.

`agent-waker uninstall` removes the schedule, the configuration and the state,
and touches none of your agents.

Nothing here needs a provider credential of its own: agent waker uses the
subscription login each agent CLI already has, and never reads or stores it.

### From a clone

For working on it, or for running a version that is not released yet:

```bash
git clone https://github.com/andreacappadona17/agent-waker.git
cd agent-waker
corepack enable            # the pnpm version is pinned in package.json
pnpm install
pnpm build
node dist/cli/bin.js status
```

`pnpm link --global` puts `agent-waker` on your `PATH` from the clone instead
of from npm. The caveat above then covers the clone as well: move it or delete
it and the schedule points at nothing, which `doctor` reports and
`init --repair` fixes.

## Configuration

`~/.config/agent-waker/config.yaml` holds an IANA timezone, the desired
activation time, and which agents are enabled. The configured time is the
earliest you want a window ready, not a promise of an exact time, and the retry
policy has working defaults that do not need configuring.

## Authentication

agent waker reuses the login your agent CLI already has, and never reads,
stores, logs, or transmits your credentials. It activates subscription-backed
usage only. API-key execution is refused by default, because it is billed
separately and generally does not advance the subscription window you are
trying to warm.

## What agent waker will not do

It does not install, update, or repair agent CLIs. It does not bypass provider
limits or operating-system security controls. It does not run arbitrary prompts
on a schedule, poll providers continuously, or send anything to a server
operated by this project — there is no backend, and no telemetry is collected
by anyone but you. See [Observability](#observability) if you want it to report
to a collector you run.

## Observability

Every run writes a structured JSONL event log under
`~/.local/state/agent-waker/logs`, readable with `agent-waker logs`. That is the
whole story unless you ask for more.

If you run an OpenTelemetry collector, agent waker can export **traces and
logs** to it over OTLP/HTTP. Name an endpoint in `config.yaml`:

```yaml
telemetry:
  endpoint: http://localhost:4318
  # Credentials go here, never in the endpoint URL.
  headers:
    x-scope-orgid: team
  serviceName: agent-waker
  timeout: 5s
```

Absence of `telemetry.endpoint` is the off switch, and it is the default:
without it nothing leaves the machine.

Each tick becomes one trace — `agent_waker.tick`, an `agent.activation` span
per agent, and a `provider.exec` span per provider process with its exit code
and duration. Event-log records are exported alongside, linked to the span they
came from.

Three properties worth knowing:

- **A collector never breaks a tick.** Every export failure is swallowed and
  recorded at `debug`; scheduling carries on. `agent-waker doctor` posts a real
  probe span, so you find out that a collector is rejecting your payload before
  you need the traces.
- **Everything is redacted first**, through the same pipeline as the event log,
  extended with your export headers. Provider output is masked and truncated;
  auth files and credentials are never read into a record at all.
- **Ticks that had nothing to say are not exported.** On a five-minute schedule
  that keeps a laptop off the network for the common case. A tick that
  recovered a corrupt state file still reports, even if no agent was due.

`timeout` bounds how long a tick waits for the collector, not how long the
process lives: a collector that drops packets outright — a VPN down, a captive
portal — holds the process for about ten seconds regardless, because that is
the runtime's own connect timeout. It costs that only on ticks that had
something to export, and the native scheduler runs on a five-minute interval, so checks
can happen up to five minutes after they become due. Values above `30s` are
refused for that reason.

One field identifies your machine: `process.executable.path` on a
`provider.exec` span is the resolved provider binary, which usually contains
your home directory. Nothing else host-identifying is sent.

Turn up `logging.level` to `debug` to see no-op ticks and export failures in
the event log.

## Contributing

Contributions are welcome. Note that agent adapters — the most natural
contribution — are **not open yet**: the contract they implement has not been
built. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Andrea Cappadona
