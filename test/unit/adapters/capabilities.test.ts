import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRegistry } from "#src/adapters/registry.js";
import { parseConfig } from "#src/config/config.js";
import type { AgentObservation } from "#src/core/observation.js";
import { tick } from "#src/core/orchestrator.js";
import { createStateStore } from "#src/state/store.js";
import { NO_TELEMETRY } from "#src/telemetry/otlp.js";
import { createFakeAdapter } from "../../support/fake-adapter.js";

const now = Date.parse("2026-09-07T07:00:00Z");
const resetAt = Date.parse("2026-09-07T08:23:00Z");
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "capability-conformance-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe.each(["separate", "activation_is_probe"] as const)(
  "%s capability conformance",
  (probeMode) => {
    async function run(
      observation: AgentObservation,
      capabilities: { exactReset: boolean; weeklyLimitDetection: boolean },
    ) {
      const fake = createFakeAdapter("claude", {
        probeMode,
        probe: [observation],
        activate: [observation],
      });
      const adapter = {
        ...fake,
        capabilities: { probeMode, ...capabilities },
      };
      const store = createStateStore(join(directory, "state"));
      const context = {
        config: parseConfig("version: 1\ntimezone: UTC\n", "conformance.yaml"),
        store,
        registry: createRegistry([adapter]),
        runner: { run: () => Promise.reject(new Error("No provider calls")) },
        workDir: directory,
        log: { write: () => Promise.resolve() },
        telemetry: NO_TELEMETRY,
        runtime: "local" as const,
        now: () => now,
        wallClock: () => now,
      };
      const result = await tick(context, { only: [adapter.id] });
      return {
        context,
        result,
        state: (await store.load()).state.agents.claude,
      };
    }

    it("uses quota backoff when exact resets are unsupported", async () => {
      const { state } = await run(
        {
          kind: "blocked",
          reason: "rolling_window",
          constraints: [
            { type: "rolling_window", resetAt, confidence: "high" },
          ],
        },
        { exactReset: false, weeklyLimitDetection: false },
      );
      expect(state).toMatchObject({
        phase: "waiting_unknown_reset",
        nextAttemptAt: Date.parse("2026-09-07T07:05:00Z"),
        retryIndex: 1,
      });
      expect(state.blockedUntil).toBeUndefined();
    });

    it("skips short retries for an identified weekly block without a reset", async () => {
      const { state } = await run(
        {
          kind: "blocked",
          reason: "weekly_limit",
          constraints: [{ type: "weekly", confidence: "high" }],
        },
        { exactReset: false, weeklyLimitDetection: true },
      );
      expect(state).toMatchObject({
        phase: "long_term_block",
        nextAttemptAt: Date.parse("2026-09-07T13:00:00Z"),
        retryIndex: 0,
      });
      expect(state.blockedUntil).toBeUndefined();
    });

    it("waits for the latest known reset even without weekly detection", async () => {
      const { state, context } = await run(
        {
          kind: "blocked",
          reason: "weekly_limit",
          constraints: [
            { type: "rolling_window", resetAt, confidence: "high" },
            {
              type: "weekly",
              resetAt: Date.parse("2026-09-14T12:00:00Z"),
              confidence: "medium",
            },
          ],
        },
        { exactReset: true, weeklyLimitDetection: false },
      );
      expect(state).toMatchObject({
        phase: "waiting_known_reset",
        blockedUntil: Date.parse("2026-09-14T12:00:00Z"),
        nextAttemptAt: Date.parse("2026-09-14T12:01:00Z"),
      });
      expect(
        (
          await tick(
            { ...context, now: () => Date.parse("2026-09-08T07:00:00Z") },
            { only: ["claude"] },
          )
        ).agents[0],
      ).toMatchObject({ phase: "waiting_known_reset", skipped: "not_due" });
    });

    it("keeps short retries when weekly detection is unsupported", async () => {
      const { state, context } = await run(
        {
          kind: "blocked",
          reason: "weekly_limit",
          constraints: [{ type: "weekly", confidence: "high" }],
        },
        { exactReset: true, weeklyLimitDetection: false },
      );
      expect(state).toMatchObject({
        phase: "waiting_unknown_reset",
        nextAttemptAt: Date.parse("2026-09-07T07:05:00Z"),
      });
      expect(
        (
          await tick(
            { ...context, now: () => Date.parse("2026-09-07T07:05:00Z") },
            { only: ["claude"] },
          )
        ).agents[0],
      ).toMatchObject({
        phase: "waiting_unknown_reset",
        nextAttemptAt: Date.parse("2026-09-07T07:15:00Z"),
      });
    });

    it("identifies weekly constraints even when the overall reason is quota", async () => {
      const { state } = await run(
        {
          kind: "blocked",
          reason: "quota",
          constraints: [{ type: "weekly", confidence: "medium" }],
        },
        { exactReset: true, weeklyLimitDetection: true },
      );
      expect(state).toMatchObject({
        phase: "long_term_block",
        nextAttemptAt: Date.parse("2026-09-07T13:00:00Z"),
      });
    });

    it("does not use low-confidence weekly classifications to skip retries", async () => {
      const { state } = await run(
        {
          kind: "blocked",
          reason: "quota",
          constraints: [{ type: "weekly", resetAt, confidence: "low" }],
        },
        { exactReset: true, weeklyLimitDetection: true },
      );
      expect(state).toMatchObject({
        phase: "waiting_unknown_reset",
        nextAttemptAt: Date.parse("2026-09-07T07:05:00Z"),
      });
    });

    it("keeps a weekly block on its persisted long-term cadence", async () => {
      const { state, context } = await run(
        { kind: "blocked", reason: "weekly_limit", constraints: [] },
        { exactReset: true, weeklyLimitDetection: true },
      );
      expect(state).toMatchObject({ phase: "long_term_block" });
      expect(
        (
          await tick(
            { ...context, now: () => Date.parse("2026-09-07T12:00:00Z") },
            { only: ["claude"] },
          )
        ).agents[0],
      ).toMatchObject({ phase: "long_term_block", skipped: "not_due" });
      expect(
        (
          await tick(
            { ...context, now: () => Date.parse("2026-09-07T13:00:00Z") },
            { only: ["claude"] },
          )
        ).agents[0],
      ).toMatchObject({
        phase: "long_term_block",
        nextAttemptAt: Date.parse("2026-09-07T19:00:00Z"),
      });
    });
  },
);
