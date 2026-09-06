/**
 * The one way this program starts another one.
 *
 * Everything a provider CLI does flows through here, so the rules that keep it
 * contained live in one place: arguments are passed as an array and never
 * through a shell, the environment is an allow-list rather than an inheritance,
 * stdin is closed unless something is being piped in, output is capped, and a
 * process that overruns its budget is killed along with anything it started.
 */

import { spawn, type ChildProcess } from "node:child_process";

/** Budgets from the architecture, matched to how much work each call does. */
export const TIMEOUTS = {
  detect: 10_000,
  probe: 30_000,
  activate: 120_000,
} as const;

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/** How long a process gets to exit politely before it is killed outright. */
const TERMINATE_GRACE_MS = 2_000;

/**
 * The environment a provider CLI is given.
 *
 * Deliberately free of anything resembling a credential. An API key reaching
 * the child would let paid API usage masquerade as subscription activation,
 * which is the one thing this product must never do quietly.
 */
// ponytail: macOS and Linux only, which is the supported platform. Windows
// would need SystemRoot and friends before anything would start at all.
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  // Finding and running the executable.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  // Text handling, so parsed output does not change shape by locale.
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  // Where providers keep their own configuration and session files.
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  // Reaching the network from behind a corporate proxy or a private CA.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

export interface ProcessSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Added on top of the allow-listed environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: "closed" | { readonly text: string };
  readonly timeoutMs: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Null when the process was killed or never started. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly truncated: { readonly stdout: boolean; readonly stderr: boolean };
  readonly durationMs: number;
  /** An errno such as `ENOENT`, when the process could not be started. */
  readonly startFailure?: string;
}

export interface ProcessRunner {
  run(spec: ProcessSpec): Promise<ProcessResult>;
}

export interface ProcessRunnerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly allow?: readonly string[];
}

/**
 * Collects output up to a cap, keeping the beginning and the end.
 *
 * The start says what was run and the end usually says why it failed, so both
 * are worth more than the middle of a runaway process's chatter.
 */
class CappedOutput {
  private readonly limit: number;
  private readonly half: number;
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private readonly tail: Buffer[] = [];
  private tailBytes = 0;
  private dropped = 0;

  constructor(limit: number) {
    this.limit = limit;
    this.half = Math.max(1, Math.floor(limit / 2));
  }

  add(chunk: Buffer): void {
    if (this.headBytes < this.half) {
      const room = this.half - this.headBytes;
      const taken = chunk.subarray(0, room);

      this.head.push(taken);
      this.headBytes += taken.length;

      if (chunk.length <= room) return;

      chunk = chunk.subarray(room);
    }

    this.tail.push(chunk);
    this.tailBytes += chunk.length;

    // Keep the deque bounded: the oldest chunk goes as soon as it is surplus.
    while (this.tail.length > 1) {
      const oldest = this.tail[0];

      if (oldest === undefined || this.tailBytes - oldest.length < this.half) {
        break;
      }

      this.dropped += oldest.length;
      this.tailBytes -= oldest.length;
      this.tail.shift();
    }
  }

  get truncated(): boolean {
    return this.dropped > 0 || this.headBytes + this.tailBytes > this.limit;
  }

  /** A cut can split a multi-byte character; decoding replaces the remnant. */
  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");

    return this.truncated
      ? `${head}\n… (truncated, ${String(this.dropped)} bytes dropped)\n${tail}`
      : head + tail;
  }
}

function buildEnv(
  base: Readonly<Record<string, string | undefined>>,
  allow: readonly string[],
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const name of allow) {
    const value = base[name];

    if (value !== undefined) env[name] = value;
  }

  return { ...env, ...extra };
}

/** Creates the runner every adapter shares. */
export function createProcessRunner(
  options: ProcessRunnerOptions = {},
): ProcessRunner {
  const { env: baseEnv = process.env, allow = DEFAULT_ENV_ALLOWLIST } = options;

  return {
    run(spec: ProcessSpec): Promise<ProcessResult> {
      const startedAt = Date.now();
      const stdout = new CappedOutput(
        spec.maxStdoutBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      );
      const stderr = new CappedOutput(
        spec.maxStderrBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      );
      const stdinText =
        typeof spec.stdin === "object" ? spec.stdin.text : undefined;

      let child: ChildProcess;

      try {
        child = spawn(spec.executable, [...spec.args], {
          ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
          env: buildEnv(baseEnv, allow, spec.env),
          // No shell, ever: an argument is an argument, never a fragment of a
          // command line something else will parse.
          shell: false,
          // Its own process group, so a wrapper that spawns the real binary
          // cannot leave that binary running against the user's quota.
          detached: true,
          stdio: [stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
      } catch (error) {
        // Some failures arrive synchronously rather than as an error event —
        // a file that is executable but not in any format the kernel can run,
        // which is what a truncated download looks like. A scheduler must
        // classify that, not crash on it.
        return Promise.resolve({
          stdout: "",
          stderr: "",
          exitCode: null,
          signal: null,
          timedOut: false,
          truncated: { stdout: false, stderr: false },
          durationMs: Date.now() - startedAt,
          startFailure: (error as NodeJS.ErrnoException).code ?? "SPAWN_FAILED",
        });
      }

      return new Promise<ProcessResult>((resolve) => {
        let timedOut = false;
        let settled = false;

        const killGroup = (signal: NodeJS.Signals): void => {
          if (child.pid === undefined) return;

          try {
            // Negative pid addresses the group rather than the leader alone.
            process.kill(-child.pid, signal);
          } catch {
            // Already gone, which is the outcome we wanted anyway.
          }
        };

        const graceTimer = setTimeout(() => {
          killGroup("SIGKILL");
        }, spec.timeoutMs + TERMINATE_GRACE_MS);
        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          killGroup("SIGTERM");
        }, spec.timeoutMs);

        const finish = (
          extra: Pick<ProcessResult, "exitCode" | "signal"> & {
            startFailure?: string;
          },
        ): void => {
          if (settled) return;

          settled = true;
          clearTimeout(timeoutTimer);
          clearTimeout(graceTimer);

          resolve({
            stdout: stdout.text(),
            stderr: stderr.text(),
            timedOut,
            truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
            durationMs: Date.now() - startedAt,
            ...extra,
          });
        };

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout.add(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr.add(chunk);
        });

        if (stdinText !== undefined) {
          child.stdin?.on("error", () => {
            // The child can exit before reading; that is not our failure.
          });
          child.stdin?.end(stdinText);
        }

        child.on("error", (error: NodeJS.ErrnoException) => {
          finish({
            exitCode: null,
            signal: null,
            startFailure: error.code ?? error.name,
          });
        });

        child.on("close", (code, signal) => {
          finish({ exitCode: code, signal });
        });
      });
    },
  };
}
