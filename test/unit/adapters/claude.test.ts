import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACTIVATION_PROMPT,
  createClaudeAdapter,
  parseActivation,
  parseAuthStatus,
} from "#src/adapters/claude.js";
import type { AdapterContext } from "#src/adapters/contract.js";
import type {
  ProcessResult,
  ProcessRunner,
  ProcessSpec,
} from "#src/process/runner.js";

const fixture = (name: string): Promise<string> =>
  readFile(join(import.meta.dirname, "../../fixtures/claude", name), "utf8");

/** A completed process, with the fields a parser looks at. */
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

describe("parseAuthStatus", () => {
  it("reads a real subscription session", async () => {
    // Captured from `claude auth status --json`, identifiers replaced.
    const auth = parseAuthStatus(
      ran({ stdout: await fixture("auth-status-subscription.json") }),
    );

    expect(auth).toEqual({
      authenticated: true,
      mode: "subscription_local",
      supportsIntent: true,
      accountHint: "team",
    });
  });

  it("does not carry the account identity into the result", async () => {
    // The real response contains an e-mail address, an organisation name and
    // an organisation id. None of them is anyone's business downstream.
    const auth = parseAuthStatus(
      ran({ stdout: await fixture("auth-status-subscription.json") }),
    );
    const rendered = JSON.stringify(auth);

    expect(rendered).not.toContain("@");
    expect(rendered).not.toContain("Example Org");
    expect(rendered).not.toContain("00000000-0000-4000-8000-000000000000");
  });

  it("reports a signed-out session", () => {
    expect(
      parseAuthStatus(ran({ stdout: '{"loggedIn": false}' })),
    ).toMatchObject({ authenticated: false, supportsIntent: false });
  });

  it("refuses a credential it does not recognise as a subscription", () => {
    // Fails closed: an unrecognised credential might bill per token, so it is
    // never allowed to stand in for subscription activation.
    const auth = parseAuthStatus(
      ran({
        stdout:
          '{"loggedIn": true, "authMethod": "console", "apiProvider": "firstParty"}',
      }),
    );

    expect(auth).toMatchObject({ authenticated: true, supportsIntent: false });
    expect(auth.mode).toBe("unknown");
  });

  it("refuses a cloud provider even when it is signed in", () => {
    expect(
      parseAuthStatus(
        ran({
          stdout:
            '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "bedrock"}',
        }),
      ),
    ).toMatchObject({ supportsIntent: false });
  });

  it("says what it saw without guessing", () => {
    const auth = parseAuthStatus(
      ran({ stdout: '{"loggedIn": true, "authMethod": "console"}' }),
    );

    expect(auth.message).toContain("console");
  });

  it.each([
    ["not json at all", "unparseable output"],
    ["", "no output"],
    ["null", "a null document"],
    ["[]", "an array"],
  ])("treats %j as unknown (%s)", (stdout) => {
    expect(parseAuthStatus(ran({ stdout }))).toMatchObject({
      authenticated: false,
      mode: "unknown",
      supportsIntent: false,
    });
  });

  it("treats a failed status command as unknown", () => {
    expect(
      parseAuthStatus(ran({ exitCode: 1, stderr: "command failed" })),
    ).toMatchObject({ authenticated: false, supportsIntent: false });
  });
});

