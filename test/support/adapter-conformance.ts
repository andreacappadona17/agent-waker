/** Shared adapter checks. No provider process is ever started. */
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AdapterContext,
  AgentAdapter,
  AuthResult,
} from "#src/adapters/contract.js";
import { createRegistry } from "#src/adapters/registry.js";
import { parseConfig } from "#src/config/config.js";
import type { BlockedObservation } from "#src/core/observation.js";
import { tick } from "#src/core/orchestrator.js";
import * as discovery from "#src/process/discovery.js";
import type { ProcessResult, ProcessSpec } from "#src/process/runner.js";
import { createStateStore } from "#src/state/store.js";
import { NO_TELEMETRY } from "#src/telemetry/otlp.js";

export const completed = (
  overrides: Partial<ProcessResult> = {},
): ProcessResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  signal: null,
  timedOut: false,
  truncated: { stdout: false, stderr: false },
  durationMs: 1,
  ...overrides,
});

interface BlockCase {
  readonly response: ProcessResult;
  readonly expected: BlockedObservation;
}

export interface AdapterConformanceFixture {
  readonly authArgs: readonly string[];
  readonly helpArgs: readonly string[];
  readonly activationArgs: readonly string[];
  readonly help: string;
  readonly auth: Readonly<
    Record<
      "subscription" | "signedOut" | "unsupported",
      {
        readonly response: ProcessResult;
        readonly expected: AuthResult;
      }
    >
  >;
  readonly success: ProcessResult;
  readonly blockedWithoutReset: BlockCase;
  /** An unsupported case must explain why a timestamp cannot be asserted. */
  readonly blockedWithReset: BlockCase | { readonly unsupported: string };
}

