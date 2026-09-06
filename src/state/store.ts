/**
 * Reads and writes the state file.
 *
 * Two things make this more than `readFile`/`writeFile`. A tick can be killed
 * at any moment — the laptop closes, the scheduler is reinstalled — so the file
 * is replaced by an atomic rename and never edited in place. And two ticks can
 * overlap, because a slow run is still going when the next one fires, so a
 * tick takes an advisory lock and a second one declines rather than racing.
 */

import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { emptyState, type AgentWakerState } from "#src/core/state.js";
import { writeAtomic } from "#src/state/atomic.js";
import { decodeState, encodeState } from "#src/state/codec.js";
import type { Instant } from "#src/core/time.js";

/** Owner read/write. State is not secret, but it is nobody else's business. */
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/**
 * How long a lock may be held before it is assumed abandoned.
 *
 * The liveness check below catches an ordinary crash; this catches the case it
 * cannot, where the pid has been recycled by an unrelated process. Generous
 * next to a tick that spends at most a couple of minutes talking to providers.
 */
const STALE_LOCK_MS = 900_000;

/** How many times to clear an abandoned lock before giving up on the run. */
const STEAL_ATTEMPTS = 3;

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

/** Whether a process is still around to be holding the lock. */
function isRunning(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without delivering.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which still counts.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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

      if (typeof pid !== "number" || typeof since !== "number") {
        return undefined;
      }

      return { pid, since };
    } catch {
      // Absent, half-written or hand-edited: none of them is a live holder.
      return undefined;
    }
  };

  const acquire = async (): Promise<void> => {
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });

    // Bounded rather than recursive: each pass may clear one abandoned lock,
    // and two processes clearing the same one must not chase each other.
    for (let attempt = 0; attempt < STEAL_ATTEMPTS; attempt += 1) {
      const lock: LockFile = { pid: process.pid, since: Date.now() };

      try {
        // "wx" fails if the file exists, which is what makes this a lock.
        const handle = await open(lockPath, "wx", FILE_MODE);

        try {
          await handle.writeFile(JSON.stringify(lock), "utf8");
        } finally {
          await handle.close();
        }

        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const held = await readLock();

      if (
        held !== undefined &&
        isRunning(held.pid) &&
        Date.now() - held.since < STALE_LOCK_MS
      ) {
        throw new LockedError(held.pid, held.since);
      }

      // Abandoned by a run that was killed, or left by a pid that has since
      // been reused. Either way nobody is coming back for it.
      await rm(lockPath, { force: true });
    }

    throw new LockedError(0, Date.now());
  };

  return {
    load,
    save,

    async withLock<T>(run: () => Promise<T>): Promise<T> {
      await acquire();

      try {
        return await run();
      } finally {
        await rm(lockPath, { force: true });
      }
    },
  };
}
