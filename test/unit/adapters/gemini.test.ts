import {
  readFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
  link,
  symlink,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  parseAuthStatus,
  parseActivation,
  createGeminiAdapter,
} from "#src/adapters/gemini.js";
import { completed } from "../../support/adapter-conformance.js";

// Source-synthetic v0.62.0 stderr; no live login is claimed.
const sentinel =
  '[ERROR] {"error":{"type":"FatalTurnLimitedError","message":"Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.","code":53}}';
it("validates native OAuth before any generation using the exact zero-turn sentinel", () => {
  expect(
    parseAuthStatus(completed({ exitCode: 53, stderr: sentinel })),
  ).toEqual({
    authenticated: true,
    mode: "subscription_local",
    supportsIntent: true,
  });
});
it.each([
  { truncated: { stdout: false, stderr: true } },
  { truncated: { stdout: true, stderr: false } },
  { timedOut: true },
  { signal: "SIGTERM" as const },
  { startFailure: "ENOENT" },
  { exitCode: 0 },
  { exitCode: 41 },
  { stderr: sentinel.replace('"code":53', '"code":41') },
  { stderr: sentinel.replace("FatalTurnLimitedError", "OtherError") },
  { stderr: sentinel.replace("Increase the number", "Change the number") },
  { stderr: sentinel.slice(0, -1) },
  { stderr: sentinel.slice(8) },
])("rejects incomplete or different auth evidence: %j", (change) => {
  expect(
    parseAuthStatus(completed({ exitCode: 53, stderr: sentinel, ...change }))
      .supportsIntent,
  ).toBe(false);
});

it("classifies the genuine historical quota bytes only inside a synthetic failed terminal envelope", async () => {
  const stderr = await readFile(
    join(
      import.meta.dirname,
      "../../fixtures/gemini/quota-23665-published.txt",
    ),
    "utf8",
  );
  // The reporter did not publish an exit status; 1 is explicitly synthetic.
  const observation = parseActivation(completed({ exitCode: 1, stderr }));
  expect(observation).toMatchObject({
    kind: "blocked",
    reason: "quota",
    constraints: [{ type: "quota", confidence: "high" }],
  });
  expect(observation.kind === "blocked" && observation.detail).toContain(
    "8h42m34s",
  );
});
it("accepts current source-synthetic quota terminal errors but rejects capacity and stale diagnostics", () => {
  const quota =
    "You have exhausted your capacity on this model. Your quota will reset after 8h42m34s.";
  expect(
    parseActivation(
      completed({
        exitCode: 1,
        stdout: JSON.stringify({
          error: { type: "TerminalQuotaError", message: quota, code: 429 },
        }),
      }),
    ),
  ).toMatchObject({ kind: "blocked", reason: "quota" });
  for (const result of [
    completed({ stderr: "reason: QUOTA_EXHAUSTED" }),
    completed({
      exitCode: 1,
      stderr: "HTTP 429 TerminalQuotaError: model capacity exhausted",
    }),
    completed({
      exitCode: 1,
      stderr: "QUOTA_EXHAUSTED",
      truncated: { stdout: false, stderr: true },
    }),
    completed({ exitCode: null, signal: "SIGTERM", stderr: "QUOTA_EXHAUSTED" }),
  ])
    expect(parseActivation(result).kind).not.toBe("blocked");
});

