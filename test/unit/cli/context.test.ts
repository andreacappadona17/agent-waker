import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("#src/telemetry/otlp.js", () => {
  throw new Error("telemetry loaded without a configured endpoint");
});

import { openContext } from "#src/cli/context.js";

describe("openContext without telemetry", () => {
  it("does not import the OTLP module", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-waker-context-"));

    try {
      const context = await openContext(
        {
          argv: [],
          env: { HOME: home },
          home,
          platform: "darwin",
          uid: 501,
          isTty: false,
          now: Date.now,
          write: () => undefined,
          writeError: () => undefined,
          execPath: process.execPath,
          entrypoint: "/agent-waker",
          systemTimezone: "UTC",
        },
        { allowMissingConfig: true },
      );

      await expect(context.telemetry.flush()).resolves.toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
