import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, SecretStore, writeDefaultConfig } from "../packages/config/src/index.js";
import { capabilities, makeSession } from "../packages/drivers/src/common.js";
import { captureProcessIdentity } from "../packages/drivers/src/process-identity.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import {
  AgentWorkOrderSchema,
  DriverSessionSchema,
  type DriverDoctorResult,
  type DriverLifecycleOptions,
  type DriverSession,
  type DriverStartRequest,
  type ModelDescriptor,
  type WorkerDriver,
} from "../packages/protocol/src/index.js";
import { AgentCoordinator, ModelRouter, PassiveObserver } from "../packages/runtime/src/index.js";
import { createStore, type SymphonyStore } from "../packages/storage/src/index.js";

const temporary: string[] = [];
const stores: SymphonyStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

class NativeRunUpdatingCursorDriver implements WorkerDriver {
  readonly id = "cursor" as const;
  readonly capabilities = capabilities({ cloud: true });
  leaseId: string | null = null;

  async doctor(): Promise<DriverDoctorResult> {
    return { driver: this.id, available: true, authenticated: true, version: "fixture", capabilities: this.capabilities, detail: "fixture" };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: "fixture", harness: this.id, name: "Fixture", description: "Fixture", modalities: ["text"], structuredOutput: false, pricing: {}, metadata: {} }];
  }

  async start(request: DriverStartRequest, _onEvent: () => void, lifecycle?: DriverLifecycleOptions): Promise<DriverSession> {
    const supervisor = lifecycle?.processSupervisor;
    if (!supervisor) throw new Error("Fixture requires a process supervisor.");
    const lease = supervisor.reserveProcess({ role: "cursor-sdk-host", command: process.execPath, args: ["fixture"], cwd: request.workOrder.workspace.path, adapterVersion: "fixture:v1" });
    const identity = captureProcessIdentity(process.pid);
    if (!identity) throw new Error("Could not capture fixture process identity.");
    supervisor.attachProcess(lease.id, identity);
    this.leaseId = lease.id;
    return makeSession(this.id, `native-${request.agentId}`, { agentId: request.agentId, transportReusable: true }, "cursor-run-1");
  }

  async resume(session: DriverSession): Promise<DriverSession> {
    return session;
  }

  async sendMessage(session: DriverSession): Promise<{ receiptId: string; queued: boolean; session: DriverSession }> {
    return {
      receiptId: "cursor-native-receipt-2",
      queued: false,
      session: { ...session, nativeRunId: "cursor-run-2", state: "running" },
    };
  }

  async cancel(): Promise<void> {}
}

describe("durable native run updates", () => {
  it("persists a follow-up run identity to the agent, driver session, and process lease before delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-native-run-update-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.agents.maxConcurrent = null;
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    stores.push(store);
    const driver = new NativeRunUpdatingCursorDriver();
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.native-run-update-test", { platform: "linux", environment: {}, nativeBackend: null });
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    const order = AgentWorkOrderSchema.parse({
      id: "native-run-update-order",
      workflowId: "native-run-update-workflow",
      runId: "native-run-update-run",
      parentAgentId: null,
      depth: 0,
      mission: { id: "native-run-update-workflow", revision: 1, hash: "12345678", statement: "Persist native run changes.", keyResults: [] },
      objective: "Start a Cursor fixture.",
      harness: "cursor",
      model: "fixture",
      permissions: "full-access",
      outputSchema: {},
      workspace: { path: root, dirtyPolicy: "local-only" },
      inputs: [],
      metadata: {},
    });
    const agent = await coordinator.create(order);
    await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("running"));
    expect(coordinator.get(agent.id).nativeRunId).toBe("cursor-run-1");

    const receipt = await coordinator.message(agent.id, "Advance to the next native run.");
    expect(receipt).not.toHaveProperty("session");
    expect(coordinator.get(agent.id).nativeRunId).toBe("cursor-run-2");
    const persistedSession = DriverSessionSchema.parse(store.getMetadata(`driver-session:${agent.id}`));
    expect(persistedSession.nativeRunId).toBe("cursor-run-2");
    if (!driver.leaseId) throw new Error("Fixture process lease was not reserved.");
    const lease = store.getWorkerProcessLease(driver.leaseId);
    expect(lease?.nativeRunId).toBe("cursor-run-2");
    expect(lease?.activeTurnId).toBe("cursor-run-2");

    const sent = store.recentEvents({ agentId: agent.id, limit: 100 }).find((event) => event.type === "agent.message.sent");
    expect(sent?.payload).toMatchObject({ nativeRunId: "cursor-run-2" });
  });
});
