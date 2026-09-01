import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";
import { SecretStore } from "../packages/config/src/index.js";
import { capabilities, emit, makeSession } from "../packages/drivers/src/common.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import type {
  DriverDoctorResult,
  DriverEvent,
  DriverSession,
  DriverStartRequest,
  ModelDescriptor,
  WorkerDriver,
} from "../packages/protocol/src/index.js";
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
    server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out", shutdownTimeoutMs: 250 },
    conductor: { harness: "codex", model: "fixture" },
    agents: { maxDepth: null, maxConcurrent: null, defaultPermissions: "full-access", recoveryTimeoutMs: 1_000 },
    harnesses: {
      codex: { enabled: true },
      claude: { enabled: false },
      cursor: { enabled: false },
      opencode: { enabled: false },
      pi: { enabled: false },
      acp: [],
    },
    router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
    observer: { provider: "deterministic" },
    plugins: { watch: false },
    workflows: { triggersEnabled: false },
  }));
}

function testSecretStore(): SecretStore {
  // startDaemon removes the process environment secret after resolving it.
  // Give every daemon generation its own captured test-only secret store so a
  // restart exercises durable recovery rather than macOS keychain state.
  return new SecretStore("dev.symphony.durability-objective-test", {
    platform: "linux",
    environment: { SYMPHONY_DAEMON_SECRET: TEST_DAEMON_SECRET },
    nativeBackend: null,
  });
}

/**
 * A deliberately boring native boundary: it never completes unless the test
 * releases an agent. That makes a browser disconnect/reload a real fault
 * injection rather than a race against a short fixture response.
 */
class DurableFixtureDriver implements WorkerDriver {
  readonly id = "codex" as const;
  readonly capabilities = capabilities();
  readonly startedAgentIds: string[] = [];
  readonly resumedAgentIds: string[] = [];
  cancelCalls = 0;
  private readonly consumers = new Map<string, (event: DriverEvent) => void>();

  async doctor(): Promise<DriverDoctorResult> {
    return {
      driver: this.id,
      available: true,
      authenticated: true,
      version: "fixture",
      capabilities: this.capabilities,
      detail: "Durability fault-injection fixture",
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{
      id: "fixture",
      harness: this.id,
      name: "Fixture",
      description: "Durability fault-injection fixture",
      modalities: ["text"],
      structuredOutput: true,
      pricing: {},
      metadata: {},
    }];
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    this.startedAgentIds.push(request.agentId);
    this.consumers.set(request.agentId, onEvent);
    emit(onEvent, "run.started", { agentId: request.agentId }, `start-${request.agentId}`);
    return makeSession(this.id, `native-${request.agentId}`, { agentId: request.agentId }, `native-run-${request.agentId}`);
  }

  async resume(session: DriverSession, _request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    const agentId = typeof session.metadata.agentId === "string"
      ? session.metadata.agentId
      : session.nativeSessionId.replace(/^native-/u, "");
    this.resumedAgentIds.push(agentId);
    this.consumers.set(agentId, onEvent);
    return { ...session, state: "running" };
  }

  async sendMessage(): Promise<{ receiptId: string; queued: boolean }> {
    return { receiptId: "fixture", queued: false };
  }

  async cancel(session: DriverSession): Promise<void> {
    this.cancelCalls += 1;
    const agentId = session.nativeSessionId.replace(/^native-/u, "");
    const consumer = this.consumers.get(agentId);
    if (consumer) emit(consumer, "run.cancelled", { status: "cancelled" }, `cancel-${agentId}`);
  }

  complete(agentId: string): void {
    const consumer = this.consumers.get(agentId);
    if (!consumer) throw new Error(`No fixture consumer for ${agentId}`);
    emit(consumer, "output.completed", { structuredOutput: { completed: true } }, `output-${agentId}`);
    emit(consumer, "run.completed", { status: "finished" }, `complete-${agentId}`);
  }
}

function workflowDefinition(root: string, id: string) {
  return {
    id,
    name: "Durable objective fixture",
    mission: { statement: "Keep the objective alive across a projection fault.", keyResults: ["The native work settles exactly once."] },
    workspace: { path: root, dirtyPolicy: "local-only" as const },
    output: "steps.work",
    steps: [{
      id: "work",
      type: "agent" as const,
      objective: "Continue this objective until the durable harness releases the work.",
      harness: "codex" as const,
      model: "fixture",
      permissions: "read-only" as const,
      outputSchema: {
        type: "object",
        properties: { completed: { type: "boolean" } },
        required: ["completed"],
        additionalProperties: false,
      },
    }],
  };
}

