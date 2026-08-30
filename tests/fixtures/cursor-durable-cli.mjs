#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = new Set(process.argv.slice(2));

if (args.has("--version")) {
  process.stdout.write("cursor-agent fixture 1.0.0\n");
} else if (args.has("status")) {
  process.stdout.write("Authenticated as fixture@example.invalid\n");
} else if (args.has("--list-models")) {
  const root = process.env.SYMPHONY_CURSOR_FIXTURE_ROOT;
  if (root) {
    appendFileSync(join(root, ".fixture-cursor-model-environment"), `${JSON.stringify({
      cursorApiKey: process.env.CURSOR_API_KEY ?? null,
    })}\n`);
  }
  process.stdout.write("fixture-model - Cursor fixture model\n");
} else {
  process.stderr.write(`Unsupported Cursor fixture CLI invocation: ${process.argv.slice(2).join(" ")}\n`);
  process.exitCode = 2;
}
