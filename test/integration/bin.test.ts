import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const run = promisify(execFile);

/**
 * The built CLI, which is a different program from the one every other test
 * exercises: those resolve TypeScript sources, this resolves what is published.
 *
 * It exists because the two diverged once. The package's import map pointed at
 * the sources, so every test passed while `node dist/cli/bin.js` could not
 * resolve a single module.
 */
const BIN = join(import.meta.dirname, "..", "..", "dist", "cli", "bin.js");

describe.skipIf(!existsSync(BIN))("the built CLI", () => {
  it("starts and reports its version", async () => {
    const { stdout } = await run(process.execPath, [BIN, "--version"]);

    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("prints usage", async () => {
    const { stdout } = await run(process.execPath, [BIN, "help"]);

    expect(stdout).toContain("Usage:");
  });

  it("explains itself when there is nothing configured", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-waker-bin-"));

    try {
      const failure = await run(process.execPath, [BIN, "status"], {
        env: { HOME: home, PATH: process.env.PATH ?? "" },
      }).then(
        () => undefined,
        (error: unknown) => error as { code: number; stderr: string },
      );

      expect(failure?.code).toBe(2);
      expect(failure?.stderr).toContain("agent-waker init");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
