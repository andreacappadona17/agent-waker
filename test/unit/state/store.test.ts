import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyState, type AgentWakerState } from "#src/core/state.js";
import { createStateStore, LockedError } from "#src/state/store.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-waker-state-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const statePath = (): string => join(directory, "state.json");
const backupPath = (): string => join(directory, "state.json.bak");
const lockPath = (): string => join(directory, "lock");

const stateAt = (updatedAt: number): AgentWakerState => ({
  ...emptyState(),
  updatedAt,
  agents: {
    claude: { phase: "activated", cycleDate: "2026-09-06" },
    codex: { phase: "idle" },
  },
});

describe("load", () => {
  it("starts empty on a machine that has never run", async () => {
    const store = createStateStore(directory);

    expect(await store.load()).toEqual({
      source: "empty",
      state: emptyState(),
    });
  });

  it("reads back what was saved", async () => {
    const store = createStateStore(directory);
    const saved = stateAt(1_757_000_000_000);

    await store.save(saved);

    expect(await store.load()).toEqual({ source: "file", state: saved });
  });

  it("writes a file a person can read", async () => {
    const store = createStateStore(directory);

    await store.save(stateAt(1_757_000_000_000));

    const text = await readFile(statePath(), "utf8");

    expect(text).toContain('"phase": "activated"');
    expect(text).toContain('"updatedAt": "2025-09-04T');
    expect(text.endsWith("\n")).toBe(true);
  });

  it("recovers from the backup when the file is corrupt", async () => {
    const store = createStateStore(directory);
    const good = stateAt(1_757_000_000_000);

    await store.save(good);
    await store.save(stateAt(1_757_000_060_000));
    await writeFile(statePath(), "{ this is not json", "utf8");

    expect(await store.load()).toEqual({ source: "backup", state: good });
  });

  it("recovers from the backup when the file is truncated", async () => {
    const store = createStateStore(directory);
    const good = stateAt(1_757_000_000_000);

    await store.save(good);
    await store.save(stateAt(1_757_000_060_000));
    await writeFile(statePath(), "", "utf8");

    expect((await store.load()).source).toBe("backup");
  });

  it("recovers from the backup when the file is valid JSON but not state", async () => {
    const store = createStateStore(directory);
    const good = stateAt(1_757_000_000_000);

    await store.save(good);
    await store.save(stateAt(1_757_000_060_000));
    await writeFile(statePath(), '{"version": 99}', "utf8");

    expect(await store.load()).toEqual({ source: "backup", state: good });
  });

  it("starts over when neither copy can be read", async () => {
    // The documented last resort: one redundant activation is the worst case,
    // and the caller warns about it.
    const store = createStateStore(directory);

    await store.save(stateAt(1_757_000_000_000));
    await writeFile(statePath(), "broken", "utf8");
    await writeFile(backupPath(), "also broken", "utf8");

    expect(await store.load()).toEqual({
      source: "reset",
      state: emptyState(),
    });
  });

  it("uses the backup when the file went missing mid-write", async () => {
    const store = createStateStore(directory);
    const good = stateAt(1_757_000_000_000);

    await store.save(good);
    await store.save(stateAt(1_757_000_060_000));
    await rm(statePath());

    expect(await store.load()).toEqual({ source: "backup", state: good });
  });
});

describe("save", () => {
  it("keeps the previous version as a backup", async () => {
    const store = createStateStore(directory);
    const first = stateAt(1_757_000_000_000);

    await store.save(first);
    await store.save(stateAt(1_757_000_060_000));

    const backup: unknown = JSON.parse(await readFile(backupPath(), "utf8"));

    expect(backup).toMatchObject({ updatedAt: "2025-09-04T15:33:20.000Z" });
  });

  it("leaves no temporary files behind", async () => {
    const store = createStateStore(directory);

    await store.save(stateAt(1_757_000_000_000));
    await store.save(stateAt(1_757_000_060_000));

    const { readdir } = await import("node:fs/promises");

    expect((await readdir(directory)).toSorted()).toEqual([
      "state.json",
      "state.json.bak",
    ]);
  });

  it("creates the directory it was pointed at", async () => {
    const nested = join(directory, "deep", "state");
    const store = createStateStore(nested);

    await store.save(stateAt(1_757_000_000_000));

    expect((await store.load()).source).toBe("file");
  });

  it("keeps the state private to the user", async () => {
    // Not secret, but not other users' business either.
    const store = createStateStore(directory);

    await store.save(stateAt(1_757_000_000_000));

    expect((await stat(statePath())).mode & 0o777).toBe(0o600);
  });
});

describe("withLock", () => {
  it("runs the work and returns its result", async () => {
    const store = createStateStore(directory);

    expect(await store.withLock(() => Promise.resolve("done"))).toBe("done");
  });

  it("releases the lock afterwards", async () => {
    const store = createStateStore(directory);

    await store.withLock(() => Promise.resolve(null));

    expect(await store.withLock(() => Promise.resolve("again"))).toBe("again");
  });

  it("releases the lock when the work throws", async () => {
    const store = createStateStore(directory);

    await expect(
      store.withLock(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    expect(await store.withLock(() => Promise.resolve("again"))).toBe("again");
  });

  it("refuses to run while another tick holds the lock", async () => {
    const store = createStateStore(directory);

    await store.withLock(async () => {
      await expect(store.withLock(() => Promise.resolve(null))).rejects.toThrow(
        LockedError,
      );
    });
  });

  it("says who holds the lock and since when", async () => {
    const store = createStateStore(directory);

    expect.assertions(2);

    await store.withLock(async () => {
      try {
        await store.withLock(() => Promise.resolve(null));
      } catch (error) {
        expect((error as LockedError).pid).toBe(process.pid);
        expect((error as LockedError).since).toBeLessThanOrEqual(Date.now());
      }
    });
  });

  it("takes over a lock left behind by a process that died", async () => {
    // A tick killed mid-run must not wedge the scheduler until someone notices.
    const store = createStateStore(directory);
    const deadPid = 0x7f_ff_ff_ff;

    await writeFile(
      lockPath(),
      JSON.stringify({ pid: deadPid, since: Date.now() }),
      "utf8",
    );

    expect(await store.withLock(() => Promise.resolve("taken"))).toBe("taken");
  });

  it("takes over a lock file nobody can parse", async () => {
    const store = createStateStore(directory);

    await writeFile(lockPath(), "not json", "utf8");

    expect(await store.withLock(() => Promise.resolve("taken"))).toBe("taken");
  });

  it("takes over a lock whose contents are the wrong shape", async () => {
    const store = createStateStore(directory);

    await writeFile(lockPath(), JSON.stringify({ pid: "me" }), "utf8");

    expect(await store.withLock(() => Promise.resolve("taken"))).toBe("taken");
  });

  it("takes over a lock that is older than any plausible run", async () => {
    // Guards against a recycled pid belonging to some unrelated process.
    const store = createStateStore(directory);

    await writeFile(
      lockPath(),
      JSON.stringify({ pid: process.pid, since: Date.now() - 86_400_000 }),
      "utf8",
    );

    expect(await store.withLock(() => Promise.resolve("taken"))).toBe("taken");
  });
});
