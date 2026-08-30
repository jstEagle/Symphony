import { startDaemon } from "../../apps/daemon/src/index.js";

const configPath = process.argv[2];
const rootDirectory = process.argv[3];
if (!configPath || !rootDirectory) throw new Error("Usage: daemon-process <config-path> <root-directory>");

const daemon = await startDaemon({ rootDirectory, configPath, noPlugins: true });
process.stdout.write(`${JSON.stringify({ type: "ready", pid: process.pid, port: daemon.loaded.config.server.port })}\n`);

let closing: Promise<void> | null = null;
const close = () => {
  closing ??= daemon.close().finally(() => process.exit(0));
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
