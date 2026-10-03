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
