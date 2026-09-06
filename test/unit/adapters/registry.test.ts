import { describe, expect, it } from "vitest";

import { createRegistry, UnknownAdapterError } from "#src/adapters/registry.js";
import { createFakeAdapter } from "../../support/fake-adapter.js";

describe("createRegistry", () => {
  const claude = createFakeAdapter("claude");
  const codex = createFakeAdapter("codex");
  const registry = createRegistry([claude, codex]);

  it("hands back the adapter for an agent", () => {
    expect(registry.get("claude")).toBe(claude);
    expect(registry.get("codex")).toBe(codex);
  });

  it("lists what it has, in the order it was given", () => {
    expect(registry.list()).toEqual([claude, codex]);
  });

  it("says which agent it has no adapter for", () => {
    // A build shipped without an adapter should fail by name, not by
    // undefined turning up somewhere further along.
    expect(() => createRegistry([claude]).get("codex")).toThrow(
      UnknownAdapterError,
    );
    expect(() => createRegistry([claude]).get("codex")).toThrow(/codex/);
  });

  it("refuses two adapters claiming the same agent", () => {
    expect(() => createRegistry([claude, createFakeAdapter("claude")])).toThrow(
      /claude/,
    );
  });
});
