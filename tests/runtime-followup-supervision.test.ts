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

class FollowUpDriver implements WorkerDriver {
  readonly id = "codex" as const;
  readonly starts: string[] = [];
  readonly messages: Array<{ agentId: string; content: string }> = [];
  readonly cancels: string[] = [];
  readonly resumed: string[] = [];
  sendAttempts = 0;
  failNextMessage = false;
  completeNextMessageSynchronously = false;
  hangNextMessage = false;
  terminalBoundaryNextMessage = false;
  terminalBoundaryWithoutEventNextMessage = false;
  replayCompletedTurnOnResume = new Set<string>();
  private readonly consumers = new Map<string, (event: DriverEvent) => void>();

  constructor(
    private readonly resumedState: (agentId: string) => DriverSession["state"] = () => "idle",
    supportsSteering = true,
  ) {
    this.capabilities = capabilities({ steer: supportsSteering });
  }

  readonly capabilities: ReturnType<typeof capabilities>;

  async doctor(): Promise<DriverDoctorResult> {
    return { driver: this.id, available: true, authenticated: true, version: "fixture", capabilities: this.capabilities, detail: "fixture" };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: "fixture", harness: this.id, name: "Fixture", description: "Fixture", modalities: ["text"], structuredOutput: true, pricing: {}, metadata: {} }];
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    this.starts.push(request.agentId);
    const session = makeSession(this.id, `native-${request.agentId}`);
    this.consumers.set(session.nativeSessionId, onEvent);
    return session;
  }

  async resume(
    session: DriverSession,
    request: DriverStartRequest,
    onEvent: (event: DriverEvent) => void,
  ): Promise<DriverSession> {
    this.resumed.push(request.agentId);
    this.consumers.set(session.nativeSessionId, onEvent);
    if (this.replayCompletedTurnOnResume.has(request.agentId)) {
      emit(onEvent, "output.completed", { structuredOutput: { old: true } });
      emit(onEvent, "run.completed", { status: "previous-turn-finished" });
      return { ...session, state: "completed" };
    }
    return { ...session, state: this.resumedState(request.agentId) };
  }

  async sendMessage(session: DriverSession, content: string): Promise<{ receiptId: string; queued: boolean; terminalBoundary?: boolean }> {
    const agentId = String(session.metadata.agentId ?? session.nativeSessionId.replace(/^native-/u, ""));
    this.sendAttempts += 1;
    if (this.terminalBoundaryWithoutEventNextMessage) {
      this.terminalBoundaryWithoutEventNextMessage = false;
      return { receiptId: "terminal-boundary-without-event", queued: true, terminalBoundary: true };
    }
    if (this.terminalBoundaryNextMessage) {
      this.terminalBoundaryNextMessage = false;
      this.complete(agentId);
      return { receiptId: "terminal-boundary", queued: true, terminalBoundary: true };
    }
    this.messages.push({ agentId, content });
    if (this.completeNextMessageSynchronously) {
      this.completeNextMessageSynchronously = false;
      this.complete(agentId);
    }
    if (this.failNextMessage) {
      this.failNextMessage = false;
      throw new Error("fixture delivery transport failed");
    }
    if (this.hangNextMessage) {
      this.hangNextMessage = false;
      return await new Promise<{ receiptId: string; queued: boolean }>(() => undefined);
    }
    return { receiptId: `native-receipt-${this.messages.length}`, queued: false };
  }

  async cancel(session: DriverSession): Promise<void> {
    const agentId = String(session.metadata.agentId ?? session.nativeSessionId.replace(/^native-/u, ""));
    this.cancels.push(agentId);
    this.cancelled(agentId);
  }

  complete(agentId: string): void {
    const consumer = this.consumers.get(`native-${agentId}`);
    if (!consumer) throw new Error(`No event consumer for ${agentId}`);
    emit(consumer, "output.completed", { structuredOutput: { ok: true } });
    emit(consumer, "run.completed", { status: "finished" });
  }

  cancelled(agentId: string): void {
    const consumer = this.consumers.get(`native-${agentId}`);
    if (!consumer) throw new Error(`No event consumer for ${agentId}`);
    emit(consumer, "run.cancelled", { status: "cancelled" });
  }
}

function workOrder(root: string, id: string) {
  return AgentWorkOrderSchema.parse({
    id,
    workflowId: `workflow-${id}`,
    runId: `run-${id}`,
    parentAgentId: null,
    depth: 0,
    mission: { id: `workflow-${id}`, revision: 1, hash: "12345678", statement: "Exercise bounded follow-up turns.", keyResults: [] },
    objective: `Run ${id}.`,
    harness: "codex",
    model: "fixture",
    permissions: "read-only",
    outputSchema: {},
    workspace: { path: root, dirtyPolicy: "local-only" },
    inputs: [],
    metadata: {},
  });
}

