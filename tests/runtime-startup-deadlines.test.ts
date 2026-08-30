import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, SecretStore, writeDefaultConfig } from "../packages/config/src/index.js";
import { capabilities, emit, makeSession } from "../packages/drivers/src/common.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import {
  AgentRecordSchema,
  AgentWorkOrderSchema,
  type AgentWorkOrder,
  type DriverDoctorResult,
  type DriverEvent,
  type DriverLifecycleOptions,
  type DriverSession,
  type DriverStartRequest,
  type ModelDescriptor,
  type RoutingTrace,
  type WorkerDriver,
} from "../packages/protocol/src/index.js";
import { AgentCoordinator, ModelRouter, PassiveObserver, type RouteResult } from "../packages/runtime/src/index.js";
import { createStore } from "../packages/storage/src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function order(root: string, id: string): AgentWorkOrder {
  return AgentWorkOrderSchema.parse({
    id,
    workflowId: `workflow-${id}`,
    runId: `run-${id}`,
    parentAgentId: null,
    depth: 0,
    mission: { id: `workflow-${id}`, revision: 1, hash: "12345678", statement: "Exercise bounded lifecycle setup.", keyResults: [] },
    objective: id,
    harness: "codex",
    model: "fixture",
    permissions: "read-only",
    outputSchema: {},
    workspace: { path: root, dirtyPolicy: "local-only" },
    inputs: [],
    metadata: {},
  });
}

function route(order: AgentWorkOrder): RouteResult {
  const trace: RoutingTrace = {
    id: `trace-${order.id ?? order.runId}`,
    workOrderId: order.id ?? order.runId,
    catalogSnapshotId: "fixture-catalog",
    query: order.objective,
    eligibleCandidateIds: ["codex/fixture"],
    anonymousCards: [{ opaqueId: "candidate-1", text: "fixture", candidateId: "codex/fixture" }],
    method: "explicit",
    reranker: null,
    scores: { "candidate-1": 1 },
    selectedCandidateId: "codex/fixture",
    createdAt: new Date().toISOString(),
  };
  return { harness: "codex", model: "fixture", trace };
}

class DeadlineDriver implements WorkerDriver {
  readonly id = "codex" as const;
  readonly capabilities = capabilities();
  readonly started: string[] = [];
  readonly abortedStarts: string[] = [];
  readonly abortedResumes: string[] = [];
  readonly forceTerminated: string[] = [];

  async doctor(): Promise<DriverDoctorResult> {
    return { driver: this.id, available: true, authenticated: true, version: "fixture", capabilities: this.capabilities, detail: "fixture" };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: "fixture", harness: this.id, name: "Fixture", description: "Fixture", modalities: ["text"], structuredOutput: true, pricing: {}, metadata: {} }];
  }

  async start(
    request: DriverStartRequest,
    onEvent: (event: DriverEvent) => void,
    lifecycle?: DriverLifecycleOptions,
  ): Promise<DriverSession> {
    this.started.push(request.agentId);
    if (request.workOrder.objective !== "hung-start") {
      setTimeout(() => {
        emit(onEvent, "output.completed", { structuredOutput: {} });
        emit(onEvent, "run.completed", { status: "finished" });
      }, 2);
      return makeSession(this.id, `native-${request.agentId}`);
    }
    return await new Promise<DriverSession>((resolve) => {
      lifecycle?.signal.addEventListener("abort", () => {
        this.abortedStarts.push(request.agentId);
        setTimeout(() => resolve(makeSession(this.id, `late-${request.agentId}`)), 5);
      }, { once: true });
    });
  }

  async resume(
    session: DriverSession,
    _request: DriverStartRequest,
    _onEvent: (event: DriverEvent) => void,
    lifecycle?: DriverLifecycleOptions,
  ): Promise<DriverSession> {
    return await new Promise<DriverSession>((resolve) => {
      lifecycle?.signal.addEventListener("abort", () => {
        this.abortedResumes.push(session.nativeSessionId);
        setTimeout(() => resolve({ ...session, state: "running" }), 5);
      }, { once: true });
    });
  }

  async sendMessage(): Promise<{ receiptId: string; queued: boolean }> {
    return { receiptId: "fixture-receipt", queued: false };
  }

  async cancel(): Promise<void> {}

  async forceTerminate(session: DriverSession): Promise<void> {
    this.forceTerminated.push(session.nativeSessionId);
  }
}

