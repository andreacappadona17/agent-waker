import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEventLog, readRecentEvents } from "#src/logging/log.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-waker-logs-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const utc = (iso: string): number => Date.parse(iso);
const MORNING = utc("2026-09-07T05:00:02.000Z");

const lines = async (name: string): Promise<unknown[]> =>
  (await readFile(join(directory, name), "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);

describe("createEventLog", () => {
  it("writes one JSON object per line", async () => {
    const log = createEventLog({ directory });

    await log.write({
      timestamp: MORNING,
      level: "info",
      event: "agent.activation.succeeded",
      agent: "claude",
      runtime: "local",
      fields: { durationMs: 1_842, exitCode: 0 },
    });

    expect(await lines("events-2026-09-07.jsonl")).toEqual([
      {
        timestamp: "2026-09-07T05:00:02.000Z",
        level: "info",
        event: "agent.activation.succeeded",
        agent: "claude",
        runtime: "local",
        fields: { durationMs: 1_842, exitCode: 0 },
      },
    ]);
  });

  it("appends rather than replacing", async () => {
    const log = createEventLog({ directory });

    await log.write({
      timestamp: MORNING,
      level: "info",
      event: "scheduler.tick",
      runtime: "local",
      fields: {},
    });
    await log.write({
      timestamp: MORNING + 1_000,
      level: "info",
      event: "agent.detected",
      runtime: "local",
      fields: {},
    });

    expect(await lines("events-2026-09-07.jsonl")).toHaveLength(2);
  });

  it("omits the agent when the event is not about one", async () => {
    const log = createEventLog({ directory });

    await log.write({
      timestamp: MORNING,
      level: "info",
      event: "scheduler.tick",
      runtime: "local",
      fields: {},
    });

    expect((await lines("events-2026-09-07.jsonl"))[0]).not.toHaveProperty(
      "agent",
    );
  });

  it("starts a new file each local day", async () => {
    const log = createEventLog({ directory, timezone: "Europe/Rome" });

    await log.write({
      timestamp: utc("2026-09-07T21:30:00.000Z"),
      level: "info",
      event: "scheduler.tick",
      runtime: "local",
      fields: {},
    });
    await log.write({
      timestamp: utc("2026-09-07T22:30:00.000Z"),
      level: "info",
      event: "scheduler.tick",
      runtime: "local",
      fields: {},
    });

    // 22:30Z is already the next day in Rome, so the log follows the clock the
    // user reads their schedule in.
    expect((await readdir(directory)).toSorted()).toEqual([
      "events-2026-09-07.jsonl",
      "events-2026-09-08.jsonl",
    ]);
  });

  it("keeps the log private to the user", async () => {
    const log = createEventLog({ directory });

    await log.write({
      timestamp: MORNING,
      level: "info",
      event: "scheduler.tick",
      runtime: "local",
      fields: {},
    });

    expect(
      (await stat(join(directory, "events-2026-09-07.jsonl"))).mode & 0o777,
    ).toBe(0o600);
  });

  describe("levels", () => {
    it("drops debug events by default", async () => {
      const log = createEventLog({ directory });

      await log.write({
        timestamp: MORNING,
        level: "debug",
        event: "process.spawned",
        runtime: "local",
        fields: {},
      });

      expect(await readdir(directory)).toEqual([]);
    });

    it("keeps debug events when asked for them", async () => {
      const log = createEventLog({ directory, level: "debug" });

      await log.write({
        timestamp: MORNING,
        level: "debug",
        event: "process.spawned",
        runtime: "local",
        fields: {},
      });

      expect(await lines("events-2026-09-07.jsonl")).toHaveLength(1);
    });

    it("keeps everything at or above the configured level", async () => {
      const log = createEventLog({ directory, level: "warn" });

      for (const level of ["debug", "info", "warn", "error"] as const) {
        await log.write({
          timestamp: MORNING,
          level,
          event: `test.${level}`,
          runtime: "local",
          fields: {},
        });
      }

      expect(
        (await lines("events-2026-09-07.jsonl")).map(
          (line) => (line as { event: string }).event,
        ),
      ).toEqual(["test.warn", "test.error"]);
    });
  });

  describe("redaction", () => {
    it("cannot be bypassed by the caller", async () => {
      // Redaction is part of writing, not something a caller opts into.
      const token = `sk-ant-api03-${"a".repeat(95)}`;
      const log = createEventLog({ directory });

      await log.write({
        timestamp: MORNING,
        level: "error",
        event: "agent.activation.failed",
        agent: "claude",
        runtime: "local",
        fields: { stderr: `auth failed with ${token}` },
      });

      const text = await readFile(
        join(directory, "events-2026-09-07.jsonl"),
        "utf8",
      );

      expect(text).not.toContain(token);
      expect(text).toContain("[redacted]");
    });

    it("masks values named as secret in the environment", async () => {
      const value = "canary-environment-value";
      const log = createEventLog({
        directory,
        env: { ANTHROPIC_AUTH_TOKEN: value },
      });

      await log.write({
        timestamp: MORNING,
        level: "error",
        event: "agent.activation.failed",
        runtime: "local",
        fields: { command: `claude --token ${value}` },
      });

      expect(
        await readFile(join(directory, "events-2026-09-07.jsonl"), "utf8"),
      ).not.toContain(value);
    });
  });

  describe("retention", () => {
    it("deletes logs older than the retention window", async () => {
      await writeFile(join(directory, "events-2026-08-01.jsonl"), "", "utf8");
      await writeFile(join(directory, "events-2026-09-06.jsonl"), "", "utf8");

      const log = createEventLog({ directory, retentionDays: 7 });

      await log.write({
        timestamp: MORNING,
        level: "info",
        event: "scheduler.tick",
        runtime: "local",
        fields: {},
      });

      expect((await readdir(directory)).toSorted()).toEqual([
        "events-2026-09-06.jsonl",
        "events-2026-09-07.jsonl",
      ]);
    });

    it("leaves files it did not write alone", async () => {
      await writeFile(join(directory, "notes.txt"), "", "utf8");

      const log = createEventLog({ directory, retentionDays: 1 });

      await log.write({
        timestamp: MORNING,
        level: "info",
        event: "scheduler.tick",
        runtime: "local",
        fields: {},
      });

      expect(await readdir(directory)).toContain("notes.txt");
    });

    it("prunes once rather than on every event", async () => {
      await writeFile(join(directory, "events-2026-08-01.jsonl"), "", "utf8");

      const log = createEventLog({ directory, retentionDays: 7 });

      await log.write({
        timestamp: MORNING,
        level: "info",
        event: "scheduler.tick",
        runtime: "local",
        fields: {},
      });

      // A file that appears afterwards survives, which is what proves the sweep
      // is not repeated for each line a tick writes.
      await writeFile(join(directory, "events-2026-08-02.jsonl"), "", "utf8");
      await log.write({
        timestamp: MORNING + 1_000,
        level: "info",
        event: "scheduler.tick",
        runtime: "local",
        fields: {},
      });

      expect(await readdir(directory)).toContain("events-2026-08-02.jsonl");
    });

    it("prunes even when every event it is given is filtered out", async () => {
      // Most ticks are no-ops and a no-op logs at debug, so pruning behind the
      // level filter would mean a quiet machine never deletes an old file again.
      await writeFile(join(directory, "events-2026-08-01.jsonl"), "{}\n");

      const log = createEventLog({ directory, level: "warn" });

      await log.write({
        timestamp: MORNING,
        level: "debug",
        event: "scheduler.tick",
        runtime: "local",
        fields: {},
      });

      expect(await readdir(directory)).toEqual([]);
    });
  });
});

describe("readRecentEvents", () => {
  it("reads nothing from a directory that does not exist", async () => {
    expect(await readRecentEvents(join(directory, "absent"), 10)).toEqual([]);
  });

  it("returns the most recent events last", async () => {
    const log = createEventLog({ directory });

    for (const [index, day] of ["06", "07"].entries()) {
      await log.write({
        timestamp: utc(`2026-09-${day}T05:00:0${String(index)}.000Z`),
        level: "info",
        event: `day.${day}`,
        runtime: "local",
        fields: {},
      });
    }

    expect(
      (await readRecentEvents(directory, 10)).map((event) => event.event),
    ).toEqual(["day.06", "day.07"]);
  });

  it("returns at most the number of events asked for", async () => {
    const log = createEventLog({ directory });

    for (let index = 0; index < 5; index += 1) {
      await log.write({
        timestamp: MORNING + index * 1_000,
        level: "info",
        event: `event.${String(index)}`,
        runtime: "local",
        fields: {},
      });
    }

    expect(
      (await readRecentEvents(directory, 2)).map((event) => event.event),
    ).toEqual(["event.3", "event.4"]);
  });

  it("skips a line that is not an event", async () => {
    // A log truncated by a crash, or an editor's stray keystroke.
    await writeFile(
      join(directory, "events-2026-09-07.jsonl"),
      '{"timestamp":"2026-09-07T05:00:02.000Z","level":"info","event":"good","runtime":"local","fields":{}}\n{ truncated\n',
      "utf8",
    );

    expect(
      (await readRecentEvents(directory, 10)).map((event) => event.event),
    ).toEqual(["good"]);
  });
});
