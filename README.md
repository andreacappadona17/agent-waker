# agent waker

Align coding-agent subscription windows with when you work.

[![CI](https://github.com/andreacappadona17/agent-waker/actions/workflows/ci.yml/badge.svg)](https://github.com/andreacappadona17/agent-waker/actions/workflows/ci.yml)
[![CodeQL](https://github.com/andreacappadona17/agent-waker/actions/workflows/codeql.yml/badge.svg)](https://github.com/andreacappadona17/agent-waker/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Not on npm yet.** The command works — it is macOS-only for now — but there
> is no published package, so install it [from a clone](#run-it-from-a-clone).

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

There is no daemon. A native scheduler wakes a short-lived process, which reads
state, does only what is due, and exits. Provider CLIs are invoked only when an
agent is actually due, not on every tick.

## What it looks like

The command you use day to day is `agent-waker status`:

```text
agent waker
Runtime: local · macOS
Desired activation: 07:00 Europe/Rome

Agent        State                  Last activation       Next action
────────────────────────────────────────────────────────────────────────
Claude Code ✓ Activated             today 07:00           tomorrow 07:00
Codex       ⏳ Usage window limited  07:00                 08:24

Codex
  Current window resets at 08:23.
  agent waker will check again at 08:24.
```

## Supported agents

| Agent       | Local activation | Reset detection | GitHub Actions  |
| ----------- | ---------------- | --------------- | --------------- |
| Claude Code | yes              | best effort     | planned         |
| Codex       | yes              | best effort     | not supported\* |

\* Codex's official GitHub Action is API-key oriented. agent waker will not
silently substitute API-key billing for subscription usage.

## Commands

| Command                           | Purpose                                     |
| --------------------------------- | ------------------------------------------- |
| `agent-waker init`                | Interactive setup and scheduler install     |
| `agent-waker status`              | What each agent is doing and what is next   |
| `agent-waker run [agent...]`      | Evaluate agents now, rather than waiting    |
| `agent-waker detect`              | Discover installed agents, change nothing   |
| `agent-waker doctor [agent...]`   | Diagnose install, auth and runtime problems |
| `agent-waker logs [agent...]`     | Recent events; `--debug` for raw records    |
| `agent-waker schedule set <time>` | Change the desired activation time          |
| `agent-waker enable <agent...>`   | Include an agent in the daily cycle         |
| `agent-waker disable <agent...>`  | Leave an agent out of it                    |
| `agent-waker uninstall`           | Remove agent waker, leave your agents alone |
| `agent-waker tick`                | One scheduling pass; the scheduler calls it |

`--version` prints the version and `help` prints the above. Exit codes are part
of the contract: `0` success or a tick that deferred, `1` failed, `2` bad
configuration or command line, `3` something needs attention, `4` unsupported
platform.

## Run it from a clone

macOS only for now: scheduling needs a launchd agent, and any other platform is
refused with exit `4` rather than half-configured.

```bash
git clone https://github.com/andreacappadona17/agent-waker.git
cd agent-waker
corepack enable            # the pnpm version is pinned in package.json
pnpm install
pnpm build
```

Then either run it in place:

```bash
node dist/cli/bin.js status
```

or put `agent-waker` on your `PATH`:

```bash
pnpm link --global
agent-waker status
```

Set it up when you are ready to have it run on its own:

```bash
agent-waker init                   # asks which agents, and from what time
agent-waker init --agents claude --time 07:00 --timezone Europe/Rome
```

**The scheduler remembers where you ran it from.** `init` records the
interpreter and the entry-point path in the LaunchAgent, so a clone that later
moves, gets deleted, or is rebuilt under a different Node version leaves a
schedule pointing at a file that is no longer there. `agent-waker doctor` says
so, and `agent-waker init --repair` rebuilds it from wherever the code lives
now. `agent-waker uninstall` removes the schedule, the configuration and the
state, and touches none of your agents.

Nothing here needs a provider credential of its own: agent waker uses the
subscription login each agent CLI already has, and never reads or stores it.

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
- **Ticks that had nothing to say are not exported.** On a one-minute schedule
  that keeps a laptop off the network for the common case. A tick that
  recovered a corrupt state file still reports, even if no agent was due.

`timeout` bounds how long a tick waits for the collector, not how long the
process lives: a collector that drops packets outright — a VPN down, a captive
portal — holds the process for about ten seconds regardless, because that is
the runtime's own connect timeout. It costs that only on ticks that had
something to export, and `launchd` runs on a sixty-second interval, so no tick
is lost. Values above `30s` are refused for that reason.

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
