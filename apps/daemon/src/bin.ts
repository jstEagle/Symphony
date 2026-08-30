#!/usr/bin/env node
import { startDaemon } from "./index.js";

const noPlugins = process.argv.includes("--no-plugins");
const daemon = await startDaemon({ noPlugins });
const url = `http://${daemon.loaded.config.server.host}:${daemon.loaded.config.server.port}`;
process.stdout.write(`Symphony daemon listening on ${url}\n`);

let closePromise: Promise<void> | null = null;
const close = (): Promise<void> => {
  // npm-compatible launchers may deliver both the terminal signal and a
  // forwarded copy. Absorb repeats until the daemon has durably released its
  // worker leases instead of allowing a second signal to terminate Node.
  closePromise ??= daemon.close().finally(() => process.exit(0));
  return closePromise;
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
