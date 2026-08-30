import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import { TEST_DAEMON_SECRET } from "./setup.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}

describe("plugin tool mutation idempotency", () => {
  it("caches settled results and never replays an outcome-unknown plugin side effect", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-plugin-idempotency-"));
    temporary.push(root);
    const port = await availablePort();
    const counterPath = join(root, "plugin-counter.txt");
    const pluginRoot = join(root, "plugins", "counter");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, "symphony.plugin.json"), JSON.stringify({
      id: "fixture.counter",
      name: "Counter fixture",
      version: "0.1.0",
      apiVersion: 1,
      entry: "index.ts",
      piCompatible: true,
      description: "Records each invocation as an externally visible side effect.",
    }));
    writeFileSync(join(pluginRoot, "index.ts"), `
      import { existsSync, readFileSync, writeFileSync } from "node:fs";
      const counterPath = ${JSON.stringify(counterPath)};
      export default function counterPlugin(api: { registerTool(tool: unknown): void }): void {
        api.registerTool({
          name: "increment_counter",
          description: "Increment a persistent counter.",
          execute: (argumentsValue: unknown) => {
            const current = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
            const count = current + 1;
            writeFileSync(counterPath, String(count));
            return { count, arguments: argumentsValue };
          },
        });
      }
    `);
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
      conductor: { harness: "codex", model: "fixture" },
      agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access", recoveryTimeoutMs: 5_000 },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { roots: ["plugins"], trusted: ["fixture.counter"], watch: false },
      workflows: { triggersEnabled: false },
    }));

    const base = `http://127.0.0.1:${port}`;
    const invoke = (key: string, argumentsValue: unknown) => fetch(`${base}/v1/plugin-tools/increment_counter`, {
      method: "POST",
      headers: {
        "connection": "close",
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify(argumentsValue),
    });

    process.env.SYMPHONY_DAEMON_SECRET = TEST_DAEMON_SECRET;
    const firstDaemon = await startDaemon({ rootDirectory: root, driverRegistry: new DriverRegistry() });
    let firstResult: unknown;
    try {
      const missingKey = await fetch(`${base}/v1/plugin-tools/increment_counter`, {
        method: "POST",
        headers: { "connection": "close", "content-type": "application/json" },
        body: "{}",
      });
      expect(missingKey.status).toBe(400);

      const first = await invoke("plugin:invoke:settled:1", { operation: "first" });
      expect(first.status).toBe(200);
      firstResult = await first.json();
      expect(firstResult).toEqual({
        pluginId: "fixture.counter",
        value: { count: 1, arguments: { operation: "first" } },
      });
      expect(await (await invoke("plugin:invoke:settled:1", { operation: "first" })).json()).toEqual(firstResult);
      expect(readFileSync(counterPath, "utf8")).toBe("1");
      expect((await invoke("plugin:invoke:settled:1", { operation: "different" })).status).toBe(409);
      expect(readFileSync(counterPath, "utf8")).toBe("1");

      // Simulate the only unsafe window: plugin code committed an external
      // side effect, but the daemon died before replacing its dispatch receipt.
      const registration = firstDaemon.plugins.getTool("increment_counter");
      expect(registration).not.toBeNull();
      await registration!.tool.execute({ operation: "ambiguous" });
      const createdAt = new Date().toISOString();
      expect(firstDaemon.store.claimCommandReceipt({
        idempotencyKey: "plugin:invoke:ambiguous:1",
        accepted: false,
        state: "dispatching",
        result: { commandType: "plugin.invoke", status: "outcome-unknown" },
        createdAt,
        updatedAt: createdAt,
      })).toBe(true);
      expect(readFileSync(counterPath, "utf8")).toBe("2");
    } finally {
      await firstDaemon.close();
    }

    process.env.SYMPHONY_DAEMON_SECRET = TEST_DAEMON_SECRET;
    const recoveredDaemon = await startDaemon({ rootDirectory: root, driverRegistry: new DriverRegistry() });
    try {
      const settledRetry = await invoke("plugin:invoke:settled:1", { operation: "first" });
      expect(settledRetry.status).toBe(200);
      expect(await settledRetry.json()).toEqual(firstResult);
      expect(readFileSync(counterPath, "utf8")).toBe("2");

      const ambiguousRetry = await invoke("plugin:invoke:ambiguous:1", { operation: "ambiguous" });
      expect(ambiguousRetry.status).toBe(409);
      expect(await ambiguousRetry.text()).toContain("will not replay it automatically");
      expect(readFileSync(counterPath, "utf8")).toBe("2");
    } finally {
      await recoveredDaemon.close();
    }
  });
});
