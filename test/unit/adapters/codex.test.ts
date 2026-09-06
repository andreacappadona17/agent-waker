import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACTIVATION_PROMPT,
  createCodexAdapter,
  parseActivation,
  parseLoginStatus,
} from "#src/adapters/codex.js";
import type { AdapterContext } from "#src/adapters/contract.js";
import type {
  ProcessResult,
  ProcessRunner,
  ProcessSpec,
} from "#src/process/runner.js";

const fixture = (name: string): Promise<string> =>
  readFile(join(import.meta.dirname, "../../fixtures/codex", name), "utf8");

const ran = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  signal: null,
  timedOut: false,
  truncated: { stdout: false, stderr: false },
  durationMs: 100,
  ...overrides,
});

describe("parseLoginStatus", () => {
  it("reads a real ChatGPT-plan session", async () => {
    // Captured from `codex login status`, which exits zero and prints this on
    // stderr while leaving stdout empty. Reading only stdout reported a
    // signed-in user as signed out, which an end-to-end run against the real
    // CLI caught and these fixtures did not.
    expect(
      parseLoginStatus(
        ran({ stderr: await fixture("login-status-chatgpt.txt") }),
      ),
    ).toMatchObject({
      authenticated: true,
      mode: "subscription_local",
      supportsIntent: true,
    });
  });

  it("reads the same line from stdout, should it ever move there", async () => {
    expect(
      parseLoginStatus(
        ran({ stdout: await fixture("login-status-chatgpt.txt") }),
      ),
    ).toMatchObject({ supportsIntent: true });
  });

  it("treats a failing status command as not signed in", () => {
    expect(parseLoginStatus(ran({ exitCode: 1 }))).toMatchObject({
      authenticated: false,
      mode: "none",
      supportsIntent: false,
    });
  });

  it("refuses anything it does not recognise as a plan session", () => {
    // Fails closed. Codex can also be logged in with an API key, which bills
    // per token and does nothing for the plan's usage window.
    const auth = parseLoginStatus(
      ran({ stdout: "Logged in using an API key" }),
    );

    expect(auth).toMatchObject({ authenticated: true, supportsIntent: false });
    expect(auth.mode).toBe("unknown");
  });

  it("quotes what Codex actually said, so the user can act on it", () => {
    expect(
      parseLoginStatus(ran({ stdout: "Logged in using an API key" })).message,
    ).toContain("Logged in using an API key");
  });

  it("does not treat empty output as a session", () => {
    expect(parseLoginStatus(ran({ stdout: "", stderr: "" }))).toMatchObject({
      authenticated: false,
      supportsIntent: false,
    });
  });
});

