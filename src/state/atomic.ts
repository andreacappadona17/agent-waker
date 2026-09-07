/**
 * Replacing a file without ever leaving a half-written one.
 *
 * Both files this program owns — state and configuration — are rewritten by
 * the same three steps: write a sibling, get its bytes to the disk, then move
 * it into place. The move is what makes it atomic; the fsync is what makes the
 * move worth anything after a power cut.
 */

import { copyFile, mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";

export interface AtomicWriteOptions {
  readonly mode: number;
  readonly directoryMode?: number;
  /** Where to keep the previous contents, when they are worth keeping. */
  readonly backupPath?: string;
}

/**
 * Writes a file by rename.
 *
 * @param backupPath copied from the current file before the swap, best effort:
 * a torn backup is caught by whatever validates it, whereas a missing primary
 * would look like a first run.
 */
export async function writeAtomic(
  path: string,
  contents: string,
  options: AtomicWriteOptions,
): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
    ...(options.directoryMode === undefined
      ? {}
      : { mode: options.directoryMode }),
  });

  // Unique per process, so two runs cannot scribble on the same scratch file.
  const temporaryPath = `${path}.${String(process.pid)}.tmp`;
  const handle = await open(temporaryPath, "w", options.mode);

  try {
    await handle.writeFile(contents, "utf8");
    // The rename is atomic, but only useful if the bytes it will point at have
    // actually reached the disk.
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (options.backupPath !== undefined) {
    await copyFile(path, options.backupPath).catch(() => undefined);
  }

  await rename(temporaryPath, path);

  // The rename is atomic, but the directory entry that records it is itself
  // buffered: without this a power cut can land the new file's bytes and lose
  // the swap, which reads back as the previous contents rather than as
  // corruption. Best effort, because a filesystem that refuses to fsync a
  // directory must not fail every write — the cost of missing it is one
  // redundant activation, the price the corrupt-file path already pays.
  const directory = await open(dirname(path), "r").catch(() => undefined);

  if (directory !== undefined) {
    try {
      await directory.sync();
    } catch {
      // See above: durability we would like, not durability we depend on.
    } finally {
      await directory.close();
    }
  }
}