export function adapterConformance(
  adapter: AgentAdapter,
  fixture: AdapterConformanceFixture,
): void {
  describe(`${adapter.id} adapter conformance`, () => {
    let directory: string;
    let context: AdapterContext;
    let calls: ProcessSpec[];
    let authResponse: ProcessResult;
    let helpResponse: ProcessResult;
    let activationResponse: ProcessResult;
    const executable = `/fake/bin/${adapter.id}`;
    const installed = { installed: true, executable, health: "ok" } as const;
    const subscribed = {
      authenticated: true,
      mode: "subscription_local",
      supportsIntent: true,
    } as const;
    const found: discovery.ExecutableDiscovery = {
      installed: true,
      health: "healthy",
      version: "1.2.3",
      candidates: [],
      selected: {
        path: executable,
        realPath: executable,
        installHint: "native",
      },
    };

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "adapter-conformance-"));
      const workDir = join(directory, "work", adapter.id);
      await mkdir(workDir, { recursive: true });
      calls = [];
      authResponse = fixture.auth.subscription.response;
      helpResponse = completed({ stdout: fixture.help });
      activationResponse = fixture.success;
      vi.spyOn(discovery, "discoverExecutable").mockResolvedValue(found);
      context = {
        now: Date.parse("2026-09-07T07:00:00Z"),
        workDir,
        runner: {
          async run(spec) {
            calls.push(spec);
            expect(spec.executable).toBe(executable);
            expect(spec.cwd).toBe(workDir);
            expect(await readdir(workDir)).toEqual([]);
            expect(spec.stdin ?? "closed").toBe("closed");
            const key = JSON.stringify(spec.args);
            if (key === JSON.stringify(fixture.authArgs)) return authResponse;
            if (key === JSON.stringify(fixture.helpArgs)) return helpResponse;
            expect(spec.args).toEqual(fixture.activationArgs);
            return activationResponse;
          },
        },
      };
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    });

    const runTick = async () => {
      const result = await tick(
        {
          config: parseConfig(
            "version: 1\ntimezone: UTC\n",
            "conformance.yaml",
          ),
          store: createStateStore(join(directory, "state")),
          registry: createRegistry([adapter]),
          runner: context.runner,
          workDir: join(directory, "work"),
          log: { write: () => Promise.resolve() },
          telemetry: NO_TELEMETRY,
          runtime: "local",
          now: () => context.now,
          wallClock: () => context.now,
        },
        { only: [adapter.id], force: true },
      );
      return result.agents[0];
    };

    it("detects an installed provider", async () => {
      expect(await adapter.detect(context)).toMatchObject({
        ...installed,
        version: "1.2.3",
      });
      expect(discovery.discoverExecutable).toHaveBeenCalledWith(
        adapter.id,
        expect.objectContaining({ runner: context.runner }),
      );
      expect(calls).toEqual([]);
    });

    it.each(["absent", "broken"] as const)(
      "keeps an %s installation out of quota backoff",
      async (condition) => {
        vi.mocked(discovery.discoverExecutable).mockResolvedValue(
          condition === "absent"
            ? { installed: false, candidates: [], health: "unknown" }
            : { ...found, health: "broken" },
        );
        expect(await adapter.detect(context)).toMatchObject(
          condition === "absent"
            ? { installed: false, health: "unknown" }
            : { installed: true, health: "broken" },
        );
        expect(await runTick()).toMatchObject({
          phase: "unhealthy",
          reason:
            condition === "absent" ? "executable_missing" : "broken_install",
        });
        expect(calls).toEqual([]);
      },
    );

    it.each(["subscription", "signedOut", "unsupported"] as const)(
      "classifies %s authentication without activating",
      async (name) => {
        authResponse = fixture.auth[name].response;
        expect(await adapter.inspectAuth(context, installed)).toMatchObject(
          fixture.auth[name].expected,
        );
        expect(calls.map((spec) => spec.args)).toEqual([fixture.authArgs]);
        if (name !== "subscription") {
          expect(await runTick()).toMatchObject({ phase: "auth_required" });
          expect(calls.map((spec) => spec.args)).toEqual([
            fixture.authArgs,
            fixture.authArgs,
          ]);
        }
      },
    );

    it("activates once in the empty workDir using the containment flags", async () => {
      expect(await adapter.activate(context, installed, subscribed)).toEqual({
        kind: "activated",
      });
      expect(calls.map((spec) => spec.args)).toEqual([fixture.activationArgs]);
    });

    it.each(["ENOENT", "ENOEXEC", "EACCES"])(
      "does not classify %s as a Block",
      async (startFailure) => {
        activationResponse = completed({ exitCode: null, startFailure });
        expect(await adapter.activate(context, installed, subscribed)).toEqual({
          kind: "runtime_error",
          category:
            startFailure === "ENOENT" ? "executable_missing" : "broken_install",
        });
      },
    );

    const checkBlock = async (testCase: BlockCase) => {
      activationResponse = testCase.response;
      const observation = await adapter.activate(
        context,
        installed,
        subscribed,
      );
      expect(observation).toMatchObject(testCase.expected);
      expect(observation.kind === "blocked" && observation.constraints).toEqual(
        testCase.expected.constraints,
      );
    };

    it("reports a Block without inventing a reset", async () => {
      await checkBlock(fixture.blockedWithoutReset);
      expect(
        fixture.blockedWithoutReset.expected.constraints.every(
          (constraint) => constraint.resetAt === undefined,
        ),
      ).toBe(true);
    });

    const withReset = fixture.blockedWithReset;
    if ("unsupported" in withReset) {
      it.skip(`exact reset unsupported: ${withReset.unsupported}`);
    } else {
      it("preserves the provider's exact reset", async () => {
        expect(
          withReset.expected.constraints.some((constraint) =>
            Number.isFinite(constraint.resetAt),
          ),
        ).toBe(true);
        await checkBlock(withReset);
      });
    }

    it("checks captured help without spending a turn", async () => {
      expect(await adapter.smokeTest(context, installed)).toEqual([]);
      expect(calls.map((spec) => spec.args)).toEqual([fixture.helpArgs]);
    });

    const flags = fixture.activationArgs.filter((argument) =>
      argument.startsWith("-"),
    );
    it.each(flags)("detects renamed %s before any activation", async (flag) => {
      helpResponse = completed({
        stdout: fixture.help.replaceAll(
          new RegExp(`(^|[^\\w-])${flag}(?![\\w-])`, "g"),
          `$1${flag}-renamed`,
        ),
      });
      expect(await adapter.smokeTest(context, installed)).toEqual([flag]);
      expect(calls.map((spec) => spec.args)).toEqual([fixture.helpArgs]);
    });

    it("reports missing flags when help fails", async () => {
      helpResponse = completed({ exitCode: 2 });
      expect(await adapter.smokeTest(context, installed)).toEqual(flags);
      expect(calls.map((spec) => spec.args)).toEqual([fixture.helpArgs]);
    });
  });
}
