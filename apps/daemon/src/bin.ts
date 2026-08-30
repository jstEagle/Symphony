#!/usr/bin/env node
import { startDaemon } from "./index.js";

const noPlugins = process.argv.includes("--no-plugins");
const daemon = await startDaemon({ noPlugins });
const url = `http://${daemon.loaded.config.server.host}:${daemon.loaded.config.server.port}`;
process.stdout.write(`Symphony daemon listening on ${url}\n`);

const close = async (): Promise<void> => {
  await daemon.close();
  process.exit(0);
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
