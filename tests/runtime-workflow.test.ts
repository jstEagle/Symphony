import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, SecretStore, writeDefaultConfig } from "../packages/config/src/index.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import { capabilities, emit, makeSession } from "../packages/drivers/src/common.js";
import { AgentRecordSchema, AgentWorkOrderSchema, type AgentStatus, type DriverDoctorResult, type DriverEvent, type DriverSession, type DriverStartRequest, type ModelDescriptor, type WorkerDriver } from "../packages/protocol/src/index.js";
import { AgentCoordinator, ModelRouter, PassiveObserver } from "../packages/runtime/src/index.js";
import { createStore, type TriggerOccurrenceRecord } from "../packages/storage/src/index.js";
import { TriggerManager, WorkflowCompiler, WorkflowEngine } from "../packages/workflow/src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

class FakeDriver implements WorkerDriver {
  readonly id = "codex" as const;
  readonly capabilities = capabilities();
  private reviews = 0;
  forceTerminateCount = 0;

  async doctor(): Promise<DriverDoctorResult> {
    return { driver: this.id, available: true, authenticated: true, version: "fake", capabilities: this.capabilities, detail: "fixture" };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: "fixture", harness: this.id, name: "Fixture", description: "Deterministic test model", modalities: ["text"], structuredOutput: true, pricing: { inputPerMillion: 1, outputPerMillion: 2 }, metadata: {} }];
  }

  async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    const output = request.workOrder.objective.includes("Review")
      ? { score: ++this.reviews === 1 ? 4 : 9 }
      : { changed: true };
    setTimeout(() => {
      emit(onEvent, "usage.recorded", { usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } });
      emit(onEvent, "output.completed", { structuredOutput: output });
      emit(onEvent, "run.completed", { status: "finished" });
    }, 2);
    return makeSession(this.id, `native-${request.agentId}`);
  }

  async resume(session: DriverSession): Promise<DriverSession> { return session; }
  async sendMessage(): Promise<{ receiptId: string; queued: boolean }> { return { receiptId: "receipt", queued: false }; }
  async cancel(): Promise<void> {}
  async forceTerminate(): Promise<void> { this.forceTerminateCount += 1; }
}

class UnauthenticatedDriver extends FakeDriver {
  override async doctor(): Promise<DriverDoctorResult> {
    return { driver: this.id, available: true, authenticated: false, version: "fake", capabilities: this.capabilities, detail: "SDK authentication required" };
  }
}

class MissingOutputDriver extends FakeDriver {
  override async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    setTimeout(() => emit(onEvent, "run.completed", { status: "finished-without-output" }), 2);
    return makeSession(this.id, `native-${request.agentId}`);
  }
}

class ReplayingNativeEventDriver extends FakeDriver {
  override async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    setTimeout(() => {
      const replay = () => {
        emit(onEvent, "message.delta", { text: "Stable streamed text." }, "native-message-1");
        emit(onEvent, "tool.started", { toolCallId: "tool-1", toolName: "read" }, "native-tool-1");
        emit(onEvent, "tool.completed", { toolCallId: "tool-1", result: "done" }, "native-tool-1");
        emit(onEvent, "usage.recorded", { costAmount: 0.25, basis: "provider-reported" }, "native-usage-1");
        emit(onEvent, "output.completed", { structuredOutput: { changed: true } }, "native-output-1");
        emit(onEvent, "run.completed", { status: "finished" }, "native-run-1");
      };
      replay();
      replay();
    }, 2);
    return makeSession(this.id, `native-${request.agentId}`);
  }
}

class RecoveryDriver extends FakeDriver {
  resumedSession: DriverSession | null = null;
  recoveryMessages: string[] = [];
  startCount = 0;
  cancelCount = 0;
  private consumer: ((event: DriverEvent) => void) | null = null;

  constructor(private readonly resumeState: DriverSession["state"]) {
    super();
  }

  override async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    this.startCount += 1;
    this.consumer = onEvent;
    return makeSession(this.id, `native-${request.agentId}`);
  }

  override async resume(session: DriverSession, _request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    this.resumedSession = session;
    this.consumer = onEvent;
    return { ...session, state: this.resumeState };
  }

  override async sendMessage(_session: DriverSession, message: string): Promise<{ receiptId: string; queued: boolean }> {
    this.recoveryMessages.push(message);
    return { receiptId: `recovery-${this.recoveryMessages.length}`, queued: false };
  }

  override async cancel(): Promise<void> {
    this.cancelCount += 1;
  }

  complete(output: unknown = { changed: true }): void {
    if (!this.consumer) throw new Error("Recovery driver has no active event consumer.");
    emit(this.consumer, "output.completed", { structuredOutput: output });
    emit(this.consumer, "run.completed", { status: "finished" });
  }

  output(output: unknown): void {
    if (!this.consumer) throw new Error("Recovery driver has no active event consumer.");
    emit(this.consumer, "output.completed", { structuredOutput: output });
  }

  cancelled(): void {
    if (!this.consumer) throw new Error("Recovery driver has no active event consumer.");
    emit(this.consumer, "run.cancelled", { status: "cancelled" });
  }

  fail(error = "native transport closed"): void {
    if (!this.consumer) throw new Error("Recovery driver has no active event consumer.");
    emit(this.consumer, "run.failed", { error });
  }
}

class BoundedRecoveryDriver extends RecoveryDriver {
  readonly resumeOrder: string[] = [];
  activeResumes = 0;
  maxActiveResumes = 0;

  constructor(private readonly hangingNativeSessionId: string) {
    super("running");
  }

  override async resume(
    session: DriverSession,
    _request: DriverStartRequest,
    _onEvent: (event: DriverEvent) => void,
  ): Promise<DriverSession> {
    this.resumeOrder.push(session.nativeSessionId);
    this.activeResumes += 1;
    this.maxActiveResumes = Math.max(this.maxActiveResumes, this.activeResumes);
    if (session.nativeSessionId === this.hangingNativeSessionId) {
      return await new Promise<DriverSession>(() => {});
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
    this.activeResumes -= 1;
    return { ...session, state: "running" };
  }
}

class ConfirmingCancellationRecoveryDriver extends RecoveryDriver {
  override async cancel(): Promise<void> {
    await super.cancel();
    this.cancelled();
  }
}

class DelayedStartDriver extends FakeDriver {
  startCount = 0;
  cancelCount = 0;
  private consumer: ((event: DriverEvent) => void) | null = null;
  private agentId: string | null = null;
  private release: (() => void) | null = null;

  override async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    this.startCount += 1;
    this.agentId = request.agentId;
    this.consumer = onEvent;
    await new Promise<void>((resolvePromise) => { this.release = resolvePromise; });
    return makeSession(this.id, `native-${request.agentId}`);
  }

  override async cancel(): Promise<void> {
    this.cancelCount += 1;
    if (!this.consumer) throw new Error("Delayed start driver has no event consumer.");
    emit(this.consumer, "run.cancelled", { status: "cancelled" }, `cancelled-${this.agentId ?? "unknown"}`);
  }

  releaseStart(): void {
    if (!this.release) throw new Error("Delayed start driver has not started.");
    this.release();
  }
}

class HangingCancelDriver extends FakeDriver {
  startCount = 0;
  cancelCount = 0;
  forceTerminateCount = 0;
  private readonly consumers = new Map<string, (event: DriverEvent) => void>();

