/**
 * Reads and writes the state file.
 *
 * Two things make this more than `readFile`/`writeFile`. A tick can be killed
 * at any moment — the laptop closes, the scheduler is reinstalled — so the file
 * is replaced by an atomic rename and never edited in place. And two ticks can
 * overlap, because a slow run is still going when the next one fires, so a
 * tick takes an advisory lock and a second one declines rather than racing.
 */

import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import { emptyState, type AgentWakerState } from "#src/core/state.js";
import { writeAtomic } from "#src/state/atomic.js";
import { decodeState, encodeState } from "#src/state/codec.js";
import type { Instant } from "#src/core/time.js";

/** Owner read/write. State is not secret, but it is nobody else's business. */
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/** Where the state came from, so the caller knows whether to warn. */
export type StateSource = "file" | "backup" | "empty" | "reset";

export interface LoadedState {
  readonly state: AgentWakerState;
  /**
   * `backup` means the main file was unreadable. `reset` means neither copy
   * was, and the agent may activate once more than it needed to today.
   */
  readonly source: StateSource;
}

export interface StateStore {
  load(): Promise<LoadedState>;
  save(state: AgentWakerState): Promise<void>;
  withLock<T>(run: () => Promise<T>): Promise<T>;
}

/** Raised when another tick is already running. */
export class LockedError extends Error {
  readonly pid: number;
  readonly since: Instant;

  constructor(pid: number, since: Instant) {
    super(
      `Another agent waker run is in progress (pid ${String(pid)}, started ${new Date(since).toISOString()}).`,
    );
    this.name = "LockedError";
    this.pid = pid;
    this.since = since;
  }
}

interface LockFile {
  pid: number;
  since: Instant;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Opens a state store rooted at a directory, creating it on first write. */
export function createStateStore(directory: string): StateStore {
  const statePath = join(directory, "state.json");
  const backupPath = join(directory, "state.json.bak");
  const lockPath = join(directory, "lock");

  /** Reads one copy, or `undefined` if it is absent or unusable. */
  const readCopy = async (
    path: string,
  ): Promise<AgentWakerState | undefined> => {
    let text: string;

    try {
      text = await readFile(path, "utf8");
    } catch {
      return undefined;
    }

    try {
      return decodeState(JSON.parse(text));
    } catch {
      // Corrupt rather than absent, but the answer is the same: try the other
      // copy. The caller reports which one it ended up with.
      return undefined;
    }
  };

  const load = async (): Promise<LoadedState> => {
    const current = await readCopy(statePath);

    if (current !== undefined) return { state: current, source: "file" };

    const backup = await readCopy(backupPath);

    if (backup !== undefined) return { state: backup, source: "backup" };

    // Nothing on disk at all is a first run, not a loss.
    const untouched = await readFile(statePath, "utf8").then(
      () => false,
      isMissing,
    );

    return {
      state: emptyState(),
      source: untouched ? "empty" : "reset",
    };
  };

  const save = async (state: AgentWakerState): Promise<void> => {
    await writeAtomic(
      statePath,
      `${JSON.stringify(encodeState(state), null, 2)}\n`,
      { mode: FILE_MODE, directoryMode: DIRECTORY_MODE, backupPath },
    );
  };

  const readLock = async (): Promise<LockFile | undefined> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
      const { pid, since } = parsed as Partial<LockFile>;

      if (
        typeof pid !== "number" ||
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        typeof since !== "number" ||
        !Number.isFinite(since) ||
        Math.abs(since) > 8.64e15
      ) {
        return undefined;
      }

      return { pid, since };
    } catch {
      // Metadata is diagnostic only; the kernel decides whether it is locked.
      return undefined;
    }
  };

  return {
    load,
    save,

    async withLock<T>(run: () => Promise<T>): Promise<T> {
      await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
      const handle = await open(lockPath, "a+", FILE_MODE);

      try {
        // flock locks the shared open file description. The child sets it on
        // inherited fd 3; our handle keeps it held after the child exits.
        // Closing the handle (including on process death) releases it. Never
        // unlink this file: another opener must always lock the same inode.
        const code = await new Promise<number | null>((resolve, reject) => {
          const child = spawn(
            process.platform === "darwin" ? "/usr/bin/lockf" : "/usr/bin/flock",
            process.platform === "darwin"
              ? ["-s", "-t", "0", "3"]
              : ["-n", "-E", "75", "3"],
            { stdio: ["ignore", "ignore", "ignore", handle.fd] },
          );
          child.on("error", reject);
          child.on("close", resolve);
        });

        if (code === 75) {
          const held = await readLock();
          throw new LockedError(held?.pid ?? 0, held?.since ?? Date.now());
        }
        if (code !== 0)
          throw new Error(
            `Could not acquire state lock (exit ${String(code)}).`,
          );

        await handle.truncate(0);
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, since: Date.now() }),
          "utf8",
        );
        return await run();
      } finally {
        await handle.close();
      }
    },
  };
}