describe("parseActivation", () => {
  it("reads a real successful activation", async () => {
    // Captured from a live `claude -p ... --output-format json` run.
    expect(
      parseActivation(
        ran({ stdout: await fixture("activation-success.json") }),
      ),
    ).toEqual({ kind: "activated" });
  });

  it("requires the run to have actually succeeded", () => {
    // A result object that says it failed is not an activation, whatever the
    // exit code says.
    expect(
      parseActivation(
        ran({
          stdout:
            '{"type":"result","subtype":"error","is_error":true,"api_error_status":null}',
        }),
      ),
    ).toMatchObject({ kind: "unknown" });
  });

  describe("API status codes", () => {
    // The response carries an `api_error_status` field. These map it by its
    // HTTP meaning rather than by matching any message text.
    it("reads 429 as a usage limit with no stated reset", () => {
      expect(
        parseActivation(
          ran({
            stdout:
              '{"type":"result","is_error":true,"api_error_status":429,"result":"rate limit"}',
          }),
        ),
      ).toMatchObject({
        kind: "blocked",
        reason: "rolling_window",
        constraints: [{ type: "rolling_window", confidence: "high" }],
      });
    });

    it("does not invent a reset time it was not given", () => {
      const observation = parseActivation(
        ran({
          stdout: '{"type":"result","is_error":true,"api_error_status":429}',
        }),
      );

      expect(
        observation.kind === "blocked"
          ? observation.constraints[0]?.resetAt
          : "x",
      ).toBeUndefined();
    });

    it.each([401, 403])("reads %i as an authentication problem", (status) => {
      expect(
        parseActivation(
          ran({
            stdout: `{"type":"result","is_error":true,"api_error_status":${String(status)}}`,
          }),
        ),
      ).toMatchObject({ kind: "auth_error" });
    });

    it.each([500, 503, 529])("reads %i as a transient outage", (status) => {
      expect(
        parseActivation(
          ran({
            stdout: `{"type":"result","is_error":true,"api_error_status":${String(status)}}`,
          }),
        ),
      ).toMatchObject({
        kind: "transient_error",
        category: "provider_unavailable",
      });
    });

    it("reports a status it has no rule for as unclassified", () => {
      expect(
        parseActivation(
          ran({
            stdout: '{"type":"result","is_error":true,"api_error_status":418}',
          }),
        ),
      ).toMatchObject({ kind: "unknown" });
    });
  });

  describe("process-level failures", () => {
    it("reads a missing executable", () => {
      expect(
        parseActivation(ran({ startFailure: "ENOENT", exitCode: null })),
      ).toMatchObject({
        kind: "runtime_error",
        category: "executable_missing",
      });
    });

    it("reads an unrunnable file", () => {
      expect(
        parseActivation(ran({ startFailure: "ENOEXEC", exitCode: null })),
      ).toMatchObject({ kind: "runtime_error", category: "broken_install" });
    });

    it("reads a timeout", () => {
      expect(
        parseActivation(ran({ timedOut: true, exitCode: null })),
      ).toMatchObject({ kind: "runtime_error", category: "timeout" });
    });

    it("reads output that is not the documented JSON", () => {
      expect(
        parseActivation(ran({ exitCode: 1, stdout: "Segmentation fault" })),
      ).toMatchObject({ kind: "runtime_error", category: "malformed_output" });
    });
  });

  it("keeps the provider's own words for the log", () => {
    const observation = parseActivation(
      ran({
        stdout:
          '{"type":"result","is_error":true,"api_error_status":429,"result":"Usage limit reached"}',
      }),
    );

    expect(
      observation.kind === "blocked" ? observation.detail : undefined,
    ).toContain("Usage limit reached");
  });
});

describe("createClaudeAdapter", () => {
  /** A runner that records what it was asked to run and answers from a script. */
  const recording = (
    answers: Partial<Record<string, ProcessResult>> = {},
  ): { runner: ProcessRunner; specs: ProcessSpec[] } => {
    const specs: ProcessSpec[] = [];

    return {
      specs,
      runner: {
        run(spec: ProcessSpec): Promise<ProcessResult> {
          specs.push(spec);

          const key = spec.args.join(" ");

          return Promise.resolve(answers[key] ?? ran({ stdout: "{}" }));
        },
      },
    };
  };

  const context = (runner: ProcessRunner): AdapterContext => ({
    runner,
    workDir: "/tmp/neutral",
    now: 0,
  });

  it("asks for authentication status without consuming anything", async () => {
    const { runner, specs } = recording();
    const adapter = createClaudeAdapter();

    await adapter.inspectAuth(context(runner), {
      installed: true,
      executable: "/usr/local/bin/claude",
      health: "ok",
    });

    expect(specs[0]).toMatchObject({
      executable: "/usr/local/bin/claude",
      args: ["auth", "status", "--json"],
      cwd: "/tmp/neutral",
    });
  });

  it("activates with the tools and configuration switched off", async () => {
    // These flags are the containment. A change here changes what an
    // activation is allowed to touch on the user's machine.
    const { runner, specs } = recording();
    const adapter = createClaudeAdapter();

    await adapter.activate(
      context(runner),
      { installed: true, executable: "/usr/local/bin/claude", health: "ok" },
      { authenticated: true, mode: "subscription_local", supportsIntent: true },
    );

    expect(specs[0]?.args).toEqual([
      "-p",
      ACTIVATION_PROMPT,
      "--output-format",
      "json",
      "--restricted",
      "--strict-mcp-config",
    ]);
    expect(specs[0]?.cwd).toBe("/tmp/neutral");
  });

  it("uses the activation as its own availability check", () => {
    // Claude Code has no status command that reports usage, so probing
    // separately would mean paying for the answer twice.
    const adapter = createClaudeAdapter();

    expect(adapter.capabilities.probeMode).toBe("activation_is_probe");
    expect(Object.hasOwn(adapter, "probe")).toBe(false);
  });
});

describe("ACTIVATION_PROMPT", () => {
  it("asks for the least a provider can do", () => {
    expect(ACTIVATION_PROMPT.length).toBeLessThan(60);
  });
});