  override async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    this.startCount += 1;
    const nativeSessionId = `native-${request.agentId}`;
    this.consumers.set(nativeSessionId, onEvent);
    return makeSession(this.id, nativeSessionId);
  }

  override async cancel(): Promise<void> {
    this.cancelCount += 1;
    return await new Promise<void>(() => {});
  }

  override async forceTerminate(session: DriverSession): Promise<void> {
    this.forceTerminateCount += 1;
    const consumer = this.consumers.get(session.nativeSessionId);
    if (consumer) emit(consumer, "run.failed", { error: "fixture transport exited during forced termination" });
  }

  complete(agentId: string): void {
    const consumer = this.consumers.get(`native-${agentId}`);
    if (!consumer) throw new Error(`No active consumer for ${agentId}`);
    emit(consumer, "output.completed", { structuredOutput: { changed: true } });
    emit(consumer, "run.completed", { status: "finished" });
  }
}

class SilentForcedCancellationDriver extends HangingCancelDriver {
  override async forceTerminate(): Promise<void> {
    this.forceTerminateCount += 1;
  }
}

class ConflictingTerminalDriver extends FakeDriver {
  constructor(private readonly first: "completed" | "failed" | "cancelled") {
    super();
  }

  override async start(request: DriverStartRequest, onEvent: (event: DriverEvent) => void): Promise<DriverSession> {
    setTimeout(() => {
      if (this.first === "completed") {
        emit(onEvent, "output.completed", { structuredOutput: {} }, "terminal-output");
        emit(onEvent, "run.completed", { status: "finished" }, "terminal-completed");
        emit(onEvent, "run.failed", { error: "late transport exit" }, "terminal-late-failed");
        emit(onEvent, "run.cancelled", { status: "late-cancel" }, "terminal-late-cancelled");
      } else if (this.first === "failed") {
        emit(onEvent, "run.failed", { error: "original failure" }, "terminal-failed");
        emit(onEvent, "run.completed", { status: "late-complete" }, "terminal-late-completed");
        emit(onEvent, "run.cancelled", { status: "late-cancel" }, "terminal-late-cancelled");
      } else {
        emit(onEvent, "run.cancelled", { status: "cancelled" }, "terminal-cancelled");
        emit(onEvent, "run.completed", { status: "late-complete" }, "terminal-late-completed");
        emit(onEvent, "run.failed", { error: "late transport exit" }, "terminal-late-failed");
      }
    }, 2);
    return makeSession(this.id, `native-${request.agentId}`);
  }
}

function testWorkOrder(root: string, id: string) {
  return AgentWorkOrderSchema.parse({
    id,
    workflowId: `workflow-${id}`,
    runId: `run-${id}`,
    parentAgentId: null,
    depth: 0,
    mission: { id: `workflow-${id}`, revision: 1, hash: "12345678", statement: "Exercise lifecycle safety.", keyResults: [] },
    objective: "Perform deterministic fixture work.",
    harness: "codex",
    model: "fixture",
    permissions: "read-only",
    outputSchema: {},
    workspace: { path: root, dirtyPolicy: "local-only" },
    inputs: [],
    metadata: {},
  });
}

function seedRecoverableAgent(
  root: string,
  store: ReturnType<typeof createStore>,
  status: AgentStatus = "running",
  agentId = "durable-agent",
) {
  const order = AgentWorkOrderSchema.parse({
    id: agentId === "durable-agent" ? "durable-logical-agent" : `logical-${agentId}`,
    workflowId: "durable-workflow",
    runId: "durable-run",
    parentAgentId: null,
    depth: 0,
    mission: { id: "durable-workflow", revision: 1, hash: "12345678", statement: "Finish the durable work safely.", keyResults: [] },
    objective: "Continue the durable implementation and verify it.",
    harness: "codex",
    model: "fixture",
    permissions: "full-access",
    outputSchema: {
      type: "object",
      properties: { changed: { type: "boolean" } },
      required: ["changed"],
      additionalProperties: false,
    },
    workspace: { path: root, dirtyPolicy: "local-only" },
    metadata: {},
  });
  const now = new Date().toISOString();
  const agent = AgentRecordSchema.parse({
    id: agentId,
    logicalAgentId: order.id,
    workflowId: order.workflowId,
    runId: order.runId,
    parentAgentId: null,
    depth: 0,
    objective: order.objective,
    missionHash: order.mission.hash,
    requestedHarness: "codex",
    requestedModel: "fixture",
    harness: "codex",
    model: "fixture",
    permissions: "full-access",
    status,
    nativeSessionId: agentId === "durable-agent" ? "native-durable-agent" : `native-${agentId}`,
    nativeRunId: agentId === "durable-agent" ? "native-durable-run" : `native-run-${agentId}`,
    workspacePath: root,
    output: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
  });
  store.saveAgent(agent);
  store.setMetadata(`work-order:${agent.id}`, order);
  return { agent, order };
}