async function waitUntilReady(base: string): Promise<void> {
  await vi.waitFor(async () => {
    await expect(fetch(`${base}/health`).then((response) => response.json())).resolves.toMatchObject({ ok: true, status: "ready" });
  });
}

describe("durable objective projection faults", () => {
  it("keeps a daemon-owned workflow alive after the frontend event stream disconnects and reloads", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-objective-disconnect-"));
    temporary.push(root);
    const port = await availablePort();
    writeConfig(root, port);
    const driver = new DurableFixtureDriver();
    const registry = new DriverRegistry();
    registry.register(driver);
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: registry, secretStore: testSecretStore() });
    const base = `http://127.0.0.1:${port}`;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await waitUntilReady(base);
      const definition = workflowDefinition(root, "frontend-disconnect-objective");
      const registered = await fetch(`${base}/v1/workflows`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "register-disconnect-objective" },
        body: JSON.stringify(definition),
      });
      expect(registered.status).toBe(201);

      const stream = await fetch(`${base}/v1/events?projection=ui`);
      expect(stream.status).toBe(200);
      reader = stream.body?.getReader();
      expect(reader).toBeDefined();
      expect((await reader!.read()).done).toBe(false);

      const started = await fetch(`${base}/v1/workflows/${definition.id}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "start-disconnect-objective" },
        body: JSON.stringify({}),
      });
      expect(started.status).toBe(202);
      const run = await started.json() as { id: string; status: string };
      await vi.waitFor(() => expect(daemon.store.getRun(run.id)?.status).toBe("running"));
      await vi.waitFor(() => expect(driver.startedAgentIds).toHaveLength(1));
      const agentId = driver.startedAgentIds[0]!;
      await vi.waitFor(() => expect(daemon.store.getAgent(agentId)?.status).toBe("running"));

      // This is the frontend fault: the event projection disappears, but no
      // user cancellation command is sent to the daemon-owned work.
      await reader!.cancel();
      reader = undefined;
      const reloaded = await fetch(`${base}/v1/bootstrap`).then((response) => response.json()) as {
        cursor: number;
        runs: Array<{ id: string; status: string }>;
        agents: Array<{ id: string; runId: string; status: string }>;
      };
      expect(reloaded.runs).toContainEqual(expect.objectContaining({ id: run.id, status: "running" }));
      expect(reloaded.agents).toContainEqual(expect.objectContaining({ id: agentId, runId: run.id, status: "running" }));
      expect(driver.cancelCalls).toBe(0);

      driver.complete(agentId);
      await vi.waitFor(() => expect(daemon.store.getRun(run.id)?.status).toBe("completed"));
      const history = await fetch(`${base}/v1/runs/${run.id}/events?after=${reloaded.cursor}`).then((response) => response.json()) as {
        cursor: number;
        events: Array<{ id: string; cursor: number; type: string }>;
      };
      expect(history.events.map((event) => event.type)).toEqual(expect.arrayContaining(["workflow.step.completed", "workflow.run.completed"]));
      expect(history.events.every((event) => event.cursor > reloaded.cursor)).toBe(true);
      expect(history.cursor).toBeGreaterThan(reloaded.cursor);
    } finally {
      if (reader) await reader.cancel();
      await daemon.close();
    }
  });

  it("recovers a linked workflow without rewriting origin, authority, or the event cursor", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-objective-recovery-"));
    temporary.push(root);
    const port = await availablePort();
    writeConfig(root, port);
    const firstDriver = new DurableFixtureDriver();
    const firstRegistry = new DriverRegistry();
    firstRegistry.register(firstDriver);
    const firstDaemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: firstRegistry, secretStore: testSecretStore() });
    const base = `http://127.0.0.1:${port}`;
    let replacementDaemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      await waitUntilReady(base);
      const parentResponse = await fetch(`${base}/v1/agents`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "create-origin-parent" },
        body: JSON.stringify({
          id: "origin-parent-logical",
          workflowId: "chat:durable-origin-thread",
          runId: "chat-run:durable-origin-thread",
          parentAgentId: null,
          depth: 2,
          mission: { id: "chat:durable-origin-thread", revision: 1, hash: "12345678", statement: "Retain the linked objective authority.", keyResults: [] },
          objective: "Own the linked objective while its projection is offline.",
          harness: "codex",
          model: "fixture",
          permissions: "full-access",
          outputSchema: { type: "object", additionalProperties: true },
          workspace: { path: root, dirtyPolicy: "local-only" },
        }),
      });
      expect(parentResponse.status).toBe(202);
      const parent = await parentResponse.json() as { id: string };
      await vi.waitFor(() => expect(firstDaemon.store.getAgent(parent.id)?.status).toBe("running"));

      const definition = workflowDefinition(root, "linked-recovery-objective");
      const registered = await fetch(`${base}/v1/workflows`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "register-linked-objective" },
        body: JSON.stringify(definition),
      });
      expect(registered.status).toBe(201);
      const started = await fetch(`${base}/v1/workflows/${definition.id}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "start-linked-objective",
          "x-symphony-agent-id": parent.id,
          "x-symphony-agent-token": firstDaemon.agents.tokenFor(parent.id),
        },
        body: JSON.stringify({}),
      });
      expect(started.status).toBe(202);
      const run = await started.json() as {
        id: string;
        origin: { kind: string; threadId: string | null; parentRunId: string | null; parentAgentId: string | null; baseDepth: number; permissionCeiling: string };
      };
      expect(run.origin).toEqual({
        kind: "agent",
        threadId: "durable-origin-thread",
        parentRunId: "chat-run:durable-origin-thread",
        parentAgentId: parent.id,
        baseDepth: 2,
        permissionCeiling: "full-access",
      });
      await vi.waitFor(() => expect(firstDaemon.store.getRun(run.id)?.status).toBe("running"));
      await vi.waitFor(() => expect(firstDriver.startedAgentIds).toHaveLength(2));
      const childId = firstDriver.startedAgentIds.find((id) => id !== parent.id);
      expect(childId).toBeDefined();
      await vi.waitFor(() => expect(firstDaemon.store.getAgent(childId!)?.status).toBe("running"));
      const persistedRun = firstDaemon.store.getRun(run.id)!;
      const persistedChild = firstDaemon.store.getAgent(childId!)!;
      const persistedEvents = firstDaemon.store.recentEvents({ runId: run.id, types: ["workflow.run.started", "workflow.step.started"], limit: 10 });
      expect(persistedEvents).toHaveLength(2);
      const cursorBeforeRestart = firstDaemon.store.latestCursor();
      const idsBeforeRestart = persistedEvents.map((event) => ({ id: event.id, cursor: event.cursor }));

      // Closing the daemon destroys only the projection process. The durable
      // run, step attempt, native session identity, and authority receipt all
      // remain in SQLite for the replacement daemon to reconcile.
      await firstDaemon.close();
      const secondDriver = new DurableFixtureDriver();
      const secondRegistry = new DriverRegistry();
      secondRegistry.register(secondDriver);
      replacementDaemon = await startDaemon({ rootDirectory: root, noPlugins: true, driverRegistry: secondRegistry, secretStore: testSecretStore() });
      await waitUntilReady(base);

      expect(secondDriver.resumedAgentIds).toEqual(expect.arrayContaining([parent.id, childId]));
      expect(replacementDaemon.store.getRun(run.id)).toMatchObject({ origin: persistedRun.origin, status: "running" });
      expect(replacementDaemon.store.getAgent(childId!)).toMatchObject({
        id: childId,
        parentAgentId: parent.id,
        depth: 3,
        permissions: "read-only",
        status: "running",
        nativeSessionId: `native-${childId}`,
      });
      const recoveredEvents = replacementDaemon.store.recentEvents({ runId: run.id, types: ["workflow.run.started", "workflow.step.started"], limit: 10 });
      expect(recoveredEvents).toHaveLength(2);
      expect(recoveredEvents.map((event) => ({ id: event.id, cursor: event.cursor }))).toEqual(idsBeforeRestart);
      expect(replacementDaemon.store.latestCursor()).toBeGreaterThanOrEqual(cursorBeforeRestart);

      const resumedHistory = await fetch(`${base}/v1/runs/${run.id}/events?after=${cursorBeforeRestart}`).then((response) => response.json()) as {
        events: Array<{ id: string; cursor: number; type: string }>;
      };
      expect(resumedHistory.events.every((event) => event.cursor > cursorBeforeRestart)).toBe(true);
      expect(resumedHistory.events.some((event) => event.type === "workflow.run.started")).toBe(false);

      secondDriver.complete(childId!);
      await vi.waitFor(() => expect(replacementDaemon!.store.getRun(run.id)?.status).toBe("completed"));
      expect(replacementDaemon.store.recentEvents({ runId: run.id, types: ["workflow.step.completed", "workflow.run.completed"], limit: 10 })).toHaveLength(2);
      secondDriver.complete(parent.id);
      await vi.waitFor(() => expect(replacementDaemon!.store.getAgent(parent.id)?.status).toBe("completed"));
    } finally {
      if (replacementDaemon) await replacementDaemon.close();
      else await firstDaemon.close();
    }
  });
});
