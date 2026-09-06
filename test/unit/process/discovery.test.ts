import {
  chmod,
  mkdir,
  writeFile,
  mkdtemp,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverExecutable } from "#src/process/discovery.js";
import { createProcessRunner } from "#src/process/runner.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-waker-discovery-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Writes an executable shell script and returns its path. */
const script = async (
  directory: string,
  name: string,
  body: string,
): Promise<string> => {
  await mkdir(directory, { recursive: true });

  const path = join(directory, name);

  await writeFile(path, body, "utf8");
  await chmod(path, 0o755);

  return path;
};

const working = (version = "1.2.3"): string => `#!/bin/sh\necho "${version}"\n`;

const discover = (
  env: Record<string, string | undefined>,
  options: { fallbackDirectories?: string[] } = {},
): ReturnType<typeof discoverExecutable> =>
  discoverExecutable("faketool", {
    runner: createProcessRunner({ env }),
    env,
    ...options,
  });

describe("discoverExecutable", () => {
  it("finds nothing when there is nothing to find", async () => {
    const result = await discover({ PATH: join(root, "empty"), HOME: root });

    expect(result).toMatchObject({
      installed: false,
      health: "unknown",
      candidates: [],
    });
    expect(result.selected).toBeUndefined();
  });

  it("finds an executable on PATH and reads its version", async () => {
    const bin = join(root, "bin");

    await script(bin, "faketool", working("2.4.1"));

    const result = await discover({ PATH: bin, HOME: root });

    expect(result).toMatchObject({
      installed: true,
      health: "healthy",
      version: "2.4.1",
    });
    expect(result.selected?.path).toBe(join(bin, "faketool"));
  });

  it("prefers the earlier PATH entry, as a shell would", async () => {
    const first = join(root, "first");
    const second = join(root, "second");

    await script(first, "faketool", working("1.0.0"));
    await script(second, "faketool", working("2.0.0"));

    const result = await discover({
      PATH: `${first}:${second}`,
      HOME: root,
    });

    expect(result.version).toBe("1.0.0");
    expect(result.candidates).toHaveLength(2);
  });

  it("ignores a PATH entry that is empty or not a directory", async () => {
    const bin = join(root, "bin");

    await script(bin, "faketool", working());
    await writeFile(join(root, "afile"), "", "utf8");

    const result = await discover({
      PATH: `::${join(root, "afile")}:${join(root, "absent")}:${bin}`,
      HOME: root,
    });

    expect(result.installed).toBe(true);
  });

  it("ignores a file that is not executable", async () => {
    const bin = join(root, "bin");

    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "faketool"), "not executable", "utf8");
    await chmod(join(bin, "faketool"), 0o644);

    expect((await discover({ PATH: bin, HOME: root })).installed).toBe(false);
  });

  it("records the resolved path behind a symlink", async () => {
    const real = join(root, "real");
    const bin = join(root, "bin");

    await script(real, "faketool", working());
    await mkdir(bin, { recursive: true });
    await symlink(join(real, "faketool"), join(bin, "faketool"));

    const result = await discover({ PATH: bin, HOME: root });

    expect(result.selected?.path).toBe(join(bin, "faketool"));
    expect(result.selected?.realPath).toContain("real/faketool");
  });

  describe("health", () => {
    it("reports a wrapper whose interpreter is gone as broken", async () => {
      // The npm wrapper whose Node is missing: the file is there and runnable
      // as far as the filesystem knows, and running it fails.
      const bin = join(root, "bin");

      await script(bin, "faketool", "#!/no/such/interpreter\n");

      const result = await discover({ PATH: bin, HOME: root });

      expect(result).toMatchObject({ installed: true, health: "broken" });
      expect(result.selected).toBeDefined();
    });

    it("reports a non-zero version check as broken", async () => {
      const bin = join(root, "bin");

      await script(bin, "faketool", "#!/bin/sh\nexit 1\n");

      expect((await discover({ PATH: bin, HOME: root })).health).toBe("broken");
    });

    it("passes over a broken candidate for a working one", async () => {
      const broken = join(root, "broken");
      const good = join(root, "good");

      await script(broken, "faketool", "#!/bin/sh\nexit 1\n");
      await script(good, "faketool", working("3.0.0"));

      const result = await discover({
        PATH: `${broken}:${good}`,
        HOME: root,
      });

      expect(result).toMatchObject({ health: "healthy", version: "3.0.0" });
      expect(result.selected?.path).toBe(join(good, "faketool"));
    });

    it("still names the candidate when every one of them is broken", async () => {
      // `doctor` needs to say which file it tried, not just that it failed.
      const bin = join(root, "bin");

      await script(bin, "faketool", "#!/bin/sh\nexit 1\n");

      const result = await discover({ PATH: bin, HOME: root });

      expect(result.selected?.path).toBe(join(bin, "faketool"));
    });

    it("takes the first line of a chatty version output", async () => {
      const bin = join(root, "bin");

      await script(
        bin,
        "faketool",
        '#!/bin/sh\necho "faketool 1.9.0 (build 42)"\necho "extra noise"\n',
      );

      expect((await discover({ PATH: bin, HOME: root })).version).toBe(
        "faketool 1.9.0 (build 42)",
      );
    });
  });

  describe("install hints", () => {
    it("recognises an npm layout", async () => {
      const target = join(root, "lib", "node_modules", "faketool", "bin");
      const bin = join(root, "bin");

      await script(target, "cli.js", working());
      await mkdir(bin, { recursive: true });
      await symlink(join(target, "cli.js"), join(bin, "faketool"));

      expect(
        (await discover({ PATH: bin, HOME: root })).selected?.installHint,
      ).toBe("npm");
    });

    it("recognises an nvm layout", async () => {
      const bin = join(root, ".nvm", "versions", "node", "v22.14.0", "bin");

      await script(bin, "faketool", working());

      expect(
        (await discover({ PATH: bin, HOME: root })).selected?.installHint,
      ).toBe("nvm");
    });

    it("recognises a homebrew layout", async () => {
      const cellar = join(
        root,
        "opt",
        "homebrew",
        "Cellar",
        "faketool",
        "1.0",
        "bin",
      );
      const bin = join(root, "bin");

      await script(cellar, "faketool", working());
      await mkdir(bin, { recursive: true });
      await symlink(join(cellar, "faketool"), join(bin, "faketool"));

      expect(
        (await discover({ PATH: bin, HOME: root })).selected?.installHint,
      ).toBe("homebrew");
    });

    it("calls a plain binary native", async () => {
      // No shebang means nothing interprets it, so nothing else can be missing.
      const bin = join(root, "bin");

      await mkdir(bin, { recursive: true });
      await writeFile(
        join(bin, "faketool"),
        Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
      );
      await chmod(join(bin, "faketool"), 0o755);

      expect(
        (await discover({ PATH: bin, HOME: root })).selected?.installHint,
      ).toBe("native");
    });
  });

  describe("the nvm fallback", () => {
    const nvmBin = (version: string): string =>
      join(root, ".nvm", "versions", "node", version, "bin");

    it("is not used while PATH has an answer", async () => {
      const bin = join(root, "bin");

      await script(bin, "faketool", working("1.0.0"));
      await script(nvmBin("v22.14.0"), "faketool", working("9.9.9"));

      const result = await discover({ PATH: bin, HOME: root });

      expect(result.version).toBe("1.0.0");
      expect(result.candidates).toHaveLength(1);
    });

    it("finds an install PATH does not know about", async () => {
      await script(nvmBin("v22.14.0"), "faketool", working("4.5.6"));

      const result = await discover({ PATH: join(root, "empty"), HOME: root });

      expect(result).toMatchObject({ installed: true, version: "4.5.6" });
    });

    it("compares versions as numbers, not as text", async () => {
      // v9 sorts after v10 lexically, which would pick the wrong runtime.
      await script(nvmBin("v9.11.2"), "faketool", working("old"));
      await script(nvmBin("v22.14.0"), "faketool", working("new"));

      expect(
        (await discover({ PATH: join(root, "empty"), HOME: root })).version,
      ).toBe("new");
    });

    it("prefers the version nvm calls default", async () => {
      await script(nvmBin("v20.1.0"), "faketool", working("the-default"));
      await script(nvmBin("v22.14.0"), "faketool", working("the-newest"));
      await mkdir(join(root, ".nvm", "alias"), { recursive: true });
      await writeFile(join(root, ".nvm", "alias", "default"), "20\n", "utf8");

      expect(
        (await discover({ PATH: join(root, "empty"), HOME: root })).version,
      ).toBe("the-default");
    });

    it("follows one level of alias indirection", async () => {
      await script(nvmBin("v20.1.0"), "faketool", working("the-lts"));
      await script(nvmBin("v22.14.0"), "faketool", working("the-newest"));
      await mkdir(join(root, ".nvm", "alias", "lts"), { recursive: true });
      await writeFile(
        join(root, ".nvm", "alias", "default"),
        "lts/iron\n",
        "utf8",
      );
      await writeFile(
        join(root, ".nvm", "alias", "lts", "iron"),
        "v20.1.0\n",
        "utf8",
      );

      expect(
        (await discover({ PATH: join(root, "empty"), HOME: root })).version,
      ).toBe("the-lts");
    });

    it("falls back to the newest when the alias names nothing installed", async () => {
      await script(nvmBin("v22.14.0"), "faketool", working("the-newest"));
      await mkdir(join(root, ".nvm", "alias"), { recursive: true });
      await writeFile(join(root, ".nvm", "alias", "default"), "18\n", "utf8");

      expect(
        (await discover({ PATH: join(root, "empty"), HOME: root })).version,
      ).toBe("the-newest");
    });
  });

  describe("adapter-supplied locations", () => {
    it("looks where the adapter says to look", async () => {
      const native = join(root, ".faketool", "bin");

      await script(native, "faketool", working("7.0.0"));

      const result = await discover(
        { PATH: join(root, "empty"), HOME: root },
        { fallbackDirectories: [native] },
      );

      expect(result.version).toBe("7.0.0");
    });

    it("still prefers PATH over them", async () => {
      const bin = join(root, "bin");
      const native = join(root, ".faketool", "bin");

      await script(bin, "faketool", working("on-path"));
      await script(native, "faketool", working("elsewhere"));

      const result = await discover(
        { PATH: bin, HOME: root },
        { fallbackDirectories: [native] },
      );

      expect(result.version).toBe("on-path");
    });
  });

  it("works when the environment has no PATH at all", async () => {
    expect((await discover({ HOME: root })).installed).toBe(false);
  });
});
