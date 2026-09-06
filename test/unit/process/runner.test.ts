import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createProcessRunner,
  DEFAULT_ENV_ALLOWLIST,
  TIMEOUTS,
} from "#src/process/runner.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-waker-proc-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const runner = createProcessRunner();

/** Runs a snippet of JavaScript as a real child process. */
const node = (
  source: string,
  overrides: Partial<Parameters<typeof runner.run>[0]> = {},
): ReturnType<typeof runner.run> =>
  runner.run({
    executable: process.execPath,
    args: ["-e", source],
    timeoutMs: 10_000,
    ...overrides,
  });

/** Waits for a process to disappear, so a kill can be asserted on. */
const waitForExit = async (pid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return false;
};

describe("run", () => {
  it("captures stdout and the exit code", async () => {
    const result = await node('process.stdout.write("hello")');

    expect(result).toMatchObject({
      stdout: "hello",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
  });

  it("captures stderr separately", async () => {
    expect(await node('process.stderr.write("uh oh")')).toMatchObject({
      stdout: "",
      stderr: "uh oh",
    });
  });

  it("reports a non-zero exit", async () => {
    expect(await node("process.exit(3)")).toMatchObject({ exitCode: 3 });
  });

  it("measures how long the process took", async () => {
    const result = await node("setTimeout(() => {}, 50)");

    expect(result.durationMs).toBeGreaterThanOrEqual(40);
  });

  it("reports an executable that is not there", async () => {
    // Discovery may have run minutes ago; the package can be gone by now.
    const result = await runner.run({
      executable: join(directory, "no-such-binary"),
      args: [],
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ startFailure: "ENOENT", exitCode: null });
  });

  it("reports a file that cannot be executed at all", async () => {
    // Executable bit set, but nothing the kernel can run: a truncated download,
    // or a native component the OS quarantined and replaced.
    const path = join(directory, "not-a-program");

    await writeFile(path, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
    await chmod(path, 0o755);

    const result = await runner.run({
      executable: path,
      args: [],
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ startFailure: "ENOEXEC", exitCode: null });
  });

  describe("stdin", () => {
    it("is closed by default, so nothing can hang waiting for input", async () => {
      const result = await node(
        'process.stdin.on("end", () => process.stdout.write("eof")); process.stdin.resume()',
        { timeoutMs: 5_000 },
      );

      expect(result).toMatchObject({ stdout: "eof", timedOut: false });
    });

    it("delivers text when a prompt has to be piped in", async () => {
      const result = await node(
        'let seen = ""; process.stdin.on("data", (c) => (seen += c)); process.stdin.on("end", () => process.stdout.write(seen))',
        { stdin: { text: "say hello" } },
      );

      expect(result.stdout).toBe("say hello");
    });
  });

  describe("timeouts", () => {
    it("stops a process that will not finish", async () => {
      const result = await node("setTimeout(() => {}, 60000)", {
        timeoutMs: 200,
      });

      expect(result).toMatchObject({ timedOut: true, exitCode: null });
      expect(result.signal).not.toBeNull();
    });

    it("keeps whatever the process managed to say", async () => {
      const result = await node(
        'process.stdout.write("partial"); setTimeout(() => {}, 60000)',
        { timeoutMs: 300 },
      );

      expect(result.stdout).toBe("partial");
      expect(result.timedOut).toBe(true);
    });

    it("takes the whole process group with it", async () => {
      // An npm wrapper spawns the real binary. Killing only the wrapper would
      // leave a provider process running against the user's quota.
      const marker = join(directory, "grandchild.pid");
      const result = await node(
        `const { spawn } = require("node:child_process");
         const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
         require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(child.pid));
         setTimeout(() => {}, 60000);`,
        { timeoutMs: 1_000 },
      );

      expect(result.timedOut).toBe(true);

      const grandchild = Number(await readFile(marker, "utf8"));

      expect(await waitForExit(grandchild)).toBe(true);
    });
  });

  describe("output caps", () => {
    it("stops a runaway process from filling memory", async () => {
      const result = await node(
        'for (let i = 0; i < 20000; i += 1) process.stdout.write("0123456789");',
        { maxStdoutBytes: 1_000 },
      );

      expect(result.stdout.length).toBeLessThanOrEqual(1_100);
      expect(result.truncated.stdout).toBe(true);
    });

    it("keeps the start and the end, which is where the diagnosis is", async () => {
      const result = await node(
        'process.stdout.write("START" + "x".repeat(50000) + "END");',
        { maxStdoutBytes: 1_000 },
      );

      expect(result.stdout.startsWith("START")).toBe(true);
      expect(result.stdout.endsWith("END")).toBe(true);
      expect(result.stdout).toContain("truncated");
    });

    it("caps stderr on its own budget", async () => {
      const result = await node('process.stderr.write("y".repeat(50000));', {
        maxStderrBytes: 500,
      });

      expect(result.truncated.stderr).toBe(true);
      expect(result.truncated.stdout).toBe(false);
    });

    it("leaves output under the cap untouched", async () => {
      const result = await node('process.stdout.write("small")', {
        maxStdoutBytes: 1_000,
      });

      expect(result.stdout).toBe("small");
      expect(result.truncated.stdout).toBe(false);
    });
  });

  describe("the environment", () => {
    const printEnv = "process.stdout.write(JSON.stringify(process.env))";

    const childEnv = async (
      overrides: Partial<Parameters<typeof runner.run>[0]> = {},
      base?: Readonly<Record<string, string | undefined>>,
    ): Promise<Record<string, string>> => {
      const configured = createProcessRunner(
        base === undefined ? {} : { env: base },
      );
      const result = await configured.run({
        executable: process.execPath,
        args: ["-e", printEnv],
        timeoutMs: 10_000,
        ...overrides,
      });

      return JSON.parse(result.stdout) as Record<string, string>;
    };

    it("passes through only what a provider CLI needs", async () => {
      const env = await childEnv(
        {},
        {
          PATH: "/usr/bin",
          HOME: "/Users/dev",
          ANTHROPIC_API_KEY: "must-not-be-passed",
          AWS_SECRET_ACCESS_KEY: "must-not-be-passed",
          SOME_PROJECT_FLAG: "must-not-be-passed",
        },
      );

      expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/Users/dev" });
      expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
      expect(env).not.toHaveProperty("SOME_PROJECT_FLAG");
    });

    it("does not smuggle an API key in as a subscription session", () => {
      // Product invariant: API-key execution cannot satisfy subscription
      // activation, so the key never reaches the child in the first place.
      for (const name of DEFAULT_ENV_ALLOWLIST) {
        expect(name).not.toMatch(/api[_-]?key|token|secret/i);
      }
    });

    it("lets an adapter add what it needs on top", async () => {
      const env = await childEnv(
        { env: { CLAUDE_CODE_NONINTERACTIVE: "1" } },
        { PATH: "/usr/bin" },
      );

      expect(env).toMatchObject({
        PATH: "/usr/bin",
        CLAUDE_CODE_NONINTERACTIVE: "1",
      });
    });
  });

  describe("argument handling", () => {
    it("never lets an argument reach a shell", async () => {
      // The one rule that keeps provider-supplied text from becoming a command.
      const hostile = "; touch /tmp/pwned; echo $(whoami) `id`";
      const result = await node("process.stdout.write(process.argv[1])", {
        args: ["-e", "process.stdout.write(process.argv[1])", hostile],
      });

      expect(result.stdout).toBe(hostile);
    });
  });

  it("runs where it is told to", async () => {
    // A neutral working directory is what keeps an activation from picking up
    // a repository's own agent instructions.
    const result = await node("process.stdout.write(process.cwd())", {
      cwd: directory,
    });

    // macOS resolves /var to /private/var, so compare the real paths.
    expect(result.stdout).toBe(await realpath(directory));
  });
});

describe("TIMEOUTS", () => {
  it("gives each kind of call a budget matched to its work", () => {
    expect(TIMEOUTS.detect).toBeLessThan(TIMEOUTS.probe);
    expect(TIMEOUTS.probe).toBeLessThan(TIMEOUTS.activate);
  });
});
