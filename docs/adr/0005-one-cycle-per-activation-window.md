# One Cycle per configured activation window

An agent has a separate Cycle for each configured activation window on each
local date, with at most one successful activation in each Cycle. We chose
this over one Cycle per agent per day so later configured windows can activate
independently; with a single configured window, the existing once-per-local-day
behavior is preserved. “Activation window” means an agent waker schedule entry
and is distinct from the provider's usage Window.

## Consequences

- Cycle state and phase transitions are scoped to an agent, configured
  activation window, and local date. Each Cycle opens at its configured
  desired activation time.
- A successful activation completes that Cycle and cannot consume a later
  configured window's activation for the same local date.
- The provider's usage Window remains provider-owned and is reported by
  adapters; configured activation windows do not change that concept.
- A window's normalized local time (`HH:MM`) is its identity. Reordering a
  schedule preserves its Cycles; changing a time creates a distinct window.
  Removed windows retain their current Cycle state, so restoring a window on
  the same date cannot repeat its successful activation.
- A delayed tick evaluates every still-due Cycle independently. Opening a later
  window does not suppress an earlier window's retries or success.
- Version 2 state stores one current Cycle per agent and window. Version 1
  state has no window identity and is imported into the earliest effective
  configured window only. Its original floor cannot be recovered if the
  configuration changed before migration; later windows remain independent.
  Undated legacy phases adopt their recorded activation/attempt date, falling
  back to the saved document date.
- A forced run opens today's Cycles before their floors and evaluates each
  unfinished configured window; completed Cycles stay complete.
