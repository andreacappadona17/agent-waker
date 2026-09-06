#!/usr/bin/env node
/** The executable. Everything interesting is in `run`. */

import { homedir, platform } from "node:os";

import { run } from "#src/cli/main.js";

const exitCode = await run({
  argv: process.argv.slice(2),
  env: process.env,
  home: homedir(),
  platform: platform(),
  uid: process.getuid?.() ?? 0,
  isTty: process.stdout.isTTY,
  now: () => Date.now(),
  write: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
});

// Set rather than called: an in-flight write to a pipe should still land.
process.exitCode = exitCode;
