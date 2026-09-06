import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,

        // The scheduling core is pure, takes an injected clock and decides
        // everything the product does. It is the one place where a gap in the
        // tests is not visible until a user's morning is missed, so it is held
        // to the whole of its behaviour rather than to a percentage.
        "src/core/**": {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
      },
    },
  },
});
