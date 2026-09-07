import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { VERSION } from "#src/cli/main.js";

describe("the reported version", () => {
  it("is the version of the package that was built", async () => {
    // v0.2.0 shipped reporting 0.1.0: release-please bumped the manifest and
    // left the constant behind, so the released binary misreported itself and
    // any bug filed against it was unattributable. The annotation in main.ts
    // keeps them together now; this is what notices if it stops working.
    const manifest = JSON.parse(
      await readFile(
        join(import.meta.dirname, "../../../package.json"),
        "utf8",
      ),
    ) as { version: string };

    expect(VERSION).toBe(manifest.version);
  });
});
