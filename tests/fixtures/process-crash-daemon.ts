import { startDaemon } from "../../apps/daemon/src/index.js";
import { DriverRegistry } from "../../packages/drivers/src/registry.js";
import { ProcessCrashQueueDriver } from "./process-crash-queue-driver.js";

const configPath = process.argv[2];
const rootDirectory = process.argv[3];
if (!configPath || !rootDirectory) {
  throw new Error("Usage: process-crash-daemon <config-path> <root-directory>");
}

// This process is intentionally a very small boundary wrapper. The test owns
// its PID and may SIGKILL it; all durable state lives in the configured
// SQLite directory and any retained worker-host process is outside this PID.
const options = process.env.SYMPHONY_PROCESS_CRASH_QUEUE_FIXTURE === "1"
  ? (() => {
      const driverRegistry = new DriverRegistry();
      driverRegistry.register(new ProcessCrashQueueDriver(process.env.SYMPHONY_PROCESS_CRASH_QUEUE_ROOT ?? rootDirectory));
      return { driverRegistry };
    })()
  : {};
const daemon = await startDaemon({ rootDirectory, configPath, noPlugins: true, ...options });
process.stdout.write(`${JSON.stringify({ type: "ready", pid: process.pid, port: daemon.loaded.config.server.port })}\n`);

let closing: Promise<void> | null = null;
const close = () => {
  closing ??= daemon.close().finally(() => process.exit(0));
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