function fixture(root: string, driver = new FollowUpDriver(), store = createStore(loadConfig({ rootDirectory: root }).dataDirectory)) {
  const loaded = loadConfig({ rootDirectory: root });
  loaded.config.agents.maxConcurrent = 1;
  loaded.config.agents.cancellationAcknowledgementTimeoutMs = 20;
  loaded.config.agents.cancellationTerminationGraceMs = 20;
  loaded.config.router.provider = "neutral-lexical";
  loaded.config.observer.provider = "deterministic";
  stores.push(store);
  const drivers = new DriverRegistry();
  drivers.register(driver);
  const secrets = new SecretStore("dev.symphony.follow-up-tests");
  const coordinator = new AgentCoordinator(
    loaded,
    store,
    drivers,
    new ModelRouter(loaded, secrets, drivers, store),
    new PassiveObserver(loaded, secrets, store),
  );
  return { coordinator, driver, store };
}

async function completedAgent(root: string, coordinator: AgentCoordinator, driver: FollowUpDriver, id: string) {
  const agent = await coordinator.create(workOrder(root, id));
  await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("running"));
  driver.complete(agent.id);
  await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("completed"));
  return agent;
}

describe("bounded durable follow-up turns", () => {
  it("records active-turn steering before native delivery and deduplicates the durable attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-steering-attempt-id-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const { coordinator, driver } = fixture(root);
    const agent = await coordinator.create(workOrder(root, "steering-attempt"));
    await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("running"));

    const first = await coordinator.message(
      agent.id,
      "Steer this active native turn once.",
      { attemptId: "mcp-steering-attempt-1" },
    );
    const retry = await coordinator.message(
      agent.id,
      "Steer this active native turn once.",
      { attemptId: "mcp-steering-attempt-1" },
    );

    expect(first).toEqual({ receiptId: "native-receipt-1", queued: false });
    expect(retry).toEqual(first);
    expect(driver.messages).toEqual([{ agentId: agent.id, content: "Steer this active native turn once." }]);
    expect(coordinator.messageAttempt(agent.id, "mcp-steering-attempt-1")).toMatchObject({
      kind: "steering",
      state: "delivered",
      attemptId: "mcp-steering-attempt-1",
      receiptId: "native-receipt-1",
      queued: false,
    });

    driver.complete(agent.id);
  });

  it("queues an in-flight follow-up when the native driver cannot steer", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-follow-up-no-steer-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const driver = new FollowUpDriver(() => "idle", false);
    const { coordinator } = fixture(root, driver);
    const agent = await coordinator.create(workOrder(root, "no-steer"));
    await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("running"));

    const receipt = await coordinator.message(agent.id, "Queue behind the active native turn.");
    expect(receipt).toEqual({ receiptId: expect.any(String), queued: true });
    expect(driver.messages).toHaveLength(0);
    expect(coordinator.get(agent.id).status).toBe("running");

    driver.complete(agent.id);
    await vi.waitFor(() => expect(driver.messages).toEqual([{
      agentId: agent.id,
      content: "Queue behind the active native turn.",
    }]));
  });

  it("keeps the authoritative native turn supervised when steering delivery is ambiguous", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-steering-delivery-unknown-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const { coordinator, driver, store } = fixture(root);
    const agent = await coordinator.create(workOrder(root, "steering-delivery-unknown"));
    await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("running"));
    driver.failNextMessage = true;

    await expect(coordinator.message(
      agent.id,
      "Attempt steering without orphaning the original turn.",
      { attemptId: "mcp-steering-unknown-1" },
    )).rejects.toThrow("fixture delivery transport failed");

    expect(coordinator.get(agent.id)).toMatchObject({ status: "running", error: null });
    expect(coordinator.hasSession(agent.id)).toBe(true);
    expect(coordinator.messageAttempt(agent.id, "mcp-steering-unknown-1")).toMatchObject({
      kind: "steering",
      state: "outcome-unknown",
      receiptId: null,
      queued: null,
      error: expect.stringContaining("delivery could not be proven"),
    });
    expect(store.recentEvents({ agentId: agent.id, limit: 100 })
      .filter((event) => event.type === "agent.message.delivery-unknown")).toHaveLength(1);

    driver.complete(agent.id);
    await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("completed"));
    expect(store.recentEvents({ agentId: agent.id, limit: 100 })
      .filter((event) => event.type === "agent.failed")).toHaveLength(0);
  });

  it("uses the caller attempt id as the durable follow-up identity and deduplicates retries", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-follow-up-attempt-id-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const { coordinator, driver, store } = fixture(root);
    const retained = await completedAgent(root, coordinator, driver, "attempt-id-retained");
    const blocker = await coordinator.create(workOrder(root, "attempt-id-blocker"));
    await vi.waitFor(() => expect(coordinator.get(blocker.id).status).toBe("running"));

    const first = await coordinator.message(
      retained.id,
      "Deliver this durable chat turn once.",
      { attemptId: "chat-message-attempt-1" },
    );
    const retry = await coordinator.message(
      retained.id,
      "Deliver this durable chat turn once.",
      { attemptId: "chat-message-attempt-1" },
    );

    expect(first).toEqual({ receiptId: "chat-message-attempt-1", queued: true });
    expect(retry).toEqual(first);
    expect(store.getMetadata(`agent-follow-up:${retained.id}`)).toMatchObject({
      attemptId: "chat-message-attempt-1",
      agentId: retained.id,
      content: "Deliver this durable chat turn once.",
      state: "queued",
    });

    driver.complete(blocker.id);
    await vi.waitFor(() => expect(driver.messages).toEqual([{
      agentId: retained.id,
      content: "Deliver this durable chat turn once.",
    }]));
    driver.complete(retained.id);
  });

  it("queues a retained-session turn behind the shared concurrency limit and holds the slot until terminal evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-follow-up-capacity-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const { coordinator, driver, store } = fixture(root);
    const retained = await completedAgent(root, coordinator, driver, "retained");
    const blocker = await coordinator.create(workOrder(root, "blocker"));
    await vi.waitFor(() => expect(coordinator.get(blocker.id).status).toBe("running"));

    const receipt = await coordinator.message(retained.id, "Continue with the next bounded turn.");
    expect(receipt).toMatchObject({ queued: true });
    expect(coordinator.get(retained.id).status).toBe("waiting");
    expect(driver.messages).toHaveLength(0);

    driver.complete(blocker.id);
    await vi.waitFor(() => expect(driver.messages).toEqual([{ agentId: retained.id, content: "Continue with the next bounded turn." }]));
    await vi.waitFor(() => expect(coordinator.get(retained.id).status).toBe("running"));

    const after = await coordinator.create(workOrder(root, "after-follow-up"));
    expect(coordinator.get(after.id).status).toBe("queued");
    driver.complete(retained.id);
    await vi.waitFor(() => expect(coordinator.get(after.id).status).toBe("running"));

    const eventTypes = store.recentEvents({ agentId: retained.id, limit: 100 }).map((event) => event.type);
    expect(eventTypes).toEqual(expect.arrayContaining(["agent.message.queued", "agent.message.dispatching", "agent.message.sent"]));
  });

  it("cancels a scheduler-queued follow-up without delivering native work", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-follow-up-cancel-queued-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const { coordinator, driver } = fixture(root);
    const retained = await completedAgent(root, coordinator, driver, "cancel-retained");
    const blocker = await coordinator.create(workOrder(root, "cancel-blocker"));
    await vi.waitFor(() => expect(coordinator.get(blocker.id).status).toBe("running"));
    await coordinator.message(retained.id, "This turn must never reach the harness.");

    await coordinator.cancel(retained.id);
    expect(coordinator.get(retained.id).status).toBe("cancelled");
    driver.complete(blocker.id);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(driver.messages).toHaveLength(0);
    expect(driver.cancels).toHaveLength(0);
  });

  it("releases the follow-up slot when cancellation wins a hanging delivery race", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-follow-up-cancel-dispatch-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const { coordinator, driver } = fixture(root);
    const retained = await completedAgent(root, coordinator, driver, "hanging-follow-up");
    driver.hangNextMessage = true;
    await coordinator.message(retained.id, "Hang during native delivery.");
    await vi.waitFor(() => expect(coordinator.get(retained.id).status).toBe("starting"));

    await coordinator.cancel(retained.id);
    expect(coordinator.get(retained.id).status).toBe("cancelled");
    const after = await coordinator.create(workOrder(root, "after-cancelled-follow-up"));
    await vi.waitFor(() => expect(coordinator.get(after.id).status).toBe("running"));
    expect(driver.cancels).toEqual([retained.id]);
  });

  it("installs the terminal waiter before native delivery and releases capacity after a synchronous completion", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-follow-up-synchronous-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const { coordinator, driver } = fixture(root);
    const retained = await completedAgent(root, coordinator, driver, "sync-retained");
    driver.completeNextMessageSynchronously = true;

    await coordinator.message(retained.id, "Complete synchronously.");
    await vi.waitFor(() => expect(coordinator.get(retained.id).status).toBe("completed"));
    const after = await coordinator.create(workOrder(root, "after-sync-follow-up"));
    await vi.waitFor(() => expect(coordinator.get(after.id).status).toBe("running"));
  });

  it("durably reroutes steering that lands after a native result but before projection acknowledgement", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-follow-up-terminal-boundary-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const { coordinator, driver, store } = fixture(root);
    const agent = await coordinator.create(workOrder(root, "terminal-boundary"));
    await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("running"));
    driver.terminalBoundaryNextMessage = true;

    const receipt = await coordinator.message(agent.id, "Do not append this behind the terminal result.");

    expect(receipt.queued).toBe(true);
    await vi.waitFor(() => expect(driver.messages).toEqual([{
      agentId: agent.id,
      content: "Do not append this behind the terminal result.",
    }]));
    await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("running"));
    const events = store.recentEvents({ agentId: agent.id, limit: 100 });
    expect(events.filter((event) => event.type === "driver.run.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent.message.queued")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent.message.sent")).toHaveLength(1);
    expect(driver.messages).toHaveLength(1);
  });

  it("requeues a scheduler follow-up when the driver reports a terminal boundary without delivering it", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-follow-up-dispatch-boundary-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const { coordinator, driver, store } = fixture(root);
    const retained = await completedAgent(root, coordinator, driver, "dispatch-boundary");
    driver.terminalBoundaryNextMessage = true;

    await coordinator.message(retained.id, "Deliver this exactly once after the boundary.");

    await vi.waitFor(() => expect(driver.messages).toEqual([{
      agentId: retained.id,
      content: "Deliver this exactly once after the boundary.",
    }]));
    await vi.waitFor(() => expect(coordinator.get(retained.id).status).toBe("running"));
    expect(driver.sendAttempts).toBe(2);
    expect(store.getMetadata<Record<string, unknown>>(`agent-follow-up:${retained.id}`)).toMatchObject({
      state: "delivered",
    });
    expect(store.recentEvents({ agentId: retained.id, limit: 100 }).filter((event) => event.type === "agent.message.boundary")).toHaveLength(1);
  });

  it("fails closed when a recovery continuation hits a terminal boundary before delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-follow-up-recovery-boundary-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const first = fixture(root);
    const agent = await first.coordinator.create(workOrder(root, "recovery-boundary"));
    await vi.waitFor(() => expect(first.coordinator.get(agent.id).status).toBe("running"));
    first.coordinator.quiesce();

    const secondStore = createStore(loadConfig({ rootDirectory: root }).dataDirectory);
    const secondDriver = new FollowUpDriver(() => "idle");
    secondDriver.terminalBoundaryWithoutEventNextMessage = true;
    const second = fixture(root, secondDriver, secondStore);
    await second.coordinator.recover();

    expect(second.coordinator.get(agent.id)).toMatchObject({
      status: "interrupted",
      error: expect.stringContaining("terminal result boundary"),
    });
    expect(secondDriver.messages).toHaveLength(0);
    expect(secondDriver.sendAttempts).toBe(1);
    expect(secondStore.getMetadata<Record<string, unknown>>(`agent-recovery:${agent.id}`)).toMatchObject({
      state: "failed",
      error: expect.stringContaining("not mark the undelivered continuation as running"),
    });
  });

  it("fails closed and releases capacity when follow-up delivery is ambiguous", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-follow-up-failed-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const { coordinator, driver, store } = fixture(root);
    const retained = await completedAgent(root, coordinator, driver, "failed-retained");
    driver.failNextMessage = true;

    await coordinator.message(retained.id, "Trigger an ambiguous transport failure.");
    await vi.waitFor(() => expect(coordinator.get(retained.id).status).toBe("interrupted"));
    expect(coordinator.get(retained.id).error).toContain("delivery could not be confirmed");
    const after = await coordinator.create(workOrder(root, "after-failed-follow-up"));
    await vi.waitFor(() => expect(coordinator.get(after.id).status).toBe("running"));
    expect(store.recentEvents({ agentId: retained.id, limit: 100 }).some((event) => event.type === "agent.interrupted")).toBe(true);
  });

  it("restores a durably queued follow-up once after daemon recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-follow-up-recovery-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const first = fixture(root);
    const retained = await completedAgent(root, first.coordinator, first.driver, "recovered-retained");
    const blocker = await first.coordinator.create(workOrder(root, "recovered-blocker"));
    await vi.waitFor(() => expect(first.coordinator.get(blocker.id).status).toBe("running"));
    await first.coordinator.message(retained.id, "Resume this queued turn exactly once.");
    expect(first.driver.messages).toHaveLength(0);
    first.coordinator.quiesce();

    const secondStore = createStore(loadConfig({ rootDirectory: root }).dataDirectory);
    const secondDriver = new FollowUpDriver((agentId) => agentId === blocker.id ? "running" : "idle");
    secondDriver.replayCompletedTurnOnResume.add(retained.id);
    const second = fixture(root, secondDriver, secondStore);
    await second.coordinator.recover();
    await second.coordinator.recover();
    expect(secondDriver.messages).toHaveLength(0);

    secondDriver.complete(blocker.id);
    await vi.waitFor(() => expect(secondDriver.messages).toEqual([{ agentId: retained.id, content: "Resume this queued turn exactly once." }]));
  });
});
