/**
 * Finds a provider's executable, and decides whether it actually runs.
 *
 * A provider CLI can arrive by native installer, Homebrew, npm, or npm under a
 * version manager, and the same machine can hold several at once. Finding the
 * file is the easy half; the half that matters is noticing that the file found
 * is a wrapper whose runtime has been upgraded out from under it, because that
 * looks like a provider failure and is not one.
 *
 * Nothing here installs, repairs or modifies anything. Discovery reads.
 */

import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import { TIMEOUTS, type ProcessRunner } from "#src/process/runner.js";

/** How the executable appears to have been installed, for remediation advice. */
export type InstallHint = "native" | "homebrew" | "npm" | "nvm" | "unknown";

export type ExecutableHealth = "healthy" | "broken" | "unknown";

export interface ExecutableCandidate {
  /** Where it was found, which is the name a user would recognise. */
  readonly path: string;
  /** With symlinks resolved, which is what says how it was installed. */
  readonly realPath: string;
  readonly installHint: InstallHint;
}

export interface ExecutableDiscovery {
  readonly installed: boolean;
  /** The candidate that ran, or the best one tried if none did. */
  readonly selected?: ExecutableCandidate;
  /** Everything found, in preference order. `doctor` shows these. */
  readonly candidates: readonly ExecutableCandidate[];
  readonly version?: string;
  readonly health: ExecutableHealth;
}

export interface DiscoveryOptions {
  readonly runner: ProcessRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Provider-specific places to look once PATH has come up empty. */
  readonly fallbackDirectories?: readonly string[];
  readonly versionArgs?: readonly string[];
  readonly timeoutMs?: number;
}

// ponytail: at most this many candidates are actually executed. Each costs a
// spawn and a timeout, and a machine with a dozen Node versions should not turn
// a tick into a minute of subprocesses. Raise it if a real layout needs more.
const MAX_PROBED_CANDIDATES = 4;

const NVM_VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)/;

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;

    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether the file starts with a shebang, and so needs an interpreter. */
async function hasShebang(path: string): Promise<boolean> {
  try {
    const contents = await readFile(path);

    return contents.subarray(0, 2).toString("latin1") === "#!";
  } catch {
    return false;
  }
}

async function hintFor(realPath: string): Promise<InstallHint> {
  if (realPath.includes("/.nvm/versions/node/")) return "nvm";
  if (realPath.includes("/node_modules/")) return "npm";
  if (realPath.includes("/homebrew/") || realPath.includes("/Cellar/")) {
    return "homebrew";
  }

  // Nothing interprets a plain binary, so nothing else can go missing under it.
  return (await hasShebang(realPath)) ? "unknown" : "native";
}

async function candidateAt(
  directory: string,
  name: string,
): Promise<ExecutableCandidate | undefined> {
  const path = join(directory, name);

  if (!(await isExecutableFile(path))) return undefined;

  const resolved = await realpath(path).catch(() => path);

  return { path, realPath: resolved, installHint: await hintFor(resolved) };
}

/** Every directory on PATH, in order, skipping the entries a shell would. */
function pathDirectories(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return (env.PATH ?? "").split(":").filter((entry) => entry !== "");
}

/** Reads the version nvm calls default, following one level of alias. */
async function nvmDefaultAlias(nvmDir: string): Promise<string | undefined> {
  const read = async (name: string): Promise<string | undefined> => {
    const text = await readFile(join(nvmDir, "alias", name), "utf8").catch(
      () => undefined,
    );

    return text?.trim();
  };

  const target = await read("default");

  if (target === undefined) return undefined;

  // `default` often points at another alias, such as `lts/iron`. One hop is
  // enough for every layout nvm actually writes.
  return target.includes("/") ? await read(target) : target;
}

/** Orders installed Node versions the way nvm would, not the way strings sort. */
function byVersionDescending(a: string, b: string): number {
  const parse = (name: string): number[] => {
    const match = NVM_VERSION_PATTERN.exec(name);

    return match === null
      ? [0, 0, 0]
      : [Number(match[1]), Number(match[2]), Number(match[3])];
  };

  const left = parse(a);
  const right = parse(b);

  for (let part = 0; part < 3; part += 1) {
    const difference = (right[part] ?? 0) - (left[part] ?? 0);

    if (difference !== 0) return difference;
  }

  return 0;
}

/** Node versions under nvm, best guess at the user's own default first. */
async function nvmDirectories(home: string): Promise<string[]> {
  const nvmDir = join(home, ".nvm");
  const root = join(nvmDir, "versions", "node");
  const versions = await readdir(root).catch(() => []);

  if (versions.length === 0) return [];

  const ordered = versions.toSorted(byVersionDescending);
  const preferred = await nvmDefaultAlias(nvmDir);

  if (preferred !== undefined) {
    // The alias may be a bare major ("20"), a full version, or absent from
    // this machine, in which case the newest-first order stands.
    const index = ordered.findIndex(
      (version) =>
        version === preferred || version.startsWith(`v${preferred}.`),
    );

    if (index > 0) ordered.unshift(...ordered.splice(index, 1));
  }

  return ordered.map((version) => join(root, version, "bin"));
}

/**
 * Finds an executable and confirms it runs.
 *
 * Candidates are ranked before any of them is executed: PATH in its own order
 * first, then the places a version manager or an installer would have put one.
 * The first candidate whose version check succeeds is selected. If none
 * succeeds, the best candidate is still reported, because "this file is here
 * and will not run" is a different problem from "nothing is installed" and
 * needs different advice.
 */
export async function discoverExecutable(
  name: string,
  options: DiscoveryOptions,
): Promise<ExecutableDiscovery> {
  const {
    runner,
    env = process.env,
    fallbackDirectories = [],
    versionArgs = ["--version"],
    timeoutMs = TIMEOUTS.detect,
  } = options;

  const found: ExecutableCandidate[] = [];

  for (const directory of pathDirectories(env)) {
    const candidate = await candidateAt(directory, name);

    if (candidate !== undefined) found.push(candidate);
  }

  // Only when PATH has nothing: a version manager's copy is a fallback, never
  // an override of what the user's shell would actually run.
  if (found.length === 0) {
    const home = env.HOME ?? "";
    const directories = [
      ...(home === "" ? [] : await nvmDirectories(home)),
      ...fallbackDirectories,
    ];

    for (const directory of directories) {
      const candidate = await candidateAt(directory, name);

      if (candidate !== undefined) found.push(candidate);
    }
  }

  const [best] = found;

  if (best === undefined) {
    return { installed: false, candidates: [], health: "unknown" };
  }

  for (const candidate of found.slice(0, MAX_PROBED_CANDIDATES)) {
    const result = await runner.run({
      executable: candidate.path,
      args: [...versionArgs],
      timeoutMs,
    });

    if (result.exitCode === 0) {
      return {
        installed: true,
        selected: candidate,
        candidates: found,
        // A CLI may print a banner; the first line is the version line.
        version: result.stdout.trim().split("\n")[0]?.trim() ?? "",
        health: "healthy",
      };
    }
  }

  // Present but unusable. Naming the file is the whole point: it is what tells
  // a user their wrapper outlived its runtime.
  return {
    installed: true,
    selected: best,
    candidates: found,
    health: "broken",
  };
}