function coordinatorFixture(root: string, driver: DeadlineDriver, router: ModelRouter) {
  writeDefaultConfig(root);
  const loaded = loadConfig({ rootDirectory: root });
  loaded.config.agents.maxConcurrent = 1;
  loaded.config.agents.routingTimeoutMs = 25;
  loaded.config.agents.startupTimeoutMs = 25;
  loaded.config.agents.recoveryTimeoutMs = 25;
  loaded.config.router.provider = "neutral-lexical";
  loaded.config.observer.provider = "deterministic";
  const store = createStore(loaded.dataDirectory);
  const drivers = new DriverRegistry();
  drivers.register(driver);
  const secrets = new SecretStore("dev.symphony.startup-deadline-tests");
  return {
    loaded,
    store,
    coordinator: new AgentCoordinator(
      loaded,
      store,
      drivers,
      router,
      new PassiveObserver(loaded, secrets, store),
    ),
  };
}

describe("bounded lifecycle setup", () => {
  it("fails a hung route before dispatch and releases the scheduler slot", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-routing-deadline-"));
    temporary.push(root);
    const driver = new DeadlineDriver();
    let routingAborted = false;
    const router = {
      async route(workOrder: AgentWorkOrder, signal?: AbortSignal): Promise<RouteResult> {
        if (workOrder.objective !== "hung-route") return route(workOrder);
        return await new Promise<RouteResult>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            routingAborted = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
    } as ModelRouter;
    const { coordinator, store } = coordinatorFixture(root, driver, router);

    const hung = await coordinator.create(order(root, "hung-route"));
    const next = await coordinator.create(order(root, "next-after-route"));

    await expect.poll(() => coordinator.get(hung.id).status).toBe("failed");
    await expect.poll(() => coordinator.get(next.id).status).toBe("completed");
    expect(routingAborted).toBe(true);
    expect(driver.started).toEqual([next.id]);
    expect(coordinator.get(hung.id).error).toContain("before any native work was dispatched");
    expect(store.recentEvents({ agentId: hung.id, limit: 10 })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent.failed",
        payload: expect.objectContaining({ continuity: "routing-timeout-before-dispatch", timeoutMs: 25 }),
      }),
    ]));
    store.close();
  });

  it("interrupts an outcome-unknown native start, detaches its late session, and releases the slot", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-startup-deadline-"));
    temporary.push(root);
    const driver = new DeadlineDriver();
    const router = { route: async (workOrder: AgentWorkOrder) => route(workOrder) } as ModelRouter;
    const { coordinator, store } = coordinatorFixture(root, driver, router);

    const hung = await coordinator.create(order(root, "hung-start"));
    const next = await coordinator.create(order(root, "next-after-start"));

    await expect.poll(() => coordinator.get(hung.id).status).toBe("interrupted");
    await expect.poll(() => coordinator.get(next.id).status).toBe("completed");
    await expect.poll(() => driver.forceTerminated).toContain(`late-${hung.id}`);
    expect(driver.abortedStarts).toEqual([hung.id]);
    expect(coordinator.get(hung.id)).toMatchObject({ nativeSessionId: null, nativeRunId: null });
    expect(coordinator.get(hung.id).error).toContain("will not retry it automatically");
    expect(store.recentEvents({ agentId: hung.id, limit: 10 })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent.interrupted",
        payload: expect.objectContaining({ continuity: "native-start-timeout", deliveryState: "unknown", timeoutMs: 25 }),
      }),
    ]));
    store.close();
  });

  it("aborts a hung resume and detaches a session that resolves after recovery timed out", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-resume-deadline-"));
    temporary.push(root);
    const driver = new DeadlineDriver();
    const router = { route: async (workOrder: AgentWorkOrder) => route(workOrder) } as ModelRouter;
    const { coordinator, store } = coordinatorFixture(root, driver, router);
    const workOrder = order(root, "recoverable");
    const now = new Date().toISOString();
    const agent = AgentRecordSchema.parse({
      id: "recoverable-agent",
      logicalAgentId: workOrder.id,
      workflowId: workOrder.workflowId,
      runId: workOrder.runId,
      parentAgentId: null,
      depth: 0,
      objective: workOrder.objective,
      missionHash: workOrder.mission.hash,
      requestedHarness: "codex",
      requestedModel: "fixture",
      harness: "codex",
      model: "fixture",
      permissions: "read-only",
      status: "running",
      nativeSessionId: "native-recoverable",
      nativeRunId: "native-run-recoverable",
      workspacePath: root,
      output: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: null,
    });
    store.saveAgent(agent);
    store.setMetadata(`work-order:${agent.id}`, workOrder);

    await coordinator.recover();

    expect(coordinator.get(agent.id)).toMatchObject({
      status: "interrupted",
      nativeSessionId: "native-recoverable",
      error: expect.stringContaining("Recovery timed out after 25ms"),
    });
    expect(driver.abortedResumes).toEqual(["native-recoverable"]);
    await expect.poll(() => driver.forceTerminated).toContain("native-recoverable");
    expect(store.recentEvents({ agentId: agent.id, limit: 10 })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent.interrupted",
        payload: expect.objectContaining({ continuity: "recovery-timeout", timeoutMs: 25 }),
      }),
    ]));
    store.close();
  });
});
