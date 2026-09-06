import { describe, expect, it } from "vitest";

import { toDetection } from "#src/adapters/detection.js";

describe("toDetection", () => {
  const candidate = {
    path: "/usr/local/bin/claude",
    realPath: "/usr/local/bin/claude",
    installHint: "native" as const,
  };

  it("reports nothing found", () => {
    expect(
      toDetection({ installed: false, candidates: [], health: "unknown" }),
    ).toEqual({ installed: false, health: "unknown" });
  });

  it("carries the executable, version and install hint through", () => {
    expect(
      toDetection({
        installed: true,
        selected: candidate,
        candidates: [candidate],
        // The real CLI prints its own name after the number.
        version: "2.1.259 (Claude Code)",
        health: "healthy",
      }),
    ).toEqual({
      installed: true,
      executable: "/usr/local/bin/claude",
      health: "ok",
      installHint: "native",
      version: "2.1.259",
    });
  });

  it("keeps a version line it cannot parse rather than dropping it", () => {
    expect(
      toDetection({
        installed: true,
        selected: candidate,
        candidates: [candidate],
        version: "built from source",
        health: "healthy",
      }).version,
    ).toBe("built from source");
  });

  it("calls a found-but-unrunnable install broken, not missing", () => {
    // A different problem needing different advice: not "install it".
    expect(
      toDetection({
        installed: true,
        selected: candidate,
        candidates: [candidate],
        health: "broken",
      }),
    ).toMatchObject({ installed: true, health: "broken" });
  });
});
