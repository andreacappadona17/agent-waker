# Adapters report facts; the core decides

An adapter reports what a provider said — "blocked, rolling window, resets at
08:23", or "could not classify this response" — and never what to do about it.
All scheduling decisions (whether to wait, how long, whether to back off) live
in the core policy. We chose this because providers change their CLIs and error
formats without notice: keeping decisions in one place means a provider quirk is
a translation change in one adapter, not a policy bug spread across the codebase,
and an adapter that cannot classify a response can say so rather than guess a
reset time that isn't there.

## Consequences

- An adapter returning "retry in ten minutes" is a contract violation; it must
  return a Blocked observation with the constraints it saw and let the core
  choose the delay.
- Guessing is forbidden where it would suppress retries: a low-confidence reset
  may be shown to the user but is ignored when the core picks a reset.
