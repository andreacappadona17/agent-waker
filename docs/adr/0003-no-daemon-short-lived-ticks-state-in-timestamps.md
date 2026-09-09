# No daemon: a native scheduler wakes short-lived ticks, and state is timestamps

There is no long-running process. A native OS scheduler (launchd on macOS) wakes
a short-lived tick that reads state, does only what is due, and exits. All
"wait until 08:24" decisions are persisted as absolute timestamps in a state
file, not held in in-memory timers. We chose this because the target machine is
a laptop that sleeps, reboots, and loses network: a timer does not survive any
of those, but a timestamp compared against the clock on the next tick does, so
an overdue check simply runs on wake and nothing is lost. It also means provider
CLIs are invoked only when an agent is actually due, never on every tick.

## Consequences

- The scheduler records which Node interpreter and entry-point ran it; replacing
  that Node (e.g. switching versions under nvm) leaves the schedule dangling,
  which `doctor` reports and `init --repair` rebuilds.
- Every decision within a tick shares one clock reading, so scheduling is
  deterministic within a pass; a separate moving clock is used only to measure
  durations.
