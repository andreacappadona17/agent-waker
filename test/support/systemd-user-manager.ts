/** Real files at the external systemctl boundary, including native link collisions. */
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ProcessResult, ProcessRunner } from "#src/process/runner.js";

/** Native systemd v255/main bus-print-properties.c uses shell_maybe_quote(str, 0). */
export function systemdUnitPathOutput(paths: readonly string[]): string {
  const controls: Record<string, string> = {
    "\x07": "a",
    "\b": "b",
    "\f": "f",
    "\n": "n",
    "\r": "r",
    "\t": "t",
    "\v": "v",
  };
  return `${paths
    .map((path) =>
      // eslint-disable-next-line no-control-regex -- Model native systemd's quoting of control bytes.
      /[ "\\`$*?[\]'()<>|&;!\u0000-\u001f\u007f]/.test(path)
        ? // eslint-disable-next-line no-control-regex -- Model native systemd's escaping of control bytes.
          `"${path.replace(/["\\`$\u0000-\u001f\u007f]/g, (character) => {
            if ('"\\`$'.includes(character)) return `\\${character}`;
            return `\\${controls[character] ?? character.charCodeAt(0).toString(8).padStart(3, "0")}`;
          })}"`
        : path,
    )
    .join(" ")}\n`;
}

export function createSystemdUserManager(
  directory: string,
  options: {
    readonly missingDisableFails?: boolean;
    readonly retainLoadedUnits?: boolean;
  } = {},
): ProcessRunner {
  let active = false;
  const loadedUnits = new Set<string>();
  const result = (stdout = "", stderr = ""): ProcessResult => ({
    stdout,
    stderr,
    exitCode: stderr === "" ? 0 : 1,
    signal: null,
    timedOut: false,
    truncated: { stdout: false, stderr: false },
    durationMs: 1,
  });
  const present = async (path: string) => {
    try {
      return await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  return {
    async run(spec) {
      if (spec.args[0] === "--version") return result("v24.1.0\n");
      if (spec.executable === "/usr/bin/busctl") {
        if (spec.env?.DBUS_SESSION_BUS_ADDRESS !== undefined)
          return result(
            "",
            "The name org.freedesktop.systemd1 was not provided by any .service files",
          );
      }
      if (spec.args.includes("--property=UnitPath")) {
        const root = directory;
        return result(
          systemdUnitPathOutput([
            `${root}.control`,
            root,
            "/etc/systemd/user",
            "/usr/lib/systemd/user",
          ]),
        );
      }
      const [command, ...args] = spec.args.slice(1);
      const name = args.find((arg) => !arg.startsWith("--")) ?? "";
      const unit = join(directory, name);
      const wanted = join(directory, "timers.target.wants", name);
      switch (command) {
        case "is-system-running":
          return result("running\n");
        case "daemon-reload":
          loadedUnits.clear();
          return result();
        case "link":
          for (const path of args.filter((arg) => !arg.startsWith("--"))) {
            if (!(await present(path))?.isFile())
              return result("", "Unit link input must be a regular file");
            if (
              dirname(path) === directory ||
              dirname(path) ===
                (await realpath(directory).catch(() => directory))
            )
              continue;
            const target = join(directory, basename(path));
            const existing = await present(target);
            if (existing !== undefined) {
              if (!existing.isSymbolicLink())
                return result("", "Unit file already exists");
              if ((await realpath(target)) === (await realpath(path))) continue;
              if (!args.includes("--force"))
                return result("", "Unit link already exists");
              await rm(target);
            }
            await mkdir(directory, { recursive: true });
            await symlink(path, target);
          }
          return result();
        case "enable": {
          const fragment = await realpath(unit);
          const existing = await present(wanted);
          if (existing !== undefined) {
            if ((await realpath(wanted)) === fragment) return result();
            if (!existing.isSymbolicLink() || !args.includes("--force"))
              return result("", "Enable link already exists");
            await rm(wanted);
          }
          await mkdir(dirname(wanted), { recursive: true });
          await symlink(fragment, wanted);
          return result();
        }
        case "restart":
          await readFile(wanted, "utf8");
          await readFile(join(directory, "agent-waker.service"), "utf8");
          active = true;
          loadedUnits.add("agent-waker.timer");
          loadedUnits.add("agent-waker.service");
          return result();
        case "show": {
          if (
            args.includes(
              "--property=FragmentPath,DropInPaths,NeedDaemonReload",
            )
          )
            return result(
              // v255 retains the lookup filename, including an external link source.
              `FragmentPath=${(await present(unit)) ? (unit.includes("\n") ? "[unprintable]" : unit) : ""}\nDropInPaths=\nNeedDaemonReload=no\n`,
            );
          const loaded =
            (options.retainLoadedUnits === true && loadedUnits.has(name)) ||
            (await readFile(unit, "utf8").then(
              () => true,
              () => false,
            ));
          const enabled = (await present(wanted)) !== undefined;
          return result(
            `LoadState=${loaded ? "loaded" : "not-found"}\nActiveState=${active ? "active" : "inactive"}\nUnitFileState=${enabled ? "enabled" : "disabled"}\n`,
          );
        }
        case "stop":
          active = false;
          return result();
        case "clean":
          if (active) return result("", "Cannot clean an active timer");
          if (!(options.retainLoadedUnits === true && loadedUnits.has(name)))
            await readFile(unit, "utf8");
          return result();
        case "disable":
          if (options.missingDisableFails)
            for (const disabled of args)
              if (
                !(await readFile(join(directory, disabled), "utf8").then(
                  () => true,
                  () => false,
                ))
              )
                return result(
                  "",
                  `Failed to disable unit: Unit ${disabled} does not exist.`,
                );
          for (const disabled of args) {
            await rm(join(directory, "timers.target.wants", disabled), {
              force: true,
            });
            const path = join(directory, disabled);
            if ((await present(path))?.isSymbolicLink()) await rm(path);
          }
          return result();
        default:
          throw new Error(`Unexpected systemctl command: ${String(command)}`);
      }
    },
  };
}
