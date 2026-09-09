# The scheduler seam is a driver, not an adapter

The platform backend that installs, refreshes, and removes the wake schedule —
launchd today, `systemd --user` next — sits behind an interface named
`SchedulerDriver`, even though the glossary's Adapter entry lists "driver" among
the words to avoid. That avoid-list guards one specific concept: the per-provider
Adapter that translates what a provider CLI says into an Observation (ADR 0001).
A scheduler backend does the opposite kind of work — it drives the OS to wake us
and reports nothing a policy decides on — so reusing "adapter" for it would blur
the single distinction the glossary exists to protect. "Driver" is the idiomatic
word for a platform backend, the launchd code already spoke of a "scheduler
driver" before the seam was extracted, and naming the two seams differently
(`AgentAdapter` versus `SchedulerDriver`) signals at a glance that they are
different kinds of thing.

## Consequences

- "Adapter" stays reserved for the provider seam; "driver" names the
  platform-scheduler seam. A new platform ships a `SchedulerDriver` (for example
  `SystemdUserDriver`), never a "scheduler adapter".
- The glossary's "Avoid: driver" on Adapter is scoped to the provider concept,
  not a blanket ban; this ADR is the exception it does not enumerate.
