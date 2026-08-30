import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, SecretStore, writeDefaultConfig } from "../packages/config/src/index.js";
import { capabilities, emit, makeSession } from "../packages/drivers/src/common.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import {
  AgentWorkOrderSchema,
  type DriverDoctorResult,
  type DriverEvent,
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

class RetirementDriver implements WorkerDriver {
  readonly id = "codex" as const;
  readonly capabilities = capabilities();
  forceTerminateCalls = 0;
  resumeCalls = 0;
  private consumer: ((event: DriverEvent) => void) | null = null;

  constructor(private readonly hangTermination = false) {}

  async doctor(): Promise<DriverDoctorResult> {
    return { driver: this.id, available: true, authenticated: true, version: "fixture", capabilities: this.capabilities, detail: "fixture" };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: "fixture", harness: this.id, name: "Fixture", description: "Fixture", modalities: ["text"], structuredOutput: false, pricing: {}, metadata: {} }];
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    this.consumer = onEvent;
    return makeSession(this.id, `native-${request.agentId}`, { agentId: request.agentId, transportReusable: true });
  }

  async resume(session: DriverSession, _request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    this.resumeCalls += 1;
    this.consumer = onEvent;
    return { ...session, state: "idle" };
  }

  async sendMessage(): Promise<{ receiptId: string; queued: boolean }> {
    return { receiptId: "fixture-receipt", queued: false };
  }

  async cancel(): Promise<void> {}

  async forceTerminate(): Promise<void> {
    this.forceTerminateCalls += 1;
    if (this.hangTermination) await new Promise<void>(() => undefined);
  }

  complete(): void {
    if (!this.consumer) throw new Error("Retirement fixture has not started.");
    emit(this.consumer, "output.completed", { structuredOutput: { done: true } });
    emit(this.consumer, "run.completed", { status: "finished" });
  }
}

function coordinatorFixture(
  root: string,
  store: SymphonyStore,
  driver: RetirementDriver,
  recoveryTimeoutMs = 30_000,
): AgentCoordinator {
  const loaded = loadConfig({ rootDirectory: root });
  loaded.config.router.provider = "neutral-lexical";
  loaded.config.observer.provider = "deterministic";
  loaded.config.agents.recoveryTimeoutMs = recoveryTimeoutMs;
  const drivers = new DriverRegistry();
  drivers.register(driver);
  const secrets = new SecretStore("dev.symphony.session-retirement-test", { platform: "linux", environment: {}, nativeBackend: null });
  return new AgentCoordinator(
    loaded,
    store,
    drivers,
    new ModelRouter(loaded, secrets, drivers, store),
    new PassiveObserver(loaded, secrets, store),
  );
}

function retirementWorkOrder(root: string, id: string) {
  return AgentWorkOrderSchema.parse({
    id,
    workflowId: "chat:retirement",
    runId: "chat-run:retirement",
    parentAgentId: null,
    depth: 0,
    mission: { id: "chat:retirement", revision: 1, hash: "12345678", statement: "Keep replacement cleanup durable.", keyResults: [] },
    objective: "Complete one conductor turn and retain its native session.",
    harness: "codex",
    model: "fixture",
    permissions: "full-access",
    outputSchema: {},
    workspace: { path: root, dirtyPolicy: "local-only" },
    inputs: [],
    metadata: { threadId: "retirement-thread" },
  });
}

