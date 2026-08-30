import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";
import { SecretStore } from "../packages/config/src/index.js";
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

function writeConfig(root: string, port: number): void {
  writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
    dataDirectory: ".symphony",
    server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
    conductor: { harness: "codex", model: "fixture" },
    agents: {
      maxDepth: null,
      maxConcurrent: null,
      defaultPermissions: "full-access",
      recoveryTimeoutMs: 30_000,
      recoveryConcurrency: 4,
    },
    harnesses: {
      codex: { enabled: true }, claude: { enabled: false }, cursor: { enabled: false },
      opencode: { enabled: false }, pi: { enabled: false }, acp: [],
    },
    router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
    observer: { provider: "deterministic" },
    uiUtilities: { provider: "deterministic", chatTitles: false },
    plugins: { watch: false },
    workflows: { triggersEnabled: false },
  }));
}

describe("durable chat thread creation", () => {
  it("binds one request key to one thread and conductor run across response loss and restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-thread-create-"));
    temporary.push(root);
    const port = await availablePort();
    writeConfig(root, port);
    const base = `http://127.0.0.1:${port}`;
    const key = "thread-create-restart-test";
    const body = JSON.stringify({ title: "Durable creation", workspacePath: root });
    const secrets = new SecretStore("dev.symphony.thread-create-tests", {
      platform: "linux",
      environment: { SYMPHONY_DAEMON_SECRET: TEST_DAEMON_SECRET },
      nativeBackend: null,
    });

    const firstDaemon = await startDaemon({
      rootDirectory: root,
      noPlugins: true,
      secretStore: secrets,
      credentialPlatform: "linux",
    });
    let firstThread: { id: string };
    try {
      const missingIdentity = await fetch(`${base}/v1/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(missingIdentity.status).toBe(400);

      const first = await fetch(`${base}/v1/threads`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body,
      });
      expect(first.status).toBe(201);
      firstThread = await first.json() as { id: string };

      const retry = await fetch(`${base}/v1/threads`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body,
      });
      expect(retry.status).toBe(201);
      await expect(retry.json()).resolves.toMatchObject(firstThread);
      expect(firstDaemon.store.listThreads({ includeArchived: true })).toHaveLength(1);
      expect(firstDaemon.store.listRuns()).toEqual([
        expect.objectContaining({ id: `chat-run:${firstThread.id}`, workflowId: `chat:${firstThread.id}` }),
      ]);

      const collision = await fetch(`${base}/v1/threads`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ title: "Different payload", workspacePath: root }),
      });
      expect(collision.status).toBe(409);
    } finally {
      await firstDaemon.close();
    }

    const restarted = await startDaemon({
      rootDirectory: root,
      noPlugins: true,
      secretStore: secrets,
      credentialPlatform: "linux",
    });
    try {
      const recovered = await fetch(`${base}/v1/threads`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body,
      });
      expect(recovered.status).toBe(201);
      await expect(recovered.json()).resolves.toMatchObject(firstThread);
      expect(restarted.store.listThreads({ includeArchived: true })).toHaveLength(1);
      expect(restarted.store.listRuns()).toEqual([
        expect.objectContaining({
          id: `chat-run:${firstThread.id}`,
          status: "running",
          error: null,
        }),
      ]);
      expect(restarted.store.recentEvents({
        runId: `chat-run:${firstThread.id}`,
        types: ["workflow.run.recovery-blocked"],
        limit: 10,
      })).toHaveLength(0);
    } finally {
      await restarted.close();
    }
  });

  it("rolls back the thread when conductor-run persistence throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-thread-create-rollback-"));
    temporary.push(root);
    const port = await availablePort();
    writeConfig(root, port);
    const daemon = await startDaemon({
      rootDirectory: root,
      noPlugins: true,
      secretStore: new SecretStore("dev.symphony.thread-create-rollback-test", {
        platform: "linux",
        environment: { SYMPHONY_DAEMON_SECRET: TEST_DAEMON_SECRET },
        nativeBackend: null,
      }),
      credentialPlatform: "linux",
    });
    const base = `http://127.0.0.1:${port}`;
    const key = "thread-create-rollback-test";
    const body = JSON.stringify({ title: "Atomic creation", workspacePath: root });
    try {
      vi.spyOn(daemon.store, "saveRun").mockImplementationOnce(() => {
        throw new Error("simulated run write failure");
      });
      const failed = await fetch(`${base}/v1/threads`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body,
      });
      expect(failed.status).toBe(500);
      expect(daemon.store.listThreads({ includeArchived: true })).toEqual([]);
      expect(daemon.store.listRuns()).toEqual([]);

      const retry = await fetch(`${base}/v1/threads`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body,
      });
      expect(retry.status).toBe(201);
      const thread = await retry.json() as { id: string };
      expect(daemon.store.listThreads({ includeArchived: true })).toEqual([
        expect.objectContaining({ id: thread.id, title: "Atomic creation" }),
      ]);
      expect(daemon.store.listRuns()).toEqual([
        expect.objectContaining({ id: `chat-run:${thread.id}` }),
      ]);
    } finally {
      await daemon.close();
    }
  });
});