describe("parseActivation", () => {
  it("reads a successful run from its exit status", () => {
    // The requirements prefer process status over output text for success, and
    // Codex streams events rather than printing one result document.
    expect(
      parseActivation(
        ran({
          exitCode: 0,
          stdout: '{"type":"thread.started"}\n{"type":"turn.completed"}\n',
        }),
      ),
    ).toEqual({ kind: "activated" });
  });

  it("reads a real usage-limit refusal", async () => {
    // Captured from a live `codex exec --json` run against an exhausted plan.
    const observation = parseActivation(
      ran({
        exitCode: 1,
        stdout: await fixture("activation-usage-limit.jsonl"),
      }),
    );

    expect(observation).toMatchObject({
      kind: "blocked",
      reason: "quota",
      constraints: [{ type: "quota", confidence: "high" }],
    });
  });

  it("does not turn a bare clock time into a reset", async () => {
    // The real message ends "try again at 9:14 PM": no date, no zone, and no
    // way to know which day. A guess would be low confidence, which the policy
    // ignores anyway, so the ladder runs instead.
    const observation = parseActivation(
      ran({
        exitCode: 1,
        stdout: await fixture("activation-usage-limit.jsonl"),
      }),
    );

    expect(
      observation.kind === "blocked"
        ? observation.constraints[0]?.resetAt
        : "x",
    ).toBeUndefined();
  });

  it("keeps the message so the user still sees the time", async () => {
    const observation = parseActivation(
      ran({
        exitCode: 1,
        stdout: await fixture("activation-usage-limit.jsonl"),
      }),
    );

    expect(
      observation.kind === "blocked" ? observation.detail : undefined,
    ).toContain("try again at 9:14 PM");
  });

  it("reports a failure it cannot classify rather than guessing", () => {
    expect(
      parseActivation(
        ran({
          exitCode: 1,
          stdout:
            '{"type":"turn.failed","error":{"message":"something new"}}\n',
        }),
      ),
    ).toMatchObject({ kind: "unknown", detail: "something new" });
  });

  it("finds the message in a bare error event", () => {
    expect(
      parseActivation(
        ran({
          exitCode: 1,
          stdout:
            '{"type":"error","message":"you have hit your usage limit"}\n',
        }),
      ),
    ).toMatchObject({ kind: "blocked" });
  });

  it("copes with a failure that produced no events at all", () => {
    expect(parseActivation(ran({ exitCode: 1, stderr: "boom" }))).toMatchObject(
      {
        kind: "unknown",
      },
    );
  });

  it("ignores a line that is not JSON", () => {
    expect(
      parseActivation(
        ran({
          exitCode: 1,
          stdout:
            'not json\n{"type":"error","message":"usage limit reached"}\n',
        }),
      ),
    ).toMatchObject({ kind: "blocked" });
  });

  describe("process-level failures", () => {
    it.each([
      ["ENOENT", "executable_missing"],
      ["ENOEXEC", "broken_install"],
    ])("reads %s as %s", (startFailure, category) => {
      expect(
        parseActivation(ran({ startFailure, exitCode: null })),
      ).toMatchObject({ kind: "runtime_error", category });
    });

    it("reads a timeout", () => {
      expect(
        parseActivation(ran({ timedOut: true, exitCode: null })),
      ).toMatchObject({
        kind: "runtime_error",
        category: "timeout",
      });
    });
  });
});

describe("createCodexAdapter", () => {
  const recording = (): { runner: ProcessRunner; specs: ProcessSpec[] } => {
    const specs: ProcessSpec[] = [];

    return {
      specs,
      runner: {
        run(spec: ProcessSpec): Promise<ProcessResult> {
          specs.push(spec);
          return Promise.resolve(ran());
        },
      },
    };
  };

  const context = (runner: ProcessRunner): AdapterContext => ({
    runner,
    workDir: "/tmp/neutral",
    now: 0,
  });

  const detection = {
    installed: true,
    executable: "/usr/local/bin/codex",
    health: "ok" as const,
  };

  it("asks for login status without consuming anything", async () => {
    const { runner, specs } = recording();

    await createCodexAdapter().inspectAuth(context(runner), detection);

    expect(specs[0]).toMatchObject({
      executable: "/usr/local/bin/codex",
      args: ["login", "status"],
    });
  });

  it("runs an ephemeral, read-only, repository-free activation", async () => {
    // Every one of these flags is containment, and Codex needs the git check
    // skipped to run in a scratch directory at all.
    const { runner, specs } = recording();

    await createCodexAdapter().activate(context(runner), detection, {
      authenticated: true,
      mode: "subscription_local",
      supportsIntent: true,
    });

    expect(specs[0]?.args).toEqual([
      "exec",
      ACTIVATION_PROMPT,
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--ephemeral",
    ]);
    expect(specs[0]?.cwd).toBe("/tmp/neutral");
  });

  it("closes stdin, which Codex otherwise waits on", async () => {
    // Observed: with stdin open, `codex exec` prints "Reading additional input
    // from stdin..." and blocks, which in a scheduled run means a hung tick.
    const { runner, specs } = recording();

    await createCodexAdapter().activate(context(runner), detection, {
      authenticated: true,
      mode: "subscription_local",
      supportsIntent: true,
    });

    expect(specs[0]?.stdin ?? "closed").toBe("closed");
  });

  it("uses the activation as its own availability check", () => {
    const adapter = createCodexAdapter();

    expect(adapter.capabilities.probeMode).toBe("activation_is_probe");
    expect(Object.hasOwn(adapter, "probe")).toBe(false);
  });
});