describe("durable native-session retirement", () => {
  it("does not begin native retirement when the conductor swap transaction rolls back", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-session-retirement-rollback-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    const store = createStore(loaded.dataDirectory);
    stores.push(store);
    const driver = new RetirementDriver();
    const coordinator = coordinatorFixture(root, store, driver);
    const agent = await coordinator.create(retirementWorkOrder(root, "rollback-conductor"));
    await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("running"));
    driver.complete();
    await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("completed"));

    expect(() => store.durableTransaction(() => {
      expect(coordinator.prepareReusableSessionRetirement(agent.id, "chat-conductor-replaced")).toBe(true);
      throw new Error("simulate conductor swap rollback");
    })).toThrow("simulate conductor swap rollback");

    expect(store.getMetadata(`agent-session-retirement:${agent.id}`)).toBeNull();
    expect(driver.forceTerminateCalls).toBe(0);
    expect(coordinator.hasSession(agent.id)).toBe(true);
  });

  it("recovers a committed conductor retirement intent after the original daemon dies before termination settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-session-retirement-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    const store = createStore(loaded.dataDirectory);
    stores.push(store);

    const originalDriver = new RetirementDriver(true);
    const original = coordinatorFixture(root, store, originalDriver);
    const agent = await original.create(retirementWorkOrder(root, "retiring-conductor"));
    await vi.waitFor(() => expect(original.get(agent.id).status).toBe("running"));
    originalDriver.complete();
    await vi.waitFor(() => expect(original.get(agent.id).status).toBe("completed"));

    expect(original.retireReusableSession(agent.id, "chat-conductor-replaced")).toBe(true);
    await vi.waitFor(() => expect(originalDriver.forceTerminateCalls).toBe(1));
    expect(store.getMetadata(`agent-session-retirement:${agent.id}`)).toMatchObject({
      agentId: agent.id,
      nativeSessionId: `native-${agent.id}`,
      reason: "chat-conductor-replaced",
      state: "requested",
      attempts: 1,
    });

    // A replacement daemon uses the durable intent to include this otherwise
    // terminal agent in recovery, reattaches the exact session, and retries
    // termination instead of leaving the old native process orphaned.
    const replacementDriver = new RetirementDriver();
    const replacement = coordinatorFixture(root, store, replacementDriver);
    await replacement.recover();

    expect(replacementDriver.resumeCalls).toBe(1);
    expect(replacementDriver.forceTerminateCalls).toBe(1);
    expect(replacement.hasSession(agent.id)).toBe(false);
    expect(store.getMetadata(`agent-session-retirement:${agent.id}`)).toMatchObject({
      agentId: agent.id,
      nativeSessionId: `native-${agent.id}`,
      reason: "chat-conductor-replaced",
      state: "retired",
      attempts: 2,
      error: null,
    });
    const events = store.recentEvents({ agentId: agent.id, limit: 100 });
    expect(events.filter((event) => event.type === "agent.session.retirement-requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent.session.retired")).toHaveLength(1);
  });

  it("bounds a stuck retirement during recovery and retries the exact session on a later restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-session-retirement-timeout-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    const store = createStore(loaded.dataDirectory);
    stores.push(store);

    const originalDriver = new RetirementDriver(true);
    const original = coordinatorFixture(root, store, originalDriver);
    const agent = await original.create(retirementWorkOrder(root, "timeout-retiring-conductor"));
    await vi.waitFor(() => expect(original.get(agent.id).status).toBe("running"));
    originalDriver.complete();
    await vi.waitFor(() => expect(original.get(agent.id).status).toBe("completed"));
    expect(original.retireReusableSession(agent.id, "chat-conductor-replaced")).toBe(true);
    await vi.waitFor(() => expect(originalDriver.forceTerminateCalls).toBe(1));

    const stuckReplacementDriver = new RetirementDriver(true);
    const stuckReplacement = coordinatorFixture(root, store, stuckReplacementDriver, 25);
    const recoveryStartedAt = Date.now();
    await stuckReplacement.recover();
    expect(Date.now() - recoveryStartedAt).toBeLessThan(1_000);
    expect(stuckReplacementDriver.resumeCalls).toBe(1);
    expect(stuckReplacementDriver.forceTerminateCalls).toBe(1);
    expect(stuckReplacement.hasSession(agent.id)).toBe(false);
    expect(store.getMetadata(`agent-session-retirement:${agent.id}`)).toMatchObject({
      agentId: agent.id,
      nativeSessionId: `native-${agent.id}`,
      state: "requested",
      attempts: 2,
      error: expect.stringContaining("timed out after 25ms"),
    });

    const successfulReplacementDriver = new RetirementDriver();
    const successfulReplacement = coordinatorFixture(root, store, successfulReplacementDriver, 250);
    await successfulReplacement.recover();
    expect(successfulReplacementDriver.resumeCalls).toBe(1);
    expect(successfulReplacementDriver.forceTerminateCalls).toBe(1);
    expect(store.getMetadata(`agent-session-retirement:${agent.id}`)).toMatchObject({
      agentId: agent.id,
      nativeSessionId: `native-${agent.id}`,
      state: "retired",
      attempts: 3,
      error: null,
    });
  });
});
