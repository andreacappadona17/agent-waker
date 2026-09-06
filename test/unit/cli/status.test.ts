import { describe, expect, it } from "vitest";

import { renderStatus, type StatusView } from "#src/cli/status.js";

const utc = (iso: string): number => Date.parse(iso);
const at = (localTime: string, day = "07"): number =>
  utc(`2026-09-${day}T${localTime}:00.000Z`) - 2 * 3_600_000;

const plain = { colour: false, unicode: true };

/** Any ANSI sequence, however it was produced. */
// eslint-disable-next-line no-control-regex -- matching escape sequences is the point
const ANSI = /\u001b\[/;

const view = (overrides: Partial<StatusView> = {}): StatusView => ({
  now: at("09:00"),
  timezone: "Europe/Rome",
  notBefore: "07:00",
  runtime: "local",
  platform: "macOS",
  scheduler: { installed: true, loaded: true, stalePath: false },
  agents: [
    {
      agentId: "claude",
      displayName: "Claude Code",
      enabled: true,
      phase: "activated",
      lastActivationAt: at("07:00"),
      lastAttemptAt: at("07:00"),
      nextCycleAt: at("07:00", "08"),
    },
    {
      agentId: "codex",
      displayName: "Codex",
      enabled: true,
      phase: "activated",
      lastActivationAt: at("07:01"),
      lastAttemptAt: at("07:01"),
      nextCycleAt: at("07:00", "08"),
    },
  ],
  ...overrides,
});

describe("renderStatus", () => {
  it("leads with what the user configured", () => {
    const output = renderStatus(view(), plain);

    expect(output).toContain("Runtime: local · macOS");
    expect(output).toContain("Desired activation: 07:00 Europe/Rome");
  });

  it("shows a healthy morning as done", () => {
    const output = renderStatus(view(), plain);

    expect(output).toContain("Claude Code");
    expect(output).toContain("Activated");
    expect(output).toContain("today 07:00");
    expect(output).toContain("tomorrow 07:00");
  });

  it("reports the scheduler", () => {
    expect(renderStatus(view(), plain)).toMatch(/Scheduler.*running/);
  });

  it("says when the scheduler is not installed", () => {
    expect(
      renderStatus(
        view({
          scheduler: { installed: false, loaded: false, stalePath: false },
        }),
        plain,
      ),
    ).toMatch(/Scheduler.*not installed/);
  });

  it("says when the scheduler points at something that has gone", () => {
    // The Node-upgrade case. It looks installed and does nothing.
    expect(
      renderStatus(
        view({ scheduler: { installed: true, loaded: true, stalePath: true } }),
        plain,
      ),
    ).toMatch(/Scheduler.*stale/i);
  });

  describe("a known reset", () => {
    const blocked = view({
      agents: [
        {
          agentId: "codex",
          displayName: "Codex",
          enabled: true,
          phase: "waiting_known_reset",
          reason: "rolling_window",
          lastAttemptAt: at("07:00"),
          blockedUntil: at("08:23"),
          nextAttemptAt: at("08:24"),
          nextCycleAt: at("07:00", "08"),
        },
      ],
    });

    it("says the window is limited rather than that something failed", () => {
      // Deferment is normal. It must not read as an error.
      const output = renderStatus(blocked, plain);

      expect(output).toContain("Usage window limited");
      expect(output).not.toMatch(/error|failed/i);
    });

    it("explains when the window resets and when it will look again", () => {
      const output = renderStatus(blocked, plain);

      expect(output).toContain("resets at today 08:23");
      expect(output).toContain("check again at today 08:24");
    });
  });

  describe("an unknown reset", () => {
    const output = renderStatus(
      view({
        agents: [
          {
            agentId: "codex",
            displayName: "Codex",
            enabled: true,
            phase: "waiting_unknown_reset",
            reason: "rolling_window",
            lastAttemptAt: at("07:15"),
            nextAttemptAt: at("07:30"),
            retryHorizonEndsAt: at("12:00"),
            nextCycleAt: at("07:00", "08"),
          },
        ],
      }),
      plain,
    );

    it("does not claim a reset time it was never given", () => {
      // Never imply an exact time the product cannot guarantee.
      expect(output).toContain("reset unknown");
      expect(output).toContain("did not expose a reset time");
    });

    it("says when it will stop trying the short way", () => {
      expect(output).toContain("today 12:00");
    });
  });

  it("explains a long-term block in terms of what changed", () => {
    const output = renderStatus(
      view({
        agents: [
          {
            agentId: "codex",
            displayName: "Codex",
            enabled: true,
            phase: "long_term_block",
            reason: "quota",
            lastAttemptAt: at("12:00"),
            nextAttemptAt: at("18:00"),
            nextCycleAt: at("07:00", "08"),
          },
        ],
      }),
      plain,
    );

    expect(output).toContain("Long-term limit");
    expect(output).toMatch(/infrequent checks/);
  });

  describe("problems the user has to fix", () => {
    const problem = (
      phase: "unhealthy" | "auth_required",
      reason: string,
    ): string =>
      renderStatus(
        view({
          agents: [
            {
              agentId: "codex",
              displayName: "Codex",
              enabled: true,
              phase,
              reason,
              nextCycleAt: at("07:00", "08"),
            },
          ],
        }),
        plain,
      );

    it("asks for attention rather than naming a time", () => {
      expect(problem("unhealthy", "broken_install")).toContain(
        "needs attention",
      );
    });

    it("points a broken install at doctor", () => {
      const output = problem("unhealthy", "broken_install");

      expect(output).toContain("Installation problem");
      expect(output).toContain("agent-waker doctor codex");
    });

    it("explains an API key without blaming the user", () => {
      const output = problem("auth_required", "api_billing_only");

      expect(output).toContain("API-key authentication");
      expect(output).toMatch(/does not use API-key billing/);
    });

    it("distinguishes simply not being signed in", () => {
      expect(problem("auth_required", "not_authenticated")).toContain(
        "Sign-in required",
      );
    });
  });

  it("shows a disabled agent as off rather than hiding it", () => {
    const output = renderStatus(
      view({
        agents: [
          {
            agentId: "codex",
            displayName: "Codex",
            enabled: false,
            phase: "idle",
            nextCycleAt: at("07:00", "08"),
          },
        ],
      }),
      plain,
    );

    expect(output).toContain("Disabled");
  });

  it("says an agent is waiting for its time rather than idle", () => {
    const output = renderStatus(
      view({
        now: at("06:00"),
        agents: [
          {
            agentId: "codex",
            displayName: "Codex",
            enabled: true,
            phase: "idle",
            nextCycleAt: at("07:00"),
          },
        ],
      }),
      plain,
    );

    expect(output).toContain("Waiting for 07:00");
  });

  describe("terminal capabilities", () => {
    it("uses no escape sequences when colour is off", () => {
      expect(renderStatus(view(), plain)).not.toMatch(ANSI);
    });

    it("colours the state when colour is on", () => {
      expect(renderStatus(view(), { colour: true, unicode: true })).toMatch(
        ANSI,
      );
    });

    it("stays printable ASCII when the terminal cannot do better", () => {
      const output = renderStatus(view(), { colour: false, unicode: false });

      expect(/^[ -~\n]*$/.test(output)).toBe(true);
      expect(output).toContain("OK");
    });
  });
});