describe("agent graph and workflow execution", () => {
  it("excludes unauthenticated harnesses from catalog and explicit routing fallbacks", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-unauthenticated-router-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new UnauthenticatedDriver());
    const router = new ModelRouter(loaded, new SecretStore("dev.symphony.tests"), drivers, store);

    await expect(router.refresh()).resolves.toEqual([]);
    expect(router.list()).toEqual([]);
    const order = testWorkOrder(root, "unauthenticated-explicit-route");
    order.harness = "codex";
    order.model = "fixture";
    await expect(router.route(order)).rejects.toThrow("No eligible native harness/model");
    store.close();
  });
  it("recovers a run against its pinned workflow revision after a newer revision is registered", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-workflow-revision-recovery-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new FakeDriver());
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    const engine = new WorkflowEngine(loaded, store, coordinator);
    const compiler = new WorkflowCompiler();
    const definition = (value: string) => ({
      id: "revision-pinned",
      name: "Revision pinned",
      mission: { statement: "Execute the authorized workflow revision.", keyResults: [] },
      workspace: { path: root, dirtyPolicy: "local-only" as const },
      output: "steps.version",
      steps: [{ id: "version", type: "set" as const, value }],
    });
    engine.register(compiler.compile(definition("v1"), 1));
    const now = new Date().toISOString();
    store.saveRun({
      id: "revision-pinned-run",
      workflowId: "revision-pinned",
      workflowRevision: 1,
      status: "interrupted",
      input: {},
      output: null,
      error: "daemon stopped",
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      cancelRequested: false,
    });
    engine.register(compiler.compile(definition("v2"), 2));

    await engine.recover();

    await expect.poll(() => store.getRun("revision-pinned-run")).toMatchObject({
      status: "completed",
      workflowRevision: 1,
      output: "v1",
    });
    const started = store.recentEvents({ runId: "revision-pinned-run", types: ["workflow.run.started"], limit: 10 });
    expect(started).toHaveLength(1);
    expect(started[0]?.payload).toMatchObject({ revision: 1 });
    store.close();
  });

  it("restores workflow supervision without waiting for a recovered agent to finish", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-workflow-nonblocking-recovery-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    const driver = new RecoveryDriver("running");
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    const engine = new WorkflowEngine(loaded, store, coordinator);
    const ir = new WorkflowCompiler().compile({
      id: "nonblocking-recovery",
      name: "Nonblocking recovery",
      mission: { statement: "Remain observable while durable work continues.", keyResults: [] },
      workspace: { path: root, dirtyPolicy: "local-only" },
      output: "steps.work",
      steps: [{
        id: "work",
        type: "agent",
        objective: "Keep working until the deterministic fixture is released.",
        harness: "codex",
        model: "fixture",
        outputSchema: {
          type: "object",
          properties: { changed: { type: "boolean" } },
          required: ["changed"],
          additionalProperties: false,
        },
      }],
    }, 1);
    engine.register(ir);
    const now = new Date().toISOString();
    store.saveRun({
      id: "nonblocking-recovery-run",
      workflowId: ir.definition.id,
      workflowRevision: ir.revision,
      status: "running",
      input: {},
      output: null,
      error: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      cancelRequested: false,
    });

    const recoveryResult = await Promise.race([
      engine.recover().then(() => "scheduled" as const),
      new Promise<"blocked">((resolvePromise) => setTimeout(() => resolvePromise("blocked"), 100)),
    ]);

    expect(recoveryResult).toBe("scheduled");
    await expect.poll(() => coordinator.list({ runId: "nonblocking-recovery-run" })).toHaveLength(1);
    await expect.poll(() => coordinator.list({ runId: "nonblocking-recovery-run" })[0]?.status).toBe("running");
    expect(store.getRun("nonblocking-recovery-run")).toMatchObject({ status: "running", workflowRevision: 1 });

    driver.complete({ changed: true });

    await expect.poll(() => store.getRun("nonblocking-recovery-run")).toMatchObject({
      status: "completed",
      workflowRevision: 1,
      output: { changed: true },
    });
    expect(coordinator.list({ runId: "nonblocking-recovery-run" })).toHaveLength(1);
    expect(store.recentEvents({ runId: "nonblocking-recovery-run", types: ["workflow.run.started"], limit: 10 })).toHaveLength(1);
    store.close();
  });

  it("settles a workflow when its agent is interrupted without a native terminal event", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-workflow-agent-interrupted-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.agents.cancellationAcknowledgementTimeoutMs = 20;
    loaded.config.agents.cancellationTerminationGraceMs = 20;
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    const driver = new SilentForcedCancellationDriver();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    const engine = new WorkflowEngine(loaded, store, coordinator);
    const ir = new WorkflowCompiler().compile({
      id: "agent-interrupted",
      name: "Agent interrupted",
      mission: { statement: "Settle supervision at every authoritative terminal boundary.", keyResults: [] },
      workspace: { path: root, dirtyPolicy: "local-only" },
      output: "steps.work",
      steps: [{
        id: "work",
        type: "agent",
        objective: "Remain active until cancellation escalation interrupts this fixture.",
        harness: "codex",
        model: "fixture",
        outputSchema: {
          type: "object",
          properties: { changed: { type: "boolean" } },
          required: ["changed"],
          additionalProperties: false,
        },
      }],
    }, 1);
    engine.register(ir);
    const runPromise = engine.run(ir.definition.id, {}, { runId: "agent-interrupted-run" });

    await expect.poll(() => coordinator.list({ runId: "agent-interrupted-run" })[0]?.status).toBe("running");
    const agent = coordinator.list({ runId: "agent-interrupted-run" })[0];
    expect(agent).toBeDefined();
    await coordinator.cancel(agent!.id);

    const run = await runPromise;
    expect(coordinator.get(agent!.id)).toMatchObject({ status: "interrupted" });
    expect(run).toMatchObject({
      status: "failed",
      error: expect.stringContaining(`Agent ${agent!.id} ended with interrupted`),
    });
    expect(store.listStepAttempts(run.id)).toEqual([
      expect.objectContaining({ status: "failed", error: expect.stringContaining("ended with interrupted") }),
    ]);
    expect(store.recentEvents({ runId: run.id, types: ["workflow.run.failed"], limit: 10 })).toHaveLength(1);
    expect(store.recentEvents({ agentId: agent!.id, types: ["driver.run.failed", "driver.run.cancelled", "driver.run.completed"], limit: 10 })).toHaveLength(0);
    store.close();
  });

  it("propagates a durable workflow cancellation intent to every active native agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-workflow-cancel-propagation-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.agents.cancellationAcknowledgementTimeoutMs = 20;
    loaded.config.agents.cancellationTerminationGraceMs = 20;
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    const driver = new SilentForcedCancellationDriver();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    const engine = new WorkflowEngine(loaded, store, coordinator);
    const ir = new WorkflowCompiler().compile({
      id: "cancel-propagation",
      name: "Cancel propagation",
      mission: { statement: "Stop every active branch when the owning workflow is cancelled.", keyResults: [] },
      workspace: { path: root, dirtyPolicy: "local-only" },
      steps: [{
        id: "parallel-work",
        type: "parallel",
        steps: ["left", "right"].map((id) => ({
          id,
          type: "agent" as const,
          objective: `Keep ${id} active until the workflow cancellation reaches it.`,
          harness: "codex" as const,
          model: "fixture",
          outputSchema: {},
        })),
      }],
    }, 1);
    engine.register(ir);
    const runPromise = engine.run(ir.definition.id, {}, { runId: "cancel-propagation-run" });

    await expect.poll(() => coordinator.list({ runId: "cancel-propagation-run" }).filter((agent) => agent.status === "running")).toHaveLength(2);
    const requested = engine.cancel("cancel-propagation-run");
    expect(requested).toMatchObject({ status: "running", cancelRequested: true });

    const run = await runPromise;
    expect(run).toMatchObject({ status: "cancelled", cancelRequested: true });
    expect(coordinator.list({ runId: run.id })).toHaveLength(2);
    expect(coordinator.list({ runId: run.id }).every((agent) => agent.status === "interrupted")).toBe(true);
    expect(driver.cancelCount).toBe(2);
    expect(driver.forceTerminateCount).toBe(2);
    expect(store.recentEvents({ runId: run.id, types: ["workflow.run.cancel-requested"], limit: 10 })).toHaveLength(1);
    expect(store.recentEvents({ runId: run.id, types: ["workflow.run.cancelled"], limit: 10 })).toHaveLength(1);

    const terminal = engine.cancel(run.id);
    expect(terminal).toEqual(run);
    expect(store.recentEvents({ runId: run.id, types: ["workflow.run.cancel-requested"], limit: 10 })).toHaveLength(1);
    store.close();
  });

  it("blocks recovery explicitly when the pinned workflow revision is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-workflow-missing-revision-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    const driver = new FakeDriver();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    const engine = new WorkflowEngine(loaded, store, coordinator);
    engine.register(new WorkflowCompiler().compile({
      id: "missing-revision",
      name: "Missing revision",
      mission: { statement: "Never substitute a different revision.", keyResults: [] },
      workspace: { path: root, dirtyPolicy: "local-only" },
      steps: [{ id: "replacement", type: "agent", objective: "This newer work must not start.", harness: "codex", model: "fixture", outputSchema: {} }],
    }, 2));
    const now = new Date().toISOString();
    store.saveRun({
      id: "missing-revision-run",
      workflowId: "missing-revision",
      workflowRevision: 1,
      status: "running",
      input: {},
      output: null,
      error: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      cancelRequested: false,
    });

    await engine.recover();

    expect(store.getRun("missing-revision-run")).toMatchObject({
      status: "interrupted",
      workflowRevision: 1,
      error: expect.stringContaining("revision 1 required by run missing-revision-run is unavailable"),
    });
    expect(coordinator.list({ runId: "missing-revision-run" })).toHaveLength(0);
    expect(store.recentEvents({ runId: "missing-revision-run", types: ["workflow.run.recovery-blocked"], limit: 10 })).toHaveLength(1);
    store.close();
  });

  it("keeps chat container runs out of executable workflow recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-chat-container-recovery-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new FakeDriver());
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    const engine = new WorkflowEngine(loaded, store, coordinator);
    const now = new Date().toISOString();
    store.saveRun({
      id: "chat-run:thread-1",
      workflowId: "chat:thread-1",
      workflowRevision: 1,
      status: "interrupted",
      input: {},
      output: null,
      error: "Workflow chat:thread-1 revision 1 required by run chat-run:thread-1 is unavailable; recovery is blocked.",
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      cancelRequested: false,
    });

    await engine.recover();

    expect(store.getRun("chat-run:thread-1")).toMatchObject({
      status: "running",
      error: null,
      startedAt: now,
      finishedAt: null,
    });
    expect(store.recentEvents({
      runId: "chat-run:thread-1",
      types: ["workflow.run.recovery-blocked"],
      limit: 10,
    })).toHaveLength(0);
    expect(coordinator.list({ runId: "chat-run:thread-1" })).toHaveLength(0);
    store.close();
  });

  it("returns an immutable terminal workflow receipt instead of replaying its steps", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-workflow-terminal-receipt-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new FakeDriver());
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    const engine = new WorkflowEngine(loaded, store, coordinator);
    const ir = new WorkflowCompiler().compile({
      id: "terminal-receipt",
      name: "Terminal receipt",
      mission: { statement: "Execute a durable run ID no more than once.", keyResults: [] },
      workspace: { path: root, dirtyPolicy: "local-only" },
      output: "steps.value",
      steps: [{ id: "value", type: "set", value: { result: "original" } }],
    }, 1);
    engine.register(ir);

    const first = await engine.run(ir.definition.id, { attempt: 1 }, { runId: "terminal-receipt-run" });
    const replay = await engine.run(ir.definition.id, { attempt: 2 }, { runId: "terminal-receipt-run" });

    expect(first).toMatchObject({ status: "completed", input: { attempt: 1 }, output: { result: "original" } });
    expect(replay).toEqual(first);
    expect(store.listStepAttempts(first.id)).toHaveLength(1);
    expect(store.recentEvents({ runId: first.id, types: ["workflow.run.started"], limit: 10 })).toHaveLength(1);
    expect(store.recentEvents({ runId: first.id, types: ["workflow.run.completed"], limit: 10 })).toHaveLength(1);
    store.close();
  });

  it("replaces stale cron registrations when a workflow revision changes", () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-workflow-trigger-revision-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new FakeDriver());
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    const engine = new WorkflowEngine(loaded, store, coordinator);
    const triggers = new TriggerManager(store, engine);
    const compiler = new WorkflowCompiler();
    const definition = (ids: string[]) => ({
      id: "scheduled-revision",
      name: "Scheduled revision",
      mission: { statement: "Run only the currently registered schedule revision.", keyResults: [] },
      workspace: { path: root, dirtyPolicy: "local-only" as const },
      steps: [{ id: "value", type: "set" as const, value: true }],
      triggers: ids.map((id) => ({ id, type: "cron" as const, expression: "0 0 1 1 *", input: {} })),
    });

    triggers.register(compiler.compile(definition(["first", "second"]), 1));
    expect(triggers.activeTriggerCount("scheduled-revision")).toBe(2);
    triggers.register(compiler.compile(definition(["replacement"]), 2));
    expect(triggers.activeTriggerCount("scheduled-revision")).toBe(1);
    expect(triggers.activeTriggerCount()).toBe(1);
    triggers.stop();
    expect(triggers.activeTriggerCount()).toBe(0);
    store.close();
  });

  it("keeps registered cron jobs paused until recovery is complete, then activates durable dispatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:00:00.100Z"));
    const root = mkdtempSync(join(tmpdir(), "symphony-trigger-startup-order-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new FakeDriver());
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, new SecretStore("dev.symphony.tests"), drivers, store),
      new PassiveObserver(loaded, new SecretStore("dev.symphony.tests"), store),
    );
    const engine = new WorkflowEngine(loaded, store, coordinator);
    const triggers = new TriggerManager(store, engine, { paused: true });
    try {
      const ir = new WorkflowCompiler().compile({
        id: "paused-startup-trigger",
        name: "Paused startup trigger",
        mission: { statement: "Do not race durable startup recovery.", keyResults: [] },
        workspace: { path: root, dirtyPolicy: "local-only" },
        output: "steps.value",
        steps: [{ id: "value", type: "set", value: true }],
        triggers: [{ id: "every-second", type: "cron", expression: "* * * * * *", input: {} }],
      }, 1);
      engine.register(ir);
      triggers.register(ir);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(store.listTriggerOccurrences()).toEqual([]);

      await triggers.recover();
      triggers.activate();
      await vi.advanceTimersByTimeAsync(1_100);

      const occurrences = store.listTriggerOccurrences();
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]).toMatchObject({
        workflowId: ir.definition.id,
        workflowRevision: ir.revision,
        workflowHash: ir.hash,
        state: "settled",
        attempts: 1,
      });
      expect(store.getRun(occurrences[0]?.runId ?? "")?.status).toBe("completed");
    } finally {
      triggers.stop();
      store.close();
      vi.useRealTimers();
    }
  });

  it("recovers a durable cron occurrence claimed before its run was created exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-trigger-intent-recovery-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new FakeDriver());
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, new SecretStore("dev.symphony.tests"), drivers, store),
      new PassiveObserver(loaded, new SecretStore("dev.symphony.tests"), store),
    );
    const engine = new WorkflowEngine(loaded, store, coordinator);
    const triggers = new TriggerManager(store, engine, { paused: true });
    const ir = new WorkflowCompiler().compile({
      id: "recover-claimed-occurrence",
      name: "Recover claimed occurrence",
      mission: { statement: "Never lose a claimed scheduled run.", keyResults: [] },
      workspace: { path: root, dirtyPolicy: "local-only" },
      output: "steps.value",
      steps: [{ id: "value", type: "set", value: { recovered: true } }],
      triggers: [{ id: "scheduled", type: "cron", expression: "0 0 1 1 *", input: { source: "cron" } }],
    }, 1);
    engine.register(ir);
    const now = new Date().toISOString();
    const occurrence: TriggerOccurrenceRecord = {
      version: 1,
      triggerId: "scheduled",
      occurrenceKey: `${ir.definition.id}:scheduled:2026-08-31T00:00:00.000Z`,
      workflowId: ir.definition.id,
      workflowRevision: ir.revision,
      workflowHash: ir.hash,
      input: { source: "cron" },
      scheduledAt: "2026-08-31T00:00:00.000Z",
      runId: "cron-recover-before-run",
      state: "dispatching",
      attempts: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
      settledAt: null,
    };
    expect(store.durableTransaction(() => store.claimTriggerOccurrence(occurrence))).toBe(true);

    await triggers.recover();
    await vi.waitFor(() => expect(store.getRun(occurrence.runId)?.status).toBe("completed"));
    await triggers.recover();

    expect(store.getTriggerOccurrence(occurrence.triggerId, occurrence.occurrenceKey)).toMatchObject({
      state: "settled",
      runId: occurrence.runId,
      workflowRevision: ir.revision,
      workflowHash: ir.hash,
      input: { source: "cron" },
      attempts: 1,
      error: null,
    });
    expect(store.listRuns().filter((run) => run.id === occurrence.runId)).toHaveLength(1);
    expect(store.recentEvents({ runId: occurrence.runId, types: ["workflow.run.started"], limit: 10 })).toHaveLength(1);
    expect(store.recentEvents({ runId: occurrence.runId, types: ["workflow.trigger.dispatched"], limit: 10 })).toHaveLength(1);
    triggers.stop();
    store.close();
  });

  it("settles a recovered cron occurrence whose pinned run already started without restarting it", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-trigger-run-link-recovery-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new FakeDriver());
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, new SecretStore("dev.symphony.tests"), drivers, store),
      new PassiveObserver(loaded, new SecretStore("dev.symphony.tests"), store),
    );
    const engine = new WorkflowEngine(loaded, store, coordinator);
    const ir = new WorkflowCompiler().compile({
      id: "recover-started-occurrence",
      name: "Recover started occurrence",
      mission: { statement: "Attach an already-started scheduled run once.", keyResults: [] },
      workspace: { path: root, dirtyPolicy: "local-only" },
      output: "steps.value",
      steps: [{ id: "value", type: "set", value: { recovered: true } }],
      triggers: [{ id: "scheduled", type: "cron", expression: "0 0 1 1 *", input: { source: "cron" } }],
    }, 1);
    engine.register(ir);
    const startedAt = new Date().toISOString();
    const occurrence: TriggerOccurrenceRecord = {
      version: 1,
      triggerId: "scheduled",
      occurrenceKey: `${ir.definition.id}:scheduled:2026-09-01T00:00:00.000Z`,
      workflowId: ir.definition.id,
      workflowRevision: ir.revision,
      workflowHash: ir.hash,
      input: { source: "cron" },
      scheduledAt: "2026-09-01T00:00:00.000Z",
      runId: "cron-recover-after-run-start",
      state: "dispatching",
      attempts: 0,
      error: null,
      createdAt: startedAt,
      updatedAt: startedAt,
      settledAt: null,
    };
    expect(store.durableTransaction(() => store.claimTriggerOccurrence(occurrence))).toBe(true);
    store.durableTransaction(() => {
      store.saveRun({
        id: occurrence.runId,
        workflowId: ir.definition.id,
        workflowRevision: ir.revision,
        status: "running",
        input: occurrence.input,
        output: null,
        error: null,
        startedAt,
        updatedAt: startedAt,
        finishedAt: null,
        cancelRequested: false,
      });
      store.appendEvent({
        type: "workflow.run.started",
        workflowId: ir.definition.id,
        runId: occurrence.runId,
        agentId: null,
        occurredAt: startedAt,
        payload: { revision: ir.revision, hash: ir.hash },
        provenance: { source: "workflow" },
      });
    });

    const recoveredEngine = new WorkflowEngine(loaded, store, coordinator);
    const recoveredTriggers = new TriggerManager(store, recoveredEngine, { paused: true });
    await recoveredTriggers.recover();
    await vi.waitFor(() => expect(store.getRun(occurrence.runId)?.status).toBe("completed"));
    await recoveredTriggers.recover();

    expect(store.getTriggerOccurrence(occurrence.triggerId, occurrence.occurrenceKey)).toMatchObject({
      state: "settled",
      runId: occurrence.runId,
      attempts: 1,
      error: null,
    });
    expect(store.recentEvents({ runId: occurrence.runId, types: ["workflow.run.started"], limit: 10 })).toHaveLength(1);
    expect(store.recentEvents({ runId: occurrence.runId, types: ["workflow.run.completed"], limit: 10 })).toHaveLength(1);
    expect(store.recentEvents({ runId: occurrence.runId, types: ["workflow.trigger.dispatched"], limit: 10 })).toHaveLength(1);
    recoveredTriggers.stop();
    store.close();
  });

  it("rejects reuse of a workflow run id for a different workflow", () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-workflow-run-id-conflict-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new FakeDriver());
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    const engine = new WorkflowEngine(loaded, store, coordinator);
    const compiler = new WorkflowCompiler();
    for (const id of ["workflow-a", "workflow-b"]) {
      engine.register(compiler.compile({
        id,
        name: id,
        mission: { statement: `Execute ${id}.`, keyResults: [] },
        workspace: { path: root, dirtyPolicy: "local-only" },
        steps: [{ id: "value", type: "set", value: id }],
      }, 1));
    }
    const now = new Date().toISOString();
    store.saveRun({
      id: "shared-run-id",
      workflowId: "workflow-a",
      workflowRevision: 1,
      status: "interrupted",
      input: {},
      output: null,
      error: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      cancelRequested: false,
    });

    expect(() => engine.start("workflow-b", {}, { runId: "shared-run-id" }))
      .toThrow("Workflow run shared-run-id belongs to workflow-a, not workflow-b.");
    expect(store.getRun("shared-run-id")).toMatchObject({ workflowId: "workflow-a", workflowRevision: 1 });
    store.close();
  });

  it("attributes OpenRouter observer usage to the observed agent and global totals", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-observer-cost-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.observer.provider = "openrouter";
    loaded.config.observer.cache = false;
    const store = createStore(loaded.dataDirectory);
    const agent = AgentRecordSchema.parse({
      id: "observer-target",
      logicalAgentId: "logical-target",
      workflowId: "workflow-observer",
      runId: "run-observer",
      parentAgentId: null,
      depth: 0,
      objective: "Summarize this work.",
      missionHash: "12345678",
      requestedHarness: "codex",
      requestedModel: "fixture",
      harness: "codex",
      model: "fixture",
      permissions: "read-only",
      status: "running",
      nativeSessionId: "native-target",
      nativeRunId: "native-run",
      workspacePath: root,
      output: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
    });
    store.saveAgent(agent);
    store.appendEvent({
      type: "driver.tool.completed",
      workflowId: agent.workflowId,
      runId: agent.runId,
      agentId: agent.id,
      occurredAt: new Date().toISOString(),
      payload: { name: "fixture" },
      provenance: { source: "driver", driver: "codex" },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ summary: "The fixture operation completed." }) } }],
      usage: { prompt_tokens: 120, completion_tokens: 12, cost: 0.0015 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const secrets = { get: () => "test-openrouter-key" } as unknown as SecretStore;
      const observation = await new PassiveObserver(loaded, secrets, store).observe(agent, "tldr");
      expect(observation).toMatchObject({ generatedBy: "model", costAmount: 0.0015 });
      expect(store.aggregateCost({ agentId: agent.id })).toMatchObject({
        knownTotal: 0.0015,
        unknownEvents: 0,
        eventCount: 1,
        byBasis: { "provider-reported": 0.0015 },
      });
      expect(store.recentEvents({ limit: 10 }).some((event) => event.type === "observer.usage.recorded")).toBe(true);
    } finally {
      fetchMock.mockRestore();
      store.close();
    }
  });

  it("allows unlimited nesting and concurrency when both agent limits are disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-unlimited-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.agents.maxDepth = null;
    loaded.config.agents.maxConcurrent = null;
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new FakeDriver());
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );

    const agent = await coordinator.create({
      workflowId: "unlimited",
      runId: "unlimited-run",
      parentAgentId: null,
      depth: 100,
      mission: { id: "unlimited", revision: 1, hash: "12345678", statement: "Allow an explicitly unbounded graph.", keyResults: [] },
      objective: "Build the requested feature.",
      harness: "codex",
      model: "fixture",
      outputSchema: {
        type: "object",
        properties: { changed: { type: "boolean" } },
        required: ["changed"],
        additionalProperties: false,
      },
      workspace: { path: root, dirtyPolicy: "local-only" },
    });

    expect(agent.depth).toBe(100);
    await new Promise<void>((resolvePromise) => {
      const stop = store.onEvent((event) => {
        if (event.agentId === agent.id && event.type === "driver.run.completed") {
          stop();
          resolvePromise();
        }
      });
    });
    store.close();
  });

  it("deduplicates replayed native driver events before projecting state or usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-native-event-dedupe-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new ReplayingNativeEventDriver());
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );

    const agent = await coordinator.create({
      workflowId: "native-event-dedupe",
      runId: "native-event-dedupe-run",
      parentAgentId: null,
      depth: 0,
      mission: { id: "native-event-dedupe", revision: 1, hash: "12345678", statement: "Project native events exactly once.", keyResults: [] },
      objective: "Finish once despite a replayed native stream.",
      harness: "codex",
      model: "fixture",
      outputSchema: {
        type: "object",
        properties: { changed: { type: "boolean" } },
        required: ["changed"],
        additionalProperties: false,
      },
      workspace: { path: root, dirtyPolicy: "local-only" },
    });

    await expect.poll(() => coordinator.get(agent.id).status).toBe("completed");
    const events = store.recentEvents({ agentId: agent.id, limit: 100 });
    for (const type of [
      "driver.message.delta",
      "driver.tool.started",
      "driver.tool.completed",
      "driver.usage.recorded",
      "driver.output.completed",
      "driver.run.completed",
    ]) {
      expect(events.filter((event) => event.type === type)).toHaveLength(1);
    }
    expect(store.aggregateCost({ agentId: agent.id })).toMatchObject({
      knownTotal: 0.25,
      unknownEvents: 0,
      eventCount: 1,
    });
    store.close();
  });

  it("runs a schema-gated review loop until the score reaches the objective", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-runtime-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.router.baseUrl = "http://127.0.0.1:1";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new FakeDriver());
    const router = new ModelRouter(loaded, new SecretStore("dev.symphony.tests"), drivers, store);
    const observer = new PassiveObserver(loaded, new SecretStore("dev.symphony.tests"), store);
    const coordinator = new AgentCoordinator(loaded, store, drivers, router, observer);
    const engine = new WorkflowEngine(loaded, store, coordinator);
    const ir = new WorkflowCompiler().compile({
      id: "quality-loop",
      name: "Quality loop",
      mission: { statement: "Build the feature until independent review passes.", keyResults: ["Review score is at least eight."] },
      workspace: { path: root, dirtyPolicy: "local-only" },
      output: "steps.review",
      steps: [{
        id: "quality",
        type: "while",
        condition: { path: "steps.review.score", op: "lt", value: 8, default: 0 },
        maxIterations: 3,
        steps: [
          { id: "build", type: "agent", objective: "Build the requested feature and verify it.", harness: "codex", model: "fixture", outputSchema: { type: "object", properties: { changed: { type: "boolean" } }, required: ["changed"], additionalProperties: false } },
          { id: "review", type: "agent", objective: "Review the implementation and return a score.", harness: "codex", model: "fixture", permissions: "read-only", outputSchema: { type: "object", properties: { score: { type: "number", minimum: 0, maximum: 10 } }, required: ["score"], additionalProperties: false } },
        ],
      }],
    }, 1);
    engine.register(ir);
    const run = await engine.run(ir.definition.id, {});
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ score: 9 });
    expect(store.listStepAttempts(run.id).filter((attempt) => attempt.stepId === "review" && attempt.status === "completed")).toHaveLength(2);
    const reviews = coordinator.list({ runId: run.id }).filter((agent) => agent.objective.includes("Review"));
    expect(reviews).toHaveLength(2);
    expect(reviews.every((agent) => agent.permissions === "read-only")).toBe(true);
    expect(store.aggregateCost({ runId: run.id })).toMatchObject({
      knownTotal: 12,
      unknownEvents: 0,
      byBasis: { "token-priced-estimate": 12 },
    });
    store.close();
  });

  it("fails closed when native output violates the requested schema", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-schema-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.router.baseUrl = "http://127.0.0.1:1";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    const driver = new FakeDriver();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(loaded, store, drivers, new ModelRouter(loaded, secrets, drivers, store), new PassiveObserver(loaded, secrets, store));
    const agent = await coordinator.create({
      workflowId: "w", runId: "r", depth: 0,
      mission: { id: "w", revision: 1, hash: "12345678", statement: "Return a strict score." },
      objective: "Build something, but the schema expects a score.", harness: "codex", model: "fixture",
      outputSchema: { type: "object", properties: { score: { type: "number" } }, required: ["score"], additionalProperties: false },
      workspace: { path: root },
    });
    const final = await new Promise<ReturnType<AgentCoordinator["get"]>>((resolvePromise) => {
      const stop = store.onEvent((event) => {
        if (event.agentId === agent.id && event.type === "driver.run.completed") { stop(); resolvePromise(coordinator.get(agent.id)); }
      });
    });
    expect(final.status).toBe("failed");
    expect(final.error).toContain("Output schema validation failed");
    await expect.poll(() => ({ reusable: coordinator.hasSession(agent.id), retired: driver.forceTerminateCount })).toEqual({
      reusable: false,
      retired: 1,
    });
    store.close();
  });

  it("keeps the native failure primary when invalid output arrives first", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-native-failure-causality-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const driver = new RecoveryDriver("running");
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    const agent = await coordinator.create({
      workflowId: "native-failure-causality",
      runId: "run-native-failure-causality",
      parentAgentId: null,
      depth: 0,
      mission: { id: "native-failure-causality", revision: 1, hash: "12345678", statement: "Preserve native failure causality.", keyResults: [] },
      objective: "Return the required result or report the provider failure.",
      harness: "codex",
      model: "fixture",
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
      workspace: { path: root, dirtyPolicy: "local-only" },
    });
    await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("running"));

    driver.output({});
    expect(coordinator.get(agent.id)).toMatchObject({ status: "running", output: {}, error: null });

    driver.fail("provider rejected batch-only model");
    await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("failed"));
    const final = coordinator.get(agent.id);
    expect(final.error).toBe("provider rejected batch-only model");
    expect(final.error).not.toContain("Output schema validation failed");
    const failedEvent = store.recentEvents({ agentId: agent.id, types: ["agent.failed"], limit: 10 })[0];
    expect(failedEvent?.payload).toMatchObject({
      error: expect.stringContaining("provider rejected batch-only model"),
      outputValidationError: expect.stringContaining("Output schema validation failed"),
    });
    store.close();
  });

  it("fails closed when a native run completes without a schema-valid output", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-missing-output-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new MissingOutputDriver());
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    const agent = await coordinator.create({
      workflowId: "missing-output",
      runId: "run-missing-output",
      parentAgentId: null,
      depth: 0,
      mission: { id: "missing-output", revision: 1, hash: "12345678", statement: "Require a real structured result.", keyResults: [] },
      objective: "Return the required result.",
      harness: "codex",
      model: "fixture",
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
      workspace: { path: root, dirtyPolicy: "local-only" },
    });
    const final = await new Promise<ReturnType<AgentCoordinator["get"]>>((resolvePromise) => {
      const stop = store.onEvent((event) => {
        if (event.agentId === agent.id && event.type === "agent.failed") {
          stop();
          resolvePromise(coordinator.get(agent.id));
        }
      });
    });
    expect(final.status).toBe("failed");
    expect(final.error).toContain("Output schema validation failed");
    store.close();
  });

  it("removes queued work when cancellation arrives before dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cancel-queued-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.agents.maxConcurrent = 1;
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const driver = new RecoveryDriver("running");
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );

    const active = await coordinator.create(testWorkOrder(root, "active-before-queued-cancel"));
    await vi.waitFor(() => expect(coordinator.get(active.id).status).toBe("running"));
    const queued = await coordinator.create(testWorkOrder(root, "cancel-while-queued"));
    expect(coordinator.get(queued.id).status).toBe("queued");

    await coordinator.cancel(queued.id);
    expect(coordinator.get(queued.id).status).toBe("cancelled");
    driver.complete();
    await vi.waitFor(() => expect(coordinator.get(active.id).status).toBe("completed"));
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(driver.startCount).toBe(1);
    store.close();
  });

  it("cancels routing work before the native harness can start", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cancel-routing-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const driver = new RecoveryDriver("running");
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const router = new ModelRouter(loaded, secrets, drivers, store);
    const order = testWorkOrder(root, "cancel-while-routing");
    await router.refresh();
    const route = await router.route(order);
    let releaseRoute!: (value: typeof route) => void;
    vi.spyOn(router, "route").mockReturnValueOnce(new Promise((resolvePromise) => { releaseRoute = resolvePromise; }));
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      router,
      new PassiveObserver(loaded, secrets, store),
    );

    const agent = await coordinator.create(order);
    await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("routing"));
    await coordinator.cancel(agent.id);
    expect(coordinator.get(agent.id).status).toBe("cancel-requested");
    releaseRoute(route);

    await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("cancelled"));
    expect(driver.startCount).toBe(0);
    store.close();
  });

  it("cancels a native session that attaches after start was already requested", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cancel-starting-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const driver = new DelayedStartDriver();
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );

    const agent = await coordinator.create(testWorkOrder(root, "cancel-while-starting"));
    await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("starting"));
    await coordinator.cancel(agent.id);
    expect(coordinator.get(agent.id).status).toBe("cancel-requested");
    driver.releaseStart();

    await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("cancelled"));
    expect(driver.startCount).toBe(1);
    expect(driver.cancelCount).toBe(1);
    store.close();
  });

  it("bounds a hanging native cancel, escalates exactly once, and releases the scheduler slot", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cancel-hanging-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.agents.maxConcurrent = 1;
    loaded.config.agents.cancellationAcknowledgementTimeoutMs = 20;
    loaded.config.agents.cancellationTerminationGraceMs = 20;
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const driver = new HangingCancelDriver();
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );

    const first = await coordinator.create(testWorkOrder(root, "hanging-native-cancel"));
    await vi.waitFor(() => expect(coordinator.get(first.id).status).toBe("running"));
    const second = await coordinator.create(testWorkOrder(root, "starts-after-cancel-escalation"));
    expect(coordinator.get(second.id).status).toBe("queued");

    const startedAt = Date.now();
    await Promise.all([coordinator.cancel(first.id), coordinator.cancel(first.id)]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(coordinator.get(first.id)).toMatchObject({ status: "interrupted" });
    expect(driver.cancelCount).toBe(1);
    expect(driver.forceTerminateCount).toBe(1);
    const cancellationEvents = store.recentEvents({ agentId: first.id, limit: 50 });
    expect(cancellationEvents.filter((event) => event.type === "agent.cancel.escalated")).toHaveLength(1);
    expect(cancellationEvents.filter((event) => event.type === "driver.run.failed")).toHaveLength(1);
    expect(cancellationEvents.find((event) => event.type === "agent.interrupted")?.payload).toMatchObject({
      phase: "cancellation",
      continuity: "native-cancellation-unconfirmed",
      acknowledgement: "timed-out",
    });

    await vi.waitFor(() => expect(coordinator.get(second.id).status).toBe("running"));
    expect(driver.startCount).toBe(2);
    driver.complete(second.id);
    await vi.waitFor(() => expect(coordinator.get(second.id).status).toBe("completed"));

    await coordinator.cancel(first.id);
    expect(driver.forceTerminateCount).toBe(1);
    store.close();
  });

  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ] as const)("keeps the first %s terminal result when conflicting native events arrive later", async (first, expected) => {
    const root = mkdtempSync(join(tmpdir(), `symphony-terminal-${first}-`));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const drivers = new DriverRegistry();
    drivers.register(new ConflictingTerminalDriver(first));
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );

    const agent = await coordinator.create(testWorkOrder(root, `terminal-${first}`));
    await vi.waitFor(() => {
      expect(store.recentEvents({ agentId: agent.id, limit: 20 }).filter((event) => event.type.startsWith("driver.run."))).toHaveLength(3);
    });

    expect(coordinator.get(agent.id).status).toBe(expected);
    const events = store.recentEvents({ agentId: agent.id, limit: 20 });
    expect(events.filter((event) => event.type === "driver.run.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "driver.run.failed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "driver.run.cancelled")).toHaveLength(1);
    expect(events.filter((event) => ["agent.failed", "agent.cancelled"].includes(event.type))).toHaveLength(first === "completed" ? 0 : 1);
    store.close();
  });

  it("preserves recoverable running state when driver disposal emits a late failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-quiesce-driver-events-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const driver = new RecoveryDriver("running");
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );

    const agent = await coordinator.create(testWorkOrder(root, "quiesce-running-agent"));
    await vi.waitFor(() => expect(coordinator.get(agent.id).status).toBe("running"));
    coordinator.quiesce();
    driver.fail("intentional transport disposal");

    expect(coordinator.get(agent.id).status).toBe("running");
    expect(store.recentEvents({ agentId: agent.id, limit: 20 }).some((event) => event.type === "driver.run.failed")).toBe(false);
    store.close();
  });

  it("reattaches a running native run and keeps it in concurrency accounting", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-running-recovery-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.agents.maxConcurrent = 1;
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const driver = new RecoveryDriver("running");
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    seedRecoverableAgent(root, store);

    await coordinator.recover();

    expect(driver.resumedSession?.state).toBe("running");
    expect(coordinator.get("durable-agent").status).toBe("running");
    expect(driver.recoveryMessages).toHaveLength(0);
    const queued = await coordinator.create({
      workflowId: "queued-workflow",
      runId: "queued-run",
      parentAgentId: null,
      depth: 0,
      mission: { id: "queued-workflow", revision: 1, hash: "87654321", statement: "Wait for the durable slot.", keyResults: [] },
      objective: "Start only after the recovered run settles.",
      harness: "codex",
      model: "fixture",
      outputSchema: {
        type: "object",
        properties: { changed: { type: "boolean" } },
        required: ["changed"],
        additionalProperties: false,
      },
      workspace: { path: root, dirtyPolicy: "local-only" },
    });
    expect(coordinator.get(queued.id).status).toBe("queued");
    expect(driver.startCount).toBe(0);

    driver.complete();
    await vi.waitFor(() => expect(driver.startCount).toBe(1));
    expect(coordinator.get("durable-agent").status).toBe("completed");
    store.close();
  });

  it("continues a previously running work order from an idle resumed session", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-idle-recovery-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const driver = new RecoveryDriver("idle");
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    seedRecoverableAgent(root, store);

    await coordinator.recover();

    expect(driver.resumedSession?.state).toBe("running");
    expect(driver.recoveryMessages).toHaveLength(1);
    expect(driver.recoveryMessages[0]).toContain("last confirmed checkpoint");
    expect(driver.recoveryMessages[0]).toContain("Do not repeat any already-confirmed external write");
    expect(coordinator.get("durable-agent")).toMatchObject({ status: "running", error: null, finishedAt: null });
    expect(store.listAgentMessages("durable-agent", 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "to-agent", receipt_id: "recovery-1", delivery_state: "delivered" }),
    ]));
    expect(store.recentEvents({ agentId: "durable-agent", limit: 20 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent.recovery.continued" }),
      expect.objectContaining({ type: "agent.recovered" }),
    ]));
    driver.complete();
    expect(store.getMetadata<Record<string, unknown>>("agent-recovery:durable-agent")).toMatchObject({ state: "settled", outcome: "completed" });
    store.close();
  });

  it("restores the complete persisted native driver session metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-session-metadata-recovery-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const driver = new RecoveryDriver("running");
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    seedRecoverableAgent(root, store);
    store.setMetadata("driver-session:durable-agent", {
      driver: "codex",
      nativeSessionId: "native-durable-agent",
      nativeRunId: "native-durable-run",
      state: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      metadata: {
        agentId: "durable-agent",
        sessionFile: "/tmp/pi-session.jsonl",
        checkpoint: { sequence: 42 },
      },
    });

    await coordinator.recover();

    expect(driver.resumedSession).toMatchObject({
      nativeSessionId: "native-durable-agent",
      nativeRunId: "native-durable-run",
      state: "running",
      metadata: {
        agentId: "durable-agent",
        sessionFile: "/tmp/pi-session.jsonl",
        checkpoint: { sequence: 42 },
      },
    });
    expect(store.getMetadata<Record<string, unknown>>("driver-session:durable-agent")).toMatchObject({
      metadata: { sessionFile: "/tmp/pi-session.jsonl" },
    });
    driver.complete();
    store.close();
  });

  it("bounds recovery concurrency and releases daemon readiness when one driver resume hangs", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-bounded-recovery-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.agents.recoveryConcurrency = 2;
    loaded.config.agents.recoveryTimeoutMs = 40;
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const driver = new BoundedRecoveryDriver("native-hanging-agent");
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    seedRecoverableAgent(root, store, "running", "quick-agent-one");
    seedRecoverableAgent(root, store, "running", "hanging-agent");
    seedRecoverableAgent(root, store, "running", "quick-agent-two");

    const startedAt = Date.now();
    await coordinator.recover();

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(driver.resumeOrder).toHaveLength(3);
    expect(driver.maxActiveResumes).toBeLessThanOrEqual(2);
    expect(coordinator.get("quick-agent-one")).toMatchObject({ status: "running", error: null });
    expect(coordinator.get("quick-agent-two")).toMatchObject({ status: "running", error: null });
    expect(coordinator.get("hanging-agent")).toMatchObject({
      status: "interrupted",
      error: expect.stringContaining("Recovery timed out after 40ms"),
    });
    expect(store.recentEvents({ agentId: "hanging-agent", limit: 10 })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent.interrupted",
        payload: expect.objectContaining({ continuity: "recovery-timeout", timeoutMs: 40 }),
      }),
    ]));
    store.close();
  });

  it.each(["queued", "routing"] as const)("restores durable %s work without losing it", async (status) => {
    const root = mkdtempSync(join(tmpdir(), `symphony-${status}-recovery-`));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const driver = new RecoveryDriver("running");
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    const { agent } = seedRecoverableAgent(root, store, status);
    store.saveAgent({
      ...agent,
      status,
      harness: null,
      model: null,
      nativeSessionId: null,
      nativeRunId: null,
      startedAt: null,
    });

    await coordinator.recover();

    await expect.poll(() => driver.startCount).toBe(1);
    expect(coordinator.get("durable-agent")).toMatchObject({
      status: "running",
      nativeSessionId: "native-durable-agent",
    });
    expect(store.recentEvents({ agentId: "durable-agent", limit: 20 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent.recovered" }),
    ]));
    driver.complete();
    store.close();
  });

  it("does not redispatch a native start whose outcome is unknown", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-starting-recovery-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const driver = new RecoveryDriver("running");
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    const { agent } = seedRecoverableAgent(root, store, "starting");
    store.saveAgent({ ...agent, status: "starting", nativeSessionId: null, nativeRunId: null });

    await coordinator.recover();

    expect(driver.startCount).toBe(0);
    expect(coordinator.get("durable-agent")).toMatchObject({
      status: "interrupted",
      error: expect.stringContaining("outcome is unknown"),
    });
    store.close();
  });

  it.each(["dispatching", "delivered"] as const)("does not retry a %s recovery continuation whose outcome is unknown", async (deliveryState) => {
    const root = mkdtempSync(join(tmpdir(), "symphony-unknown-recovery-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const driver = new RecoveryDriver("idle");
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    seedRecoverableAgent(root, store);
    const now = new Date().toISOString();
    store.setMetadata("agent-recovery:durable-agent", {
      attemptId: "unknown-attempt",
      nativeSessionId: "native-durable-agent",
      state: deliveryState,
      createdAt: now,
      updatedAt: now,
    });

    await coordinator.recover();

    expect(driver.recoveryMessages).toHaveLength(0);
    expect(coordinator.get("durable-agent")).toMatchObject({
      status: "interrupted",
      error: expect.stringContaining("will not retry it automatically"),
    });
    expect(store.recentEvents({ agentId: "durable-agent", limit: 10 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent.interrupted" }),
    ]));
    store.close();
  });

  it("fails closed when a resumed harness cannot prove the native run outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-native-outcome-unknown-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const driver = new RecoveryDriver("unknown");
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    seedRecoverableAgent(root, store);

    await coordinator.recover();

    expect(driver.recoveryMessages).toHaveLength(0);
    expect(coordinator.get("durable-agent")).toMatchObject({
      status: "interrupted",
      error: expect.stringContaining("cannot prove the outcome"),
    });
    expect(store.recentEvents({ agentId: "durable-agent", limit: 10 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent.interrupted" }),
    ]));
    store.close();
  });

  it("reissues a persisted cancellation intent instead of reviving the run", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-cancel-recovery-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const driver = new ConfirmingCancellationRecoveryDriver("running");
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    seedRecoverableAgent(root, store, "cancel-requested");

    await coordinator.recover();

    expect(driver.cancelCount).toBe(1);
    expect(driver.recoveryMessages).toHaveLength(0);
    expect(coordinator.get("durable-agent").status).toBe("cancelled");
    expect(store.recentEvents({ agentId: "durable-agent", limit: 10 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent.cancel.reissued" }),
      expect.objectContaining({ type: "agent.cancelled" }),
    ]));
    store.close();
  });

  it("restores an already idle native session without inventing active work", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-idle-session-recovery-"));
    temporary.push(root);
    writeDefaultConfig(root);
    const loaded = loadConfig({ rootDirectory: root });
    loaded.config.router.provider = "neutral-lexical";
    loaded.config.observer.provider = "deterministic";
    const store = createStore(loaded.dataDirectory);
    const driver = new RecoveryDriver("idle");
    const drivers = new DriverRegistry();
    drivers.register(driver);
    const secrets = new SecretStore("dev.symphony.tests");
    const coordinator = new AgentCoordinator(
      loaded,
      store,
      drivers,
      new ModelRouter(loaded, secrets, drivers, store),
      new PassiveObserver(loaded, secrets, store),
    );
    seedRecoverableAgent(root, store, "idle");

    await coordinator.recover();

    expect(driver.resumedSession?.state).toBe("idle");
    expect(driver.recoveryMessages).toHaveLength(0);
    expect(coordinator.get("durable-agent")).toMatchObject({ status: "idle", error: null, finishedAt: null });
    store.close();
  });
});
