/**
 * The exit-code contract.
 *
 * Documented because scripts depend on it, and because the distinction that
 * matters most is invisible otherwise: an agent that is legitimately waiting
 * for its usage window to reset is not a failure. Deferment is state. A tick
 * that defers every agent has done its job and says so with zero.
 */
export const EXIT = {
  /** Success, healthy, or a tick that completed — including one that deferred. */
  ok: 0,
  /** The command tried and could not finish. */
  failed: 1,
  /** The configuration or the command line is wrong. */
  usage: 2,
  /** Some agents were handled and at least one could not be. */
  partial: 3,
  /** Asked for something this build or this platform cannot do. */
  unsupported: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
