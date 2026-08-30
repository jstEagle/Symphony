import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";
import { capabilities, makeSession } from "../packages/drivers/src/common.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import type {
  DriverDoctorResult,
  DriverSession,
  DriverStartRequest,
  ModelDescriptor,
  WorkerDriver,
} from "../packages/protocol/src/index.js";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}

class HangingDisposeDriver implements WorkerDriver {
  readonly id = "codex" as const;
  readonly capabilities = capabilities();

  async doctor(): Promise<DriverDoctorResult> {
    return { driver: this.id, available: true, authenticated: true, version: "fixture", capabilities: this.capabilities, detail: "fixture" };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: "fixture", harness: this.id, name: "Fixture", description: "fixture", modalities: ["text"], structuredOutput: false, pricing: {}, metadata: {} }];
  }

  async start(request: DriverStartRequest): Promise<DriverSession> {
    return makeSession(this.id, request.agentId);
  }

  async resume(session: DriverSession): Promise<DriverSession> {
    return session;
  }

  async sendMessage(): Promise<{ receiptId: string; queued: boolean }> {
    return { receiptId: "fixture", queued: false };
  }

  async cancel(): Promise<void> {}

  async dispose(): Promise<void> {
    await new Promise<void>(() => undefined);
  }
}

describe("daemon shutdown supervision", () => {
  it("coalesces concurrent close calls and bounds a hanging driver disposal", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-daemon-shutdown-"));
    const port = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out", shutdownTimeoutMs: 100 },
      conductor: { harness: "codex", model: "fixture" },
      harnesses: {
        codex: { enabled: true }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
    }));
    const drivers = new DriverRegistry();
    drivers.register(new HangingDisposeDriver());
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: drivers });

    const started = Date.now();
    const first = daemon.close();
    const second = daemon.close();
    expect(second).toBe(first);
    await first;
    expect(Date.now() - started).toBeLessThan(500);

    rmSync(root, { recursive: true, force: true });
  });
});
