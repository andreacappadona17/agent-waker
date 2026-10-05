/**
 * Where everything lives.
 *
 * XDG on macOS as well as Linux, so the same instructions work on both and a
 * user who knows the convention already knows where to look. Every path is
 * derived here rather than assembled at each call site, because the scheduler
 * and the CLI have to agree about them exactly.
 */

import { realpath } from "node:fs/promises";
import { join, dirname, basename, relative, isAbsolute } from "node:path";

export interface Paths {
  /** The configuration file itself. */
  readonly config: string;
  readonly configDir: string;
  readonly stateDir: string;
  readonly logDir: string;
  readonly cacheDir: string;
  /** An empty directory for providers to run in. Disposable. */
  readonly workDir: string;
  /** Persistent Gemini-managed credentials, retained on uninstall. */
  readonly providerHome: string;
  /** Holds the launcher the native scheduler invokes. */
  readonly launcherDir: string;
}

const APPLICATION = "agent-waker";

/**
 * Reads one XDG variable.
 *
 * The specification says a relative value must be ignored, which matters here:
 * a scheduled process starts in a directory nobody chose.
 */
function xdg(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: string,
): string {
  const value = env[name];

  if (value === undefined) return fallback;

  return value.startsWith("/") ? value : fallback;
}

/** Works out every path from the environment and the user's home directory. */
export function resolvePaths(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): Paths {
  const configDir = join(
    xdg(env, "XDG_CONFIG_HOME", join(home, ".config")),
    APPLICATION,
  );
  const stateDir = join(
    xdg(env, "XDG_STATE_HOME", join(home, ".local", "state")),
    APPLICATION,
  );
  const cacheDir = join(
    xdg(env, "XDG_CACHE_HOME", join(home, ".cache")),
    APPLICATION,
  );
  const dataDir = join(
    xdg(env, "XDG_DATA_HOME", join(home, ".local", "share")),
    APPLICATION,
  );

  return {
    providerHome: join(home, ".agent-waker-gemini"),
    configDir,
    config: join(configDir, "config.yaml"),
    stateDir,
    // Inside the state directory: one place to inspect, one to delete.
    logDir: join(stateDir, "logs"),
    cacheDir,
    // Outside it: providers run here, so it has to be disposable on its own.
    workDir: join(cacheDir, "work"),
    launcherDir: join(dataDir, "bin"),
  };
}

/** Resolve existing ancestors too, so an XDG symlink cannot hide containment. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
}

/** A retained provider login must never sit under app cleanup targets. */
export async function assertProviderHomeOutsideCleanup(
  paths: Paths,
): Promise<void> {
  const home = await canonical(paths.providerHome);
  for (const root of [
    paths.configDir,
    paths.stateDir,
    paths.cacheDir,
    paths.workDir,
    paths.logDir,
    paths.launcherDir,
  ]) {
    const nested = relative(await canonical(root), home);
    if (
      nested === "" ||
      (nested !== ".." && !nested.startsWith("../") && !isAbsolute(nested))
    )
      throw new Error(
        "The provider profile overlaps an application cleanup directory. Move the XDG directories before continuing.",
      );
  }
}
