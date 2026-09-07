import { describe, expect, it } from "vitest";

import { editConfig } from "#src/config/edit.js";
import { parseConfig } from "#src/config/config.js";

const ANNOTATED = `# My agent waker configuration.
version: 1

# Where I actually live.
timezone: Europe/Rome

schedule:
  notBefore: "08:00" # a bit later on purpose

agents:
  claude:
    enabled: true
`;

describe("editConfig", () => {
  it("changes the value it was asked to change", () => {
    const edited = editConfig(ANNOTATED, [
      { path: ["schedule", "notBefore"], value: "07:00" },
    ]);

    expect(parseConfig(edited, "c.yaml").schedule.notBefore).toEqual({
      hour: 7,
      minute: 0,
    });
  });

  it("keeps the comments the user wrote", () => {
    // A config file is the user's document. Rewriting it from the parsed model
    // would silently delete everything they explained to themselves.
    const edited = editConfig(ANNOTATED, [
      { path: ["schedule", "notBefore"], value: "07:00" },
    ]);

    expect(edited).toContain("# My agent waker configuration.");
    expect(edited).toContain("# Where I actually live.");
    expect(edited).toContain("a bit later on purpose");
  });

  it("keeps a key it was not asked about", () => {
    const edited = editConfig(ANNOTATED, [
      { path: ["schedule", "notBefore"], value: "07:00" },
    ]);

    expect(edited).toContain("timezone: Europe/Rome");
  });

  it("refuses a file with a key the loader would reject", () => {
    // Consistent with loading: unknown keys are refused so a typo is loud
    // rather than silently doing nothing. Editing must not quietly bless a
    // file that would then fail to load.
    expect(() =>
      editConfig("version: 1\ntimezone: UTC\nfuture:\n  thing: 1\n", [
        { path: ["timezone"], value: "Europe/Rome" },
      ]),
    ).toThrow(/future/);
  });

  it("creates a section that is not there yet", () => {
    const edited = editConfig("version: 1\ntimezone: Europe/Rome\n", [
      { path: ["agents", "codex", "enabled"], value: false },
    ]);

    expect(parseConfig(edited, "c.yaml").agents.codex.enabled).toBe(false);
  });

  it("quotes a time so YAML does not read it as a number", () => {
    // Unquoted, `07:00` is a string in YAML 1.2 and the number 420 under 1.1
    // rules. Quoting means the file says the same thing to every reader.
    const edited = editConfig("version: 1\ntimezone: UTC\n", [
      { path: ["schedule", "notBefore"], value: "07:00" },
    ]);

    expect(edited).toContain('"07:00"');
  });

  it("applies several edits at once", () => {
    const edited = editConfig(ANNOTATED, [
      { path: ["schedule", "notBefore"], value: "06:45" },
      { path: ["timezone"], value: "America/New_York" },
    ]);
    const config = parseConfig(edited, "c.yaml");

    expect(config.timezone).toBe("America/New_York");
    expect(config.schedule.notBefore).toEqual({ hour: 6, minute: 45 });
  });

  it("refuses to write something the loader would reject", () => {
    // The file on disk must never be one this program cannot read back.
    expect(() =>
      editConfig(ANNOTATED, [{ path: ["timezone"], value: "Europe/Roma" }]),
    ).toThrow(/Europe\/Roma/);
  });

  it("refuses to edit a file that is already broken", () => {
    expect(() =>
      editConfig("version: 1\ntimezone: [", [
        { path: ["timezone"], value: "UTC" },
      ]),
    ).toThrow();
  });

  it("ends the file with a newline", () => {
    expect(
      editConfig("version: 1\ntimezone: UTC\n", [
        { path: ["timezone"], value: "Europe/Rome" },
      ]),
    ).toMatch(/\n$/);
  });
  it("creates a mapping where a key was written with no value", () => {
    // `claude:` with nothing after it parses as a null scalar, and `setIn`
    // refuses to descend into one.
    const edited = editConfig(
      "version: 1\ntimezone: Europe/Rome\nagents:\n  claude:\n",
      [{ path: ["agents", "claude", "enabled"], value: false }],
    );

    expect(parseConfig(edited, "config.yaml").agents.claude.enabled).toBe(
      false,
    );
  });

  it("refuses to edit through an alias rather than dropping what it held", () => {
    const source =
      "version: 1\ntimezone: Europe/Rome\nagents:\n  claude: &d\n    enabled: true\n  codex: *d\n";

    // Replacing the alias would silently discard whatever the anchor carried.
    expect(() =>
      editConfig(source, [
        { path: ["agents", "codex", "enabled"], value: false },
      ]),
    ).toThrow(/alias/);
  });
});
