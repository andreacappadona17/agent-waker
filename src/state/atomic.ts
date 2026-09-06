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

  // ponytail: the directory entry itself is not fsynced. Losing the rename in
  // a power cut costs one redundant activation, the same price the
  // corrupt-file path already pays. Add it if that ever stops being true.
  await rename(temporaryPath, path);
}
