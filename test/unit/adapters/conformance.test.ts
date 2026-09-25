import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { defaultRegistry } from "#src/cli/context.js";
import { AGENT_IDS, type AgentId } from "#src/core/agent.js";
import {
  adapterConformance,
  completed,
  type AdapterConformanceFixture,
} from "../../support/adapter-conformance.js";

const fixture = (agent: AgentId, name: string): Promise<string> =>
  readFile(join(import.meta.dirname, "../../fixtures", agent, name), "utf8");

const subscription = {
  authenticated: true,
  mode: "subscription_local",
  supportsIntent: true,
} as const;
const signedOut = {
  authenticated: false,
  mode: "none",
  supportsIntent: false,
} as const;
const unsupported = {
  authenticated: true,
  mode: "unknown",
  supportsIntent: false,
} as const;

// Captured files are reused; inline responses are synthetic contract examples.
const fixtures: Record<AgentId, AdapterConformanceFixture> = {
  claude: {
    authArgs: ["auth", "status", "--json"],
    helpArgs: ["--help"],
    activationArgs: [
      "-p",
      "Respond with OK only.",
      "--output-format",
      "json",
      "--restricted",
      "--strict-mcp-config",
    ],
    help: await fixture("claude", "help.txt"),
    auth: {
      subscription: {
        response: completed({
          stdout: await fixture("claude", "auth-status-subscription.json"),
        }),
        expected: subscription,
      },
      signedOut: {
        response: completed({ stdout: '{"loggedIn":false}' }),
        expected: signedOut,
      },
      unsupported: {
        response: completed({
          stdout:
            '{"loggedIn":true,"authMethod":"console","apiProvider":"firstParty"}',
        }),
        expected: unsupported,
      },
    },
    success: completed({
      stdout: await fixture("claude", "activation-success.json"),
    }),
    blockedWithoutReset: {
      response: completed({
        exitCode: 1,
        stdout:
          '{"type":"result","is_error":true,"api_error_status":429,"result":"rate limit"}',
      }),
      expected: {
        kind: "blocked",
        reason: "rolling_window",
        constraints: [{ type: "rolling_window", confidence: "high" }],
      },
    },
    blockedWithReset: {
      unsupported: "The parsed result document has no reset timestamp.",
    },
  },
  codex: {
    authArgs: ["login", "status"],
    helpArgs: ["exec", "--help"],
    activationArgs: [
      "exec",
      "Respond with OK only.",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--ephemeral",
    ],
    help: await fixture("codex", "exec-help.txt"),
    auth: {
      subscription: {
        response: completed({
          stderr: await fixture("codex", "login-status-chatgpt.txt"),
        }),
        expected: subscription,
      },
      signedOut: { response: completed({ exitCode: 1 }), expected: signedOut },
      unsupported: {
        response: completed({ stderr: "Logged in using an API key" }),
        expected: unsupported,
      },
    },
    success: completed({ stdout: '{"type":"turn.completed"}\n' }),
    blockedWithoutReset: {
      response: completed({
        exitCode: 1,
        stdout: await fixture("codex", "activation-usage-limit.jsonl"),
      }),
      expected: {
        kind: "blocked",
        reason: "quota",
        constraints: [{ type: "quota", confidence: "high" }],
      },
    },
    blockedWithReset: {
      unsupported: "The captured clock time has no date or timezone.",
    },
  },
};

const adapters = defaultRegistry().list();

it("requires conformance fixtures for every registered adapter and agent", () => {
  expect(adapters.map((adapter) => adapter.id).sort()).toEqual(
    Object.keys(fixtures).sort(),
  );
  expect(Object.keys(fixtures).sort()).toEqual([...AGENT_IDS].sort());
});

for (const adapter of adapters)
  adapterConformance(adapter, fixtures[adapter.id]);