it("contains the native zero-generation auth check in an empty dedicated profile cwd", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-adapter-"));
  const workDir = join(home, "work");
  await mkdir(workDir);
  try {
    const adapter = createGeminiAdapter();
    const auth = await adapter.inspectAuth(
      {
        providerHome: home,
        workDir,
        now: 0,
        runner: {
          async run(spec) {
            expect(spec.cwd).toBe(workDir);
            expect(await readdir(workDir)).toEqual([]);
            expect(spec.args).toEqual([
              "--prompt",
              "Respond with OK only.",
              "--output-format",
              "json",
              "--ignore-env",
              "-e",
              "none",
              "--allowed-mcp-server-names",
              expect.stringMatching(/^agent-waker-no-mcp-[0-9a-f-]{36}$/),
            ]);
            expect(spec.stdin).toBe("closed");
            expect(spec.env).toMatchObject({
              HOME: home,
              GEMINI_CLI_HOME: home,
              GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: "false",
              NO_BROWSER: "true",
              GEMINI_CLI_EXP_AGENT: "false",
            });
            const settings: unknown = JSON.parse(
              await readFile(join(home, ".gemini", "settings.json"), "utf8"),
            );
            expect(settings).toMatchObject({
              model: { maxSessionTurns: 0 },
              security: {
                auth: {
                  selectedType: "oauth-personal",
                  enforcedType: "oauth-personal",
                  useExternal: false,
                },
              },
              billing: { overageStrategy: "never" },
              privacy: { usageStatisticsEnabled: false },
              telemetry: { enabled: false, logPrompts: false },
              tools: {
                core: [],
                discoveryCommand: "",
                callCommand: "",
                sandbox: false,
              },
              skills: { enabled: false },
              hooksConfig: { enabled: false },
              experimental: {
                adk: { agentSessionNoninteractiveEnabled: false },
              },
            });
            expect(await readFile(join(home, ".env"), "utf8")).toBe("");
            return completed({ exitCode: 53, stderr: sentinel });
          },
        },
      },
      {
        installed: true,
        health: "ok",
        executable: "/fake/gemini",
        version: "0.62.0",
      },
    );
    expect(auth.supportsIntent).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it("registers Gemini for config selection and keeps existing installations opted out until enabled", async () => {
  const { defaultRegistry } = await import("#src/cli/context.js");
  const { parseConfig } = await import("#src/config/config.js");
  expect(defaultRegistry().get("gemini").displayName).toBe("Gemini CLI");
  expect(
    parseConfig("version: 1\ntimezone: UTC\n", "config.yaml").agents.gemini
      .enabled,
  ).toBe(false);
  expect(
    parseConfig(
      "version: 1\ntimezone: UTC\nagents:\n  gemini:\n    enabled: true\n",
      "config.yaml",
    ).agents.gemini.enabled,
  ).toBe(true);
});
it("resets dedicated native settings without reading embedded credentials or copying them", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-login-settings-"));
  const workDir = join(home, "work");
  await mkdir(workDir);
  await mkdir(join(home, ".gemini"));
  try {
    const settings = join(home, ".gemini", "settings.json");
    const adapter = createGeminiAdapter();
    let calls = 0;
    const mcpNames: string[] = [];
    const context = {
      providerHome: home,
      workDir,
      now: 0,
      runner: {
        run(spec: import("#src/process/runner.js").ProcessSpec) {
          calls++;
          mcpNames.push(String(spec.args.at(-1)));
          return Promise.resolve(completed({ exitCode: 53, stderr: sentinel }));
        },
      },
    };
    const detection = {
      installed: true,
      health: "ok" as const,
      version: "0.62.0",
    };
    await writeFile(
      settings,
      JSON.stringify({
        security: { auth: { selectedType: "oauth-personal" } },
      }),
    );
    expect((await adapter.inspectAuth(context, detection)).supportsIntent).toBe(
      true,
    );
    await writeFile(
      settings,
      JSON.stringify({
        security: { auth: { selectedType: "oauth-personal" } },
        tools: { discoveryCommand: "unwanted" },
        mcpServers: { remote: { env: { API_KEY: "must-not-be-read" } } },
      }),
    );
    expect((await adapter.inspectAuth(context, detection)).supportsIntent).toBe(
      true,
    );
    expect(calls).toBe(2);
    expect(new Set(mcpNames).size).toBe(2);
    expect(JSON.parse(await readFile(settings, "utf8"))).toMatchObject({
      security: { auth: { selectedType: "oauth-personal" } },
      tools: { discoveryCommand: "" },
      mcpServers: {},
    });
    expect(await readFile(settings, "utf8")).not.toContain("must-not-be-read");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it("refuses unsupported builds and ineligible auth before any process or profile writes", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-refusal-"));
  const workDir = join(home, "work");
  await mkdir(workDir);
  let calls = 0;
  const context = {
    providerHome: home,
    workDir,
    now: 0,
    runner: {
      run() {
        calls++;
        return Promise.resolve(completed());
      },
    },
  };
  const adapter = createGeminiAdapter();
  try {
    for (const version of ["0.61.0", "0.62.0-preview.1", "0.63.0", undefined]) {
      const detection = {
        installed: true,
        health: "ok" as const,
        ...(version === undefined ? {} : { version }),
      };
      expect(
        (await adapter.inspectAuth(context, detection)).supportsIntent,
      ).toBe(false);
      expect(
        (
          await adapter.activate(context, detection, {
            authenticated: true,
            mode: "subscription_local",
            supportsIntent: true,
          })
        ).kind,
      ).toBe("auth_error");
    }
    for (const mode of [
      "api_key",
      "cloud_provider",
      "unknown",
      "subscription_oauth_ci",
    ] as const)
      expect(
        (
          await adapter.activate(
            context,
            { installed: true, health: "ok", version: "0.62.0" },
            { authenticated: true, mode, supportsIntent: true },
          )
        ).kind,
      ).toBe("auth_error");
    expect(calls).toBe(0);
    expect(await readdir(home)).toEqual(["work"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("replaces hard-linked controls without altering or reading their external referent", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-controls-"));
  const workDir = join(home, "work");
  await mkdir(workDir);
  await mkdir(join(home, ".gemini"));
  const outside = join(home, "outside-secret");
  await writeFile(outside, "preserve-external-secret");
  try {
    for (const name of [".gemini/settings.json", ".env"])
      await link(outside, join(home, name));
    const result = await createGeminiAdapter().inspectAuth(
      {
        providerHome: home,
        workDir,
        now: 0,
        runner: {
          run() {
            return Promise.resolve(
              completed({ exitCode: 53, stderr: sentinel }),
            );
          },
        },
      },
      { installed: true, health: "ok", version: "0.62.0" },
    );
    expect(result.supportsIntent).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("preserve-external-secret");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("checks help safely before a dedicated work directory exists", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-smoke-"));
  try {
    const context = {
      providerHome: home,
      workDir: join(home, "work"),
      now: 0,
      runner: {
        async run(spec: import("#src/process/runner.js").ProcessSpec) {
          expect(await readdir(String(spec.cwd))).toEqual([]);
          expect(spec.env?.HOME).toBe(home);
          return completed({
            stdout:
              "--prompt --output-format --ignore-env -e --allowed-mcp-server-names",
          });
        },
      },
    };
    expect(
      await createGeminiAdapter().smokeTest(context, {
        installed: true,
        health: "ok",
        version: "0.62.0",
      }),
    ).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("requires native terminal success JSON even with exit zero and ignores stale quota diagnostics on success", () => {
  for (const stdout of [
    "",
    "malformed",
    "[]",
    '{"error":{"type":"TerminalQuotaError","message":"Your quota will reset after 8h42m34s."}}',
  ])
    expect(
      parseActivation(
        completed({ stdout, stderr: "reason: 'QUOTA_EXHAUSTED'" }),
      ).kind,
    ).toBe("unknown");
  expect(
    parseActivation(
      completed({
        stdout: '{"response":"A native answer"}',
        stderr: "reason: 'QUOTA_EXHAUSTED'",
      }),
    ),
  ).toEqual({ kind: "activated" });
});

it.each(["MEMORY.md", "GEMINI.md"])(
  "refuses native private %s before any provider startup, including legacy project migrations",
  async (filename) => {
    const home = await mkdtemp(join(tmpdir(), "gemini-private-memory-"));
    const workDir = join(home, "work");
    await mkdir(workDir);
    const detection = {
      installed: true,
      health: "ok" as const,
      version: "0.62.0",
    };
    const context = {
      providerHome: home,
      workDir,
      now: 0,
      runner: {
        run() {
          throw new Error("Private context must prevent startup");
        },
      },
    };
    try {
      // Native storage migrates sha256(cwd) to the registry-assigned slug.
      for (const project of [
        "work-92ef",
        createHash("sha256").update(workDir).digest("hex"),
      ]) {
        const memory = join(home, ".gemini", "tmp", project, "memory");
        await mkdir(memory, { recursive: true });
        await writeFile(join(memory, filename), "UNTRUSTED PRIVATE CONTEXT");
        expect(
          (await createGeminiAdapter().inspectAuth(context, detection))
            .supportsIntent,
        ).toBe(false);
        expect(
          await createGeminiAdapter().activate(context, detection, {
            authenticated: true,
            mode: "subscription_local",
            supportsIntent: true,
          }),
        ).toEqual({ kind: "runtime_error", category: "unknown" });
        await rm(join(home, ".gemini", "tmp", project), { recursive: true });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.each([
  ".gemini",
  ".gemini/tmp",
  ".gemini/tmp/work-92ef",
  ".gemini/tmp/work-92ef/memory",
  ".gemini/tmp/work-92ef/memory/MEMORY.md",
  ".gemini/tmp/work-92ef/memory/GEMINI.md",
])(
  "refuses private-memory alias %s without following its referent",
  async (alias) => {
    const home = await mkdtemp(join(tmpdir(), "gemini-memory-alias-"));
    const outside = await mkdtemp(join(tmpdir(), "gemini-memory-referent-"));
    const target = join(outside, "context");
    const destination = join(home, alias);
    const workDir = join(home, "work");
    await mkdir(workDir);
    try {
      if (alias.endsWith(".md"))
        await writeFile(target, "UNREAD PRIVATE CONTEXT");
      else await mkdir(target);
      await mkdir(join(destination, ".."), { recursive: true });
      await symlink(target, destination);
      expect(
        (
          await createGeminiAdapter().inspectAuth(
            {
              providerHome: home,
              workDir,
              now: 0,
              runner: {
                run() {
                  throw new Error(
                    "Aliased private memory must prevent startup",
                  );
                },
              },
            },
            { installed: true, health: "ok", version: "0.62.0" },
          )
        ).supportsIntent,
      ).toBe(false);
      if (alias.endsWith(".md"))
        expect(await readFile(target, "utf8")).toBe("UNREAD PRIVATE CONTEXT");
      else expect(await readdir(target)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  },
);

it("refuses inaccessible native runtime metadata instead of treating it as absent", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-memory-permissions-"));
  const workDir = join(home, "work");
  const runtime = join(home, ".gemini", "tmp");
  await mkdir(workDir);
  await mkdir(runtime, { recursive: true });
  try {
    await chmod(runtime, 0);
    expect(
      (
        await createGeminiAdapter().inspectAuth(
          {
            providerHome: home,
            workDir,
            now: 0,
            runner: {
              run() {
                throw new Error("Unknown private memory must prevent startup");
              },
            },
          },
          { installed: true, health: "ok", version: "0.62.0" },
        )
      ).supportsIntent,
    ).toBe(false);
  } finally {
    await chmod(runtime, 0o700);
    await rm(home, { recursive: true, force: true });
  }
});

it("retains ordinary provider credentials, registry and history while containing native memory", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-native-history-"));
  const workDir = join(home, "work");
  const native = join(home, ".gemini");
  const project = join(native, "tmp", "work-92ef");
  await mkdir(workDir);
  await mkdir(join(project, "chats"), { recursive: true });
  const retained = [
    join(native, "oauth_creds.json"),
    join(native, "projects.json"),
    join(project, "chats", "session.json"),
  ];
  try {
    for (const file of retained) {
      await writeFile(file, "PROVIDER OWNED CONTENT");
      await chmod(file, 0);
    }
    expect(
      (
        await createGeminiAdapter().inspectAuth(
          {
            providerHome: home,
            workDir,
            now: 0,
            runner: {
              run() {
                return Promise.resolve(
                  completed({ exitCode: 53, stderr: sentinel }),
                );
              },
            },
          },
          { installed: true, health: "ok", version: "0.62.0" },
        )
      ).supportsIntent,
    ).toBe(true);
    for (const file of retained) {
      await chmod(file, 0o600);
      expect(await readFile(file, "utf8")).toBe("PROVIDER OWNED CONTENT");
    }
  } finally {
    for (const file of retained) await chmod(file, 0o600);
    await rm(home, { recursive: true, force: true });
  }
});

it.each(["absent-system-settings.json", "absent-system-defaults.json"])(
  "refuses an existing redirected native scope %s without inspecting content",
  async (name) => {
    const home = await mkdtemp(join(tmpdir(), "gemini-system-scope-"));
    const workDir = join(home, "work");
    await mkdir(workDir);
    try {
      const scope = join(home, name);
      await writeFile(scope, "UNREAD SETTINGS");
      await chmod(scope, 0);
      expect(
        (
          await createGeminiAdapter().inspectAuth(
            {
              providerHome: home,
              workDir,
              now: 0,
              runner: {
                run() {
                  throw new Error("Existing system scope must prevent startup");
                },
              },
            },
            { installed: true, health: "ok", version: "0.62.0" },
          )
        ).supportsIntent,
      ).toBe(false);
      await chmod(scope, 0o600);
      expect(await readFile(scope, "utf8")).toBe("UNREAD SETTINGS");
      await rm(scope);
      await symlink(join(home, "missing-target"), scope);
      expect(
        (
          await createGeminiAdapter().inspectAuth(
            {
              providerHome: home,
              workDir,
              now: 0,
              runner: {
                run() {
                  throw new Error(
                    "Symlinked system scope must prevent startup",
                  );
                },
              },
            },
            { installed: true, health: "ok", version: "0.62.0" },
          )
        ).supportsIntent,
      ).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it("keeps zero-turn auth controls unchanged when activation overlaps the same native profile", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-profile-concurrent-"));
  const workDir = join(home, "work");
  await mkdir(workDir);
  let releaseAuth: () => void = () => undefined;
  let authStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    authStarted = resolve;
  });
  const delayed = new Promise<void>((resolve) => {
    releaseAuth = resolve;
  });
  const nativeTurns: number[] = [];
  const context = {
    providerHome: home,
    workDir,
    now: 0,
    runner: {
      async run(spec: import("#src/process/runner.js").ProcessSpec) {
        if (spec.timeoutMs === 30_000) {
          authStarted();
          await delayed;
        }
        const settings: unknown = JSON.parse(
          await readFile(join(home, ".gemini", "settings.json"), "utf8"),
        );
        if (
          settings === null ||
          typeof settings !== "object" ||
          !("model" in settings) ||
          settings.model === null ||
          typeof settings.model !== "object" ||
          !("maxSessionTurns" in settings.model) ||
          typeof settings.model.maxSessionTurns !== "number"
        )
          throw new Error("Native turn limit missing");
        nativeTurns.push(settings.model.maxSessionTurns);
        return settings.model.maxSessionTurns === 0
          ? completed({ exitCode: 53, stderr: sentinel })
          : completed({ stdout: '{"response":"GENERATED"}' });
      },
    },
  };
  const detection = {
    installed: true,
    health: "ok" as const,
    version: "0.62.0",
  };
  try {
    const pendingAuth = createGeminiAdapter().inspectAuth(context, detection);
    await started;
    const overlapping = await createGeminiAdapter().activate(
      context,
      detection,
      {
        authenticated: true,
        mode: "subscription_local",
        supportsIntent: true,
      },
    );
    releaseAuth();
    const auth = await pendingAuth;
    expect(nativeTurns).toEqual([0]);
    expect(auth.supportsIntent).toBe(true);
    expect(overlapping).toEqual({ kind: "runtime_error", category: "unknown" });
    expect(
      await createGeminiAdapter().activate(context, detection, {
        authenticated: true,
        mode: "subscription_local",
        supportsIntent: true,
      }),
    ).toEqual({ kind: "activated" });
    expect(nativeTurns).toEqual([0, 1]);
  } finally {
    releaseAuth();
    await rm(home, { recursive: true, force: true });
  }
});

it.each(["directory-symlink", "file-symlink", "file-hardlink"])(
  "refuses %s aliases for the shared profile lock without altering their referent",
  async (alias) => {
    const home = await mkdtemp(join(tmpdir(), "gemini-lock-alias-"));
    const outside = await mkdtemp(join(tmpdir(), "gemini-lock-referent-"));
    const controls = join(home, ".agent-waker-controls");
    const target = join(outside, "target");
    const workDir = join(home, "work");
    await mkdir(workDir);
    try {
      if (alias === "directory-symlink") {
        await mkdir(target);
        await symlink(target, controls);
      } else {
        await mkdir(controls);
        await writeFile(target, "RETAIN LOCK REFERENT");
        if (alias === "file-symlink")
          await symlink(target, join(controls, "lock"));
        else await link(target, join(controls, "lock"));
      }
      expect(
        (
          await createGeminiAdapter().inspectAuth(
            {
              providerHome: home,
              workDir,
              now: 0,
              runner: {
                run() {
                  throw new Error("Lock aliases must prevent startup");
                },
              },
            },
            { installed: true, health: "ok", version: "0.62.0" },
          )
        ).supportsIntent,
      ).toBe(false);
      if (alias === "directory-symlink")
        expect(await readdir(target)).toEqual([]);
      else expect(await readFile(target, "utf8")).toBe("RETAIN LOCK REFERENT");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  },
);
