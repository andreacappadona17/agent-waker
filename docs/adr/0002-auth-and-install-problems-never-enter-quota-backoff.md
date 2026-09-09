# Authentication and install problems never enter quota backoff

Only usage blocks (rolling window, weekly limit, quota) walk the staged backoff
ladder, which can wait hours for a window to reset. Authentication failures
(`auth_required`) and install/runtime failures (`unhealthy`) are deliberately
not treated as blocks: they get a cheap local recheck (roughly hourly) instead.
We chose this because a usage block costs the user nothing but time — waiting is
the correct action — whereas an expired login or a broken install costs nothing
to fix and everything to wait for. Backing off for five hours on a problem the
user could fix over coffee would defeat the product's entire purpose.

## Consequences

- The observation-to-phase table treats `auth_error`, `runtime_error`, and
  unclassifiable responses as interruptions of the quota ladder that preserve
  the cycle's position without consuming a rung.
- These phases are surfaced as "needs attention" so the user knows to act,
  rather than being silently parked behind a long wait.
