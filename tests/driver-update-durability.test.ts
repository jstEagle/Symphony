import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";
import { capabilities } from "../packages/drivers/src/common.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import { nowIso } from "../packages/protocol/src/index.js";
import { TEST_DAEMON_SECRET } from "./setup.js";
import type {
  DriverDoctorResult,
  ModelDescriptor,
  WorkerDriver,
} from "../packages/protocol/src/index.js";

const temporary: string[] = [];
const fixtureUpdater = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "driver-updater.mjs");

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

class UpdateDriver implements WorkerDriver {
  readonly id = "codex" as const;
  readonly capabilities = capabilities();

  async doctor(): Promise<DriverDoctorResult> {
    return {
      driver: this.id,
      available: true,
      authenticated: true,
      version: "1.0.0",
      capabilities: this.capabilities,
      detail: "Driver update durability fixture",
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }

  async start(): Promise<never> {
    throw new Error("The update fixture does not start agents.");
  }
}

describe("durable driver updates", () => {
  it("executes once across response loss and restart while fencing permissions, missing keys, collisions, and concurrent keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-driver-update-"));
    temporary.push(root);
    const counterPath = join(root, "update-count.txt");
    const startedPath = join(root, "update-started.txt");
    const firstPort = await availablePort();
    writeConfig(root, firstPort, counterPath, startedPath);

    const registry = new DriverRegistry();
    registry.register(new UpdateDriver());
    const firstDaemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: registry });
    const firstBase = `http://127.0.0.1:${firstPort}`;
    const key = "driver-update:codex:durable-1";
    try {
      const missingKey = await fetch(`${firstBase}/v1/drivers/codex/update`, { method: "POST" });
      expect(missingKey.status).toBe(400);

      const timestamp = nowIso();
      firstDaemon.store.saveAgent({
        id: "read-only-updater",
        logicalAgentId: "read-only-updater",
        workflowId: "chat:driver-update-test",
        runId: "chat-run:driver-update-test",
        parentAgentId: null,
        depth: 0,
        objective: "Attempt a forbidden driver update.",
        missionHash: "driver-update-test",
        requestedHarness: "codex",
        requestedModel: "fixture",
        harness: "codex",
        model: "fixture",
        permissions: "read-only",
        status: "waiting",
        nativeSessionId: null,
        nativeRunId: null,
        workspacePath: root,
        output: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: null,
        finishedAt: null,
      });
      const forbidden = await fetch(`${firstBase}/v1/drivers/codex/update`, {
        method: "POST",
        headers: {
          "idempotency-key": "driver-update:forbidden",
          "x-symphony-agent-id": "read-only-updater",
          "x-symphony-agent-token": firstDaemon.agents.tokenFor("read-only-updater"),
        },
      });
      expect(forbidden.status).toBe(403);

      const controller = new AbortController();
      const lostResponse = fetch(`${firstBase}/v1/drivers/codex/update`, {
        method: "POST",
        headers: { "idempotency-key": key },
        signal: controller.signal,
      }).catch((error: unknown) => error);
      await expect.poll(() => readCount(counterPath)).toBe(1);

      const concurrentSameKey = await fetch(`${firstBase}/v1/drivers/codex/update`, {
        method: "POST",
        headers: { "idempotency-key": key },
      });
      expect(concurrentSameKey.status).toBe(425);

      const concurrentOtherKey = await fetch(`${firstBase}/v1/drivers/codex/update`, {
        method: "POST",
        headers: { "idempotency-key": "driver-update:codex:durable-2" },
      });
      expect(concurrentOtherKey.status).toBe(409);
      expect(readCount(counterPath)).toBe(1);

      controller.abort();
      await lostResponse;
      await expect.poll(() => firstDaemon.store.getCommandReceipt(key)?.state).toBe("settled");
      expect(readCount(counterPath)).toBe(1);
    } finally {
      await firstDaemon.close();
    }

    const secondPort = await availablePort();
    writeConfig(root, secondPort, counterPath, startedPath);
    process.env.SYMPHONY_DAEMON_SECRET = TEST_DAEMON_SECRET;
    const secondRegistry = new DriverRegistry();
    secondRegistry.register(new UpdateDriver());
    const secondDaemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: secondRegistry });
    const secondBase = `http://127.0.0.1:${secondPort}`;
    try {
      const retry = await fetch(`${secondBase}/v1/drivers/codex/update`, {
        method: "POST",
        headers: { "idempotency-key": key },
      });
      expect(retry.status).toBe(200);
      await expect(retry.json()).resolves.toMatchObject({ output: "fixture updater completed" });
      expect(readCount(counterPath)).toBe(1);

      const collision = await fetch(`${secondBase}/v1/drivers/pi/update`, {
        method: "POST",
        headers: { "idempotency-key": key },
      });
      expect(collision.status).toBe(409);
      expect(readCount(counterPath)).toBe(1);
    } finally {
      await secondDaemon.close();
    }
  });

  it("does not infer recovery when the recorded target already equalled the baseline", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-driver-update-baseline-"));
    temporary.push(root);
    const port = await availablePort();
    const counterPath = join(root, "update-count.txt");
    const startedPath = join(root, "update-started.txt");
    writeConfig(root, port, counterPath, startedPath);
    const registry = new DriverRegistry();
    registry.register(new UpdateDriver());
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: registry });
    const key = "driver-update:codex:ambiguous-baseline";
    try {
      const createdAt = nowIso();
      daemon.store.claimCommandReceipt({
        idempotencyKey: key,
        accepted: false,
        state: "dispatching",
        result: { commandType: "driver.update", status: "outcome-unknown" },
        createdAt,
        updatedAt: createdAt,
      });
      daemon.store.setMetadata("driver-update-operation:codex", {
        version: 1,
        driver: "codex",
        idempotencyKey: key,
        state: "dispatching",
        baselineVersion: "1.0.0",
        targetVersion: "1.0.0",
        result: null,
        error: null,
        createdAt,
        updatedAt: createdAt,
      });
      const response = await fetch(`http://127.0.0.1:${port}/v1/drivers/codex/update`, {
        method: "POST",
        headers: { "idempotency-key": key },
      });
      expect(response.status).toBe(425);
      expect(readCount(counterPath)).toBe(0);
    } finally {
      await daemon.close();
    }
  });

  it("resumes a preparing operation after restart while allowing only one concurrent launcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-driver-update-preparing-"));
    temporary.push(root);
    const counterPath = join(root, "update-count.txt");
    const startedPath = join(root, "update-started.txt");
    const firstPort = await availablePort();
    writeConfig(root, firstPort, counterPath, startedPath);
    const key = "driver-update:codex:recovered-preparing";
    const firstRegistry = new DriverRegistry();
    firstRegistry.register(new UpdateDriver());
    const firstDaemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: firstRegistry });
    try {
      const createdAt = nowIso();
      const fingerprintKey = `command-fingerprint:${createHash("sha256").update(key).digest("hex")}`;
      const fingerprint = createHash("sha256").update(
        '{"actor":{"id":null,"type":"user"},"payload":{"driver":"codex"},"type":"driver.update"}',
      ).digest("hex");
      firstDaemon.store.durableTransaction(() => {
        firstDaemon.store.setMetadata(fingerprintKey, fingerprint);
        expect(firstDaemon.store.claimCommandReceipt({
          idempotencyKey: key,
          accepted: false,
          state: "dispatching",
          result: { commandType: "driver.update", status: "outcome-unknown" },
          createdAt,
          updatedAt: createdAt,
        })).toBe(true);
        firstDaemon.store.setMetadata("driver-update-operation:codex", {
          version: 1,
          driver: "codex",
          idempotencyKey: key,
          state: "preparing",
          baselineVersion: null,
          targetVersion: null,
          result: null,
          error: null,
          createdAt,
          updatedAt: createdAt,
        });
      });
    } finally {
      await firstDaemon.close();
    }

    const secondPort = await availablePort();
    writeConfig(root, secondPort, counterPath, startedPath);
    process.env.SYMPHONY_DAEMON_SECRET = TEST_DAEMON_SECRET;
    const secondRegistry = new DriverRegistry();
    secondRegistry.register(new UpdateDriver());
    const secondDaemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: secondRegistry });
    try {
      const base = `http://127.0.0.1:${secondPort}`;
      const responses = await Promise.all([
        fetch(`${base}/v1/drivers/codex/update`, {
          method: "POST",
          headers: { "idempotency-key": key },
        }),
        fetch(`${base}/v1/drivers/codex/update`, {
          method: "POST",
          headers: { "idempotency-key": key },
        }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 425]);
      expect(readCount(counterPath)).toBe(1);
      expect(secondDaemon.store.getCommandReceipt(key)?.state).toBe("settled");

      const retry = await fetch(`${base}/v1/drivers/codex/update`, {
        method: "POST",
        headers: { "idempotency-key": key },
      });
      expect(retry.status).toBe(200);
      await expect(retry.json()).resolves.toMatchObject({ output: "fixture updater completed" });
      expect(readCount(counterPath)).toBe(1);
    } finally {
      await secondDaemon.close();
    }
  });
});

function writeConfig(root: string, port: number, counterPath: string, startedPath: string): void {
  writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
    dataDirectory: ".symphony",
    server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
    conductor: { harness: "codex", model: "fixture" },
    agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access" },
    harnesses: {
      codex: { enabled: true }, claude: { enabled: false }, cursor: { enabled: false },
      opencode: { enabled: false }, pi: { enabled: false }, acp: [],
    },
    harnessUpdates: {
      checkIntervalMinutes: 10,
      harnesses: {
        codex: {
          command: process.execPath,
          args: [fixtureUpdater, counterPath, startedPath, "700"],
          latest: { source: "none" },
        },
        claude: { command: "claude", args: ["update"], latest: { source: "none" } },
        cursor: { command: "cursor-agent", args: ["update"], latest: { source: "none" } },
        opencode: { command: "opencode", args: ["upgrade"], latest: { source: "none" } },
        pi: { command: "pi", args: ["--version"], latest: { source: "none" } },
      },
    },
    router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
    observer: { provider: "deterministic" },
    plugins: { watch: false },
  }));
}

function readCount(path: string): number {
  try {
    return Number(readFileSync(path, "utf8")) || 0;
  } catch {
    return 0;
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}
