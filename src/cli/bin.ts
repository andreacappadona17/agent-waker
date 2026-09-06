#!/usr/bin/env node
/** The executable. Everything interesting is in `run`. */

import { createInterface } from "node:readline/promises";
import { homedir, platform } from "node:os";
import { realpath } from "node:fs/promises";

import { run } from "#src/cli/main.js";

const interactive = process.stdin.isTTY && process.stdout.isTTY;

/** Asks a question, showing the answer that will be used if none is given. */
async function ask(question: string, fallback: string): Promise<string> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await readline.question(`${question} (${fallback}) `);
  } finally {
    readline.close();
  }
}

// The scheduler records this path, so it has to be the real file rather than
// whichever symlink npm put on the PATH.
const entrypoint = await realpath(process.argv[1] ?? "").catch(
  () => process.argv[1] ?? "",
);

const exitCode = await run({
  argv: process.argv.slice(2),
  env: process.env,
  home: homedir(),
  platform: platform(),
  uid: process.getuid?.() ?? 0,
  isTty: process.stdout.isTTY,
  execPath: process.execPath,
  entrypoint,
  systemTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  now: () => Date.now(),
  write: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
  // Absent without a terminal, which is what makes every command scriptable.
  ...(interactive ? { ask } : {}),
});

// Set rather than called: an in-flight write to a pipe should still land.
process.exitCode = exitCode;
