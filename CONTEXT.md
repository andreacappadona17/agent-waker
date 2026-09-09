# agent waker

Aligns coding-agent subscription usage windows with when you actually start
work, by making one minimal activation per agent as early as you asked for it.

## Agents and providers

**Agent**:
A coding-agent product agent waker schedules and keeps usable (Claude Code,
Codex), identified by an `AgentId`. The unit a user enables and the scheduler
drives.
_Avoid_: assistant, bot, tool

**Provider**:
The external CLI and service backing an agent, which reports whether it is
blocked and when its window resets. Observed, never controlled.
_Avoid_: vendor, backend, service

**Adapter**:
agent waker's per-provider module that inspects a provider and translates what
it says into an Observation. Reports facts, never decisions.
_Avoid_: driver, plugin, connector

## Activation

**Activation**:
The single minimal interaction that establishes an agent's session for the day
and opens its usage window.
_Avoid_: warmup, ping, keep-alive

**Probe**:
A cheap check reporting whether the window is open without consuming it. Not
every provider supports one.
_Avoid_: poll, healthcheck

**Observation**:
A fact an adapter reports from a probe or activation ("blocked, rolling window,
resets at 08:23"), never a decision about what to do next.
_Avoid_: result, verdict, status

## The daily cycle

**Cycle** (daily cycle):
One agent's once-per-local-day activation lifecycle. Opens at the desired
activation time, not midnight; completes on one successful activation.
_Avoid_: run, day

**Tick**:
One short-lived pass of the scheduler: read the clock, load state, evaluate due
agents, write down what to do next. The whole program is one tick.
_Avoid_: poll, iteration, loop

**Phase**:
Where an agent stands in its current cycle (idle, ready, activated, waiting…):
its state-machine position.
_Avoid_: status, mode

**Desired activation time** (`notBefore`):
The earliest local wall-clock time a user wants an agent usable — a floor, not
a promise of an exact time.
_Avoid_: start time, deadline

## Blocks, resets and waiting

**Block**:
A provider refusing to run because of a usage limit, and only that.
Authentication and install problems are deliberately not blocks.
_Avoid_: error, failure

**Reset**:
The instant a provider's usage limit lifts and its window rolls over. Stated by
the provider (known) or not (unknown).
_Avoid_: expiry, refresh

**Window** (usage window):
The provider's own rolling, weekly, or quota usage period, controlled entirely
by the provider.
_Avoid_: quota, period

**Horizon**:
agent-waker's own cutoff for a cycle: when normal-window retries stop and
infrequent long-term handling begins. Internal, not the provider's window.
_Avoid_: window, timeout

**Quota backoff**:
The staged, bounded retry ladder walked only for usage blocks with no stated
reset. Auth and install problems never enter it.
_Avoid_: retry

**Needs attention**:
A phase no amount of waiting will clear (unhealthy, auth_required, failed); the
user has to act.
_Avoid_: error, blocked
