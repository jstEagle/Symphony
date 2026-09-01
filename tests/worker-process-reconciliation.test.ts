import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, SecretStore, writeDefaultConfig } from "../packages/config/src/index.js";
import { capabilities, emit, makeSession } from "../packages/drivers/src/common.js";
import { DriverRegistry } from "../packages/drivers/src/registry.js";
import { WorkerHostConnection } from "../packages/drivers/src/index.js";
import {
  AgentRecordSchema,
  AgentWorkOrderSchema,
  WorkerProcessLeaseSchema,
  type AgentRecord,
  type AgentWorkOrder,
  type DriverDoctorResult,
  type DriverEvent,
  type DriverLifecycleOptions,
  type DriverSession,
  type DriverStartRequest,
  type ModelDescriptor,
  type ProcessIdentity,
  type RoutingTrace,
  type WorkerDriver,
} from "../packages/protocol/src/index.js";
import { AgentCoordinator, ModelRouter, PassiveObserver, type RouteResult } from "../packages/runtime/src/index.js";
import { createStore, type SymphonyStore } from "../packages/storage/src/index.js";

const temporary: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

class LedgerDriver implements WorkerDriver {
  readonly id = "codex" as const;
  readonly capabilities = capabilities();
  resumes = 0;
  hungStart = false;

  async doctor(): Promise<DriverDoctorResult> {
    return { driver: this.id, available: true, authenticated: true, version: "fixture", capabilities: this.capabilities, detail: "fixture" };
  }

  async listModels(): Promise<ModelDescriptor[]> { return []; }

  async start(
    request: DriverStartRequest,
    _onEvent: (event: DriverEvent) => void,
    options?: DriverLifecycleOptions,
  ): Promise<DriverSession> {
    if (!this.hungStart) return makeSession(this.id, `native-${request.agentId}`);
    options?.processSupervisor?.reserveProcess({
      role: "hung-fixture",
      command: "fixture",
      args: [],
      cwd: request.workOrder.workspace.path,
      adapterVersion: "fixture",
    });
    return await new Promise<DriverSession>((_resolve, reject) => {
      options?.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  }

  async resume(session: DriverSession): Promise<DriverSession> {
    this.resumes += 1;
    return { ...session, state: "idle" };
  }

  async sendMessage(): Promise<{ receiptId: string; queued: boolean }> { return { receiptId: "fixture", queued: false }; }
  async cancel(): Promise<void> {}
}

/** A native session whose process callback is intentionally never forwarded. */
class MissedExitDriver extends LedgerDriver {
  readonly attachedIdentity = identity(8842, "boot:missed-exit");

  override async start(
    request: DriverStartRequest,
    _onEvent: (event: DriverEvent) => void,
    options?: DriverLifecycleOptions,
  ): Promise<DriverSession> {
    const supervisor = options?.processSupervisor;
    if (!supervisor) throw new Error("Missing process supervisor.");
    const lease = supervisor.reserveProcess({
      role: "missed-exit-fixture",
      command: "fixture",
      args: [],
      cwd: request.workOrder.workspace.path,
      adapterVersion: "fixture",
    });
    supervisor.attachProcess(lease.id, this.attachedIdentity);
    return makeSession(this.id, `native-${request.agentId}`, {}, `turn-${request.agentId}`);
  }
}

class SynchronousTerminalResumeDriver extends LedgerDriver {
  override async resume(
    session: DriverSession,
    request: DriverStartRequest,
    onEvent: (event: DriverEvent) => void,
    options?: DriverLifecycleOptions,
  ): Promise<DriverSession> {
    this.resumes += 1;
    const lease = options?.processSupervisor?.reserveProcess({
      role: "resume-fixture",
      command: "fixture",
      args: [],
      cwd: request.workOrder.workspace.path,
      adapterVersion: "fixture",
    });
    if (lease) options?.processSupervisor?.attachProcess(lease.id, identity(5252, "boot:resume"));
    emit(onEvent, "output.completed", { structuredOutput: { recovered: true } }, "output-turn-1");
    emit(onEvent, "run.completed", { status: "completed" }, "turn-1");
    if (lease) options?.processSupervisor?.releaseProcess(lease.id, { exitCode: 0, signal: null, error: null });
    return { ...session, state: "completed" };
  }
}

class HostedAdoptionDriver extends LedgerDriver {
  adoptedLeaseId: string | null = null;
  adoptedOwnerEpoch: number | null = null;
  resumeState: DriverSession["state"] = "running";

  override async resume(
    session: DriverSession,
    request: DriverStartRequest,
    _onEvent: (event: DriverEvent) => void,
    options?: DriverLifecycleOptions,
  ): Promise<DriverSession> {
    this.resumes += 1;
    const supervisor = options?.processSupervisor;
    if (!supervisor) throw new Error("Missing process supervisor.");
    if (supervisor.retainedProcess !== true) throw new Error("Expected retained-process recovery authority.");
    const lease = supervisor.reserveProcess({
      role: "codex-app-server",
      command: "codex",
      args: ["app-server"],
      cwd: request.workOrder.workspace.path,
      adapterVersion: "fixture",
    });
    const plan = supervisor.workerHostPlan?.(lease.id);
    if (!plan || plan.mode !== "reconnect" || lease.transport.kind !== "worker-host") {
      throw new Error("Expected a retained worker-host reconnect plan.");
    }
    const adopted = supervisor.adoptProcess?.(lease.id, lease.revision, {
      ...lease.transport,
      controllerOwnerId: plan.controllerOwnerId,
      ownerEpoch: plan.ownerEpoch,
    });
    if (!adopted || adopted.transport.kind !== "worker-host") throw new Error("Hosted lease was not adopted.");
    this.adoptedLeaseId = adopted.id;
    this.adoptedOwnerEpoch = adopted.transport.ownerEpoch;
    return { ...session, state: this.resumeState };
  }
}

class HostedOpenCodeAdoptionDriver implements WorkerDriver {
  readonly id = "opencode" as const;
  readonly capabilities = capabilities();
  resumes = 0;
  adoptedLeaseId: string | null = null;

  async doctor(): Promise<DriverDoctorResult> {
    return { driver: this.id, available: true, authenticated: true, version: "fixture", capabilities: this.capabilities, detail: "fixture" };
  }

  async listModels(): Promise<ModelDescriptor[]> { return []; }
  async start(): Promise<DriverSession> { throw new Error("Unexpected OpenCode start."); }

  async resume(
    session: DriverSession,
    request: DriverStartRequest,
    _onEvent: (event: DriverEvent) => void,
    options?: DriverLifecycleOptions,
  ): Promise<DriverSession> {
    this.resumes += 1;
    const supervisor = options?.processSupervisor;
    if (!supervisor) throw new Error("Missing process supervisor.");
    if (supervisor.retainedProcess !== true) throw new Error("Expected retained-process recovery authority.");
    const lease = supervisor.reserveProcess({
      role: "opencode-server",
      command: "opencode",
      args: ["serve", "--hostname=127.0.0.1", "--port=4096"],
      cwd: request.workOrder.workspace.path,
      adapterVersion: "fixture",
    });
    const plan = supervisor.workerHostPlan?.(lease.id);
    if (!plan || plan.mode !== "reconnect" || lease.transport.kind !== "worker-host") {
      throw new Error("Expected a retained OpenCode worker-host reconnect plan.");
    }
    const adopted = supervisor.adoptProcess?.(lease.id, lease.revision, {
      ...lease.transport,
      controllerOwnerId: plan.controllerOwnerId,
      ownerEpoch: plan.ownerEpoch,
    });
    if (!adopted || adopted.transport.kind !== "worker-host") throw new Error("OpenCode hosted lease was not adopted.");
    this.adoptedLeaseId = adopted.id;
    return { ...session, state: "running" };
  }

  async sendMessage(): Promise<{ receiptId: string; queued: boolean }> { return { receiptId: "fixture", queued: false }; }
  async cancel(): Promise<void> {}
}

class HostedPiAdoptionDriver implements WorkerDriver {
  readonly id = "pi" as const;
  readonly capabilities = capabilities();
  resumes = 0;
  adoptedLeaseId: string | null = null;

  async doctor(): Promise<DriverDoctorResult> {
    return { driver: this.id, available: true, authenticated: true, version: "fixture", capabilities: this.capabilities, detail: "fixture" };
  }

  async listModels(): Promise<ModelDescriptor[]> { return []; }
  async start(): Promise<DriverSession> { throw new Error("Unexpected Pi start."); }

  async resume(
    session: DriverSession,
    request: DriverStartRequest,
    _onEvent: (event: DriverEvent) => void,
    options?: DriverLifecycleOptions,
  ): Promise<DriverSession> {
    this.resumes += 1;
    const supervisor = options?.processSupervisor;
    if (!supervisor) throw new Error("Missing process supervisor.");
    if (supervisor.retainedProcess !== true) throw new Error("Expected retained-process recovery authority.");
    const lease = supervisor.reserveProcess({
      role: "pi-rpc",
      command: "pi",
      args: ["--mode", "rpc"],
      cwd: request.workOrder.workspace.path,
      adapterVersion: "fixture",
    });
    const plan = supervisor.workerHostPlan?.(lease.id);
    if (!plan || plan.mode !== "reconnect" || lease.transport.kind !== "worker-host") {
      throw new Error("Expected a retained Pi worker-host reconnect plan.");
    }
    const adopted = supervisor.adoptProcess?.(lease.id, lease.revision, {
      ...lease.transport,
      controllerOwnerId: plan.controllerOwnerId,
      ownerEpoch: plan.ownerEpoch,
    });
    if (!adopted || adopted.transport.kind !== "worker-host") throw new Error("Pi hosted lease was not adopted.");
    this.adoptedLeaseId = adopted.id;
    return { ...session, state: "running" };
  }

  async sendMessage(): Promise<{ receiptId: string; queued: boolean }> { return { receiptId: "fixture", queued: false }; }
  async cancel(): Promise<void> {}
}

class HostedClaudeAdoptionDriver implements WorkerDriver {
  readonly id = "claude" as const;
  readonly capabilities = capabilities();
  resumes = 0;
  adoptedLeaseId: string | null = null;

  async doctor(): Promise<DriverDoctorResult> {
    return { driver: this.id, available: true, authenticated: true, version: "fixture", capabilities: this.capabilities, detail: "fixture" };
  }
  async listModels(): Promise<ModelDescriptor[]> { return []; }
  async start(): Promise<DriverSession> { throw new Error("Unexpected Claude start."); }
  async resume(session: DriverSession, request: DriverStartRequest, _onEvent: (event: DriverEvent) => void, options?: DriverLifecycleOptions): Promise<DriverSession> {
    this.resumes += 1;
    const supervisor = options?.processSupervisor;
    if (!supervisor?.retainedProcess) throw new Error("Expected retained Claude process authority.");
    const lease = supervisor.reserveProcess({
      role: "claude-sdk-host",
      command: process.execPath,
      args: ["claude-host.js"],
      cwd: request.workOrder.workspace.path,
      adapterVersion: "claude-sdk-host:v1",
    });
    const plan = supervisor.workerHostPlan?.(lease.id);
    if (!plan || plan.mode !== "reconnect" || lease.transport.kind !== "worker-host") throw new Error("Expected retained Claude worker-host plan.");
    const adopted = supervisor.adoptProcess?.(lease.id, lease.revision, { ...lease.transport, controllerOwnerId: plan.controllerOwnerId, ownerEpoch: plan.ownerEpoch });
    if (!adopted || adopted.transport.kind !== "worker-host") throw new Error("Claude hosted lease was not adopted.");
    this.adoptedLeaseId = adopted.id;
    return { ...session, state: "running" };
  }
  async sendMessage(): Promise<{ receiptId: string; queued: boolean }> { return { receiptId: "fixture", queued: false }; }
  async cancel(): Promise<void> {}
}

type HostedHarness = "codex" | "claude" | "opencode" | "pi";

function workOrder(root: string, id: string, harness: HostedHarness = "codex"): AgentWorkOrder {
  return AgentWorkOrderSchema.parse({
    id,
    workflowId: `workflow-${id}`,
    runId: `run-${id}`,
    parentAgentId: null,
    depth: 0,
    mission: { id: `mission-${id}`, revision: 1, hash: "12345678", statement: "Exercise process recovery." },
    objective: id,
    harness,
    model: "fixture",
    permissions: "read-only",
    outputSchema: {},
    workspace: { path: root },
  });
}

function activeAgent(root: string, id: string, harness: HostedHarness = "codex"): { agent: AgentRecord; order: AgentWorkOrder } {
  const order = workOrder(root, id, harness);
  const now = new Date().toISOString();
  const agent = AgentRecordSchema.parse({
    id: `agent-${id}`,
    logicalAgentId: id,
    workflowId: order.workflowId,
    runId: order.runId,
    parentAgentId: null,
    depth: 0,
    objective: id,
    missionHash: order.mission.hash,
    requestedHarness: harness,
    requestedModel: "fixture",
    harness,
    model: "fixture",
    permissions: "read-only",
    status: "running",
    nativeSessionId: `native-${id}`,
    nativeRunId: `turn-${id}`,
    workspacePath: root,
    output: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
  });
  return { agent, order };
}

function identity(pid = 4242, startToken = "boot:100"): ProcessIdentity {
  return {
    pid,
    processGroupId: pid,
    platform: "linux",
    capturedAt: new Date().toISOString(),
    executable: "/fixture/adapter",
    startToken,
    verification: "strong",
  };
}

function saveOldLease(store: SymphonyStore, agent: AgentRecord, processIdentity: ProcessIdentity): string {
  const now = new Date().toISOString();
  const lease = WorkerProcessLeaseSchema.parse({
    id: `lease-${agent.id}`,
    daemonOwnerId: "previous-daemon",
    agentId: agent.id,
    attemptId: `attempt-${agent.id}`,
    driver: "codex",
    role: "codex-app-server",
    command: "codex",
    args: ["app-server"],
    cwd: agent.workspacePath,
    workspacePath: agent.workspacePath,
    permission: agent.permissions,
    adapterVersion: "fixture",
    identity: processIdentity,
    nativeSessionId: agent.nativeSessionId,
    nativeRunId: agent.nativeRunId,
    activeTurnId: agent.nativeRunId,
    lastEventCursor: null,
    state: "running",
    reservedAt: now,
    attachedAt: now,
    updatedAt: now,
    releasedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    revision: 0,
  });
  store.saveWorkerProcessLease(lease);
  return lease.id;
}

function saveOldHostedLease(store: SymphonyStore, agent: AgentRecord, hostIdentity: ProcessIdentity, suffix = "primary"): string {
  const now = new Date().toISOString();
  const claude = agent.harness === "claude";
  const opencode = agent.harness === "opencode";
  const pi = agent.harness === "pi";
  const lease = WorkerProcessLeaseSchema.parse({
    id: `hosted-${agent.id}-${suffix}`,
    daemonOwnerId: "previous-daemon",
    agentId: agent.id,
    attemptId: `attempt-${agent.id}-${suffix}`,
    driver: agent.harness ?? "codex",
    role: claude ? "claude-sdk-host" : opencode ? "opencode-server" : pi ? "pi-rpc" : "codex-app-server",
    command: claude ? process.execPath : opencode ? "opencode" : pi ? "pi" : "codex",
    args: claude ? ["claude-host.js"] : opencode ? ["serve", "--hostname=127.0.0.1", "--port=4096"] : pi ? ["--mode", "rpc"] : ["app-server"],
    cwd: agent.workspacePath,
    workspacePath: agent.workspacePath,
    permission: agent.permissions,
    adapterVersion: "fixture",
    transport: {
      kind: "worker-host",
      protocolVersion: 1,
      endpoint: join(agent.workspacePath, `${agent.id}.sock`),
      spoolPath: join(agent.workspacePath, `${agent.id}.jsonl`),
      hostInstanceId: `host-instance-${agent.id}`,
      hostIdentity,
      workerIdentity: identity(4343, "boot:worker"),
      controllerOwnerId: "stable-controller",
      ownerEpoch: 1,
      processedOutputSeq: 4,
      ackedOutputSeq: 4,
      producedOutputSeq: 4,
      spoolBytes: 0,
      spoolState: "healthy",
    },
    identity: identity(4343, "boot:worker"),
    nativeSessionId: agent.nativeSessionId,
    nativeRunId: agent.nativeRunId,
    activeTurnId: agent.nativeRunId,
    lastEventCursor: null,
    state: "running",
    reservedAt: now,
    attachedAt: now,
    updatedAt: now,
    releasedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    revision: 0,
  });
  store.saveWorkerProcessLease(lease);
  return lease.id;
}

function fixture(root: string, driver: WorkerDriver = new LedgerDriver()) {
  writeDefaultConfig(root);
  const loaded = loadConfig({ rootDirectory: root });
  loaded.config.agents.startupTimeoutMs = 20;
  loaded.config.router.provider = "neutral-lexical";
  loaded.config.observer.provider = "deterministic";
  const store = createStore(loaded.dataDirectory);
  const drivers = new DriverRegistry();
  drivers.register(driver);
  const route = (order: AgentWorkOrder): RouteResult => {
    const trace: RoutingTrace = {
      id: `trace-${order.id}`,
      workOrderId: order.id as string,
      catalogSnapshotId: "fixture",
      query: order.objective,
      eligibleCandidateIds: ["codex/fixture"],
      anonymousCards: [],
      method: "explicit",
      reranker: null,
      scores: {},
      selectedCandidateId: "codex/fixture",
      createdAt: new Date().toISOString(),
    };
    return { harness: "codex", model: "fixture", trace };
  };
  const router = { route: async (order: AgentWorkOrder) => route(order) } as ModelRouter;
  const secrets = new SecretStore("dev.symphony.worker-process-tests");
  const coordinator = new AgentCoordinator(loaded, store, drivers, router, new PassiveObserver(loaded, secrets, store));
  return { store, coordinator, driver, loaded };
}

describe("worker process reconciliation", () => {
  it("adopts and terminates a controller-lost hosted lease even after its agent is terminal", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-controller-lost-retirement-"));
    temporary.push(root);
    const driver = new HostedAdoptionDriver();
    const { store, coordinator } = fixture(root, driver);
    const { agent: active, order } = activeAgent(root, "controller-lost-retirement");
    const terminal = AgentRecordSchema.parse({
      ...active,
      status: "failed",
      error: "Controller reconnect grace exhausted.",
      finishedAt: new Date().toISOString(),
    });
    store.saveAgent(terminal);
    store.setMetadata(`work-order:${terminal.id}`, order);
    const host = identity(7442, "boot:controller-lost-host");
    const leaseId = saveOldHostedLease(store, terminal, host);
    const adoptLease = vi.spyOn(store, "adoptWorkerProcessLease");
    store.durablyTouchWorkerProcessLease(leaseId, {
      retirementRequestedAt: new Date().toISOString(),
      retirementReason: "controller-lost",
      error: "Worker-host controller reconnect grace exhausted.",
    });
    expect(store.getWorkerProcessLease(leaseId)).toMatchObject({ retirementReason: "controller-lost" });

    const close = vi.fn();
    const fake = Object.assign(new EventEmitter(), {
      accepted: {
        hostInstanceId: `host-instance-${terminal.id}`,
        workerPid: 4343,
        workerRunning: true,
      },
      socket: { destroyed: false },
      close,
    });
    const request = vi.fn(async (message: Record<string, unknown>) => {
      if (message.type === "shutdown") {
        fake.socket.destroyed = true;
        queueMicrotask(() => fake.emit("close"));
      }
      return { state: "applied" };
    });
    fake.request = request;
    const connect = vi.spyOn(WorkerHostConnection, "connect").mockResolvedValue(fake as unknown as WorkerHostConnection);

    coordinator.reconcileWorkerProcesses(() => ({ status: "exact", identity: host, detail: "Exact live controller-lost host." }));
    expect(store.recentEvents({ agentId: terminal.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "supervisor.host.adoption-pending", payload: expect.objectContaining({ retirementReason: "controller-lost" }) }),
    ]));
    await coordinator.recover();

    expect(driver.resumes).toBe(0);
    expect(adoptLease).toHaveBeenCalled();
    expect(store.getWorkerProcessLease(leaseId)).toMatchObject({ daemonOwnerId: expect.not.stringMatching(/^previous-daemon$/u), state: "exited" });
    expect(store.recentEvents({ agentId: terminal.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "supervisor.host.adopted" }),
    ]));
    expect(connect).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: "signal", signal: "SIGTERM" }));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: "shutdown" }));
    expect(close).toHaveBeenCalledOnce();
    expect(store.getWorkerProcessLease(leaseId)).toMatchObject({
      state: "exited",
      retirementRequestedAt: null,
      retirementReason: null,
      error: "Controller-lost worker-host retirement completed.",
    });
    expect(store.recentEvents({ agentId: terminal.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "supervisor.host.adopted", payload: expect.objectContaining({ continuity: "controller-lost-retirement-adopted" }) }),
      expect.objectContaining({ type: "supervisor.process.exited", payload: expect.objectContaining({ retirementReason: "controller-lost" }) }),
    ]));
    store.close();
  });

  it("never signals a PID-reuse mismatch and fails the agent closed", () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-mismatch-"));
    temporary.push(root);
    const { store, coordinator } = fixture(root);
    const { agent, order } = activeAgent(root, "mismatch");
    store.saveAgent(agent);
    store.setMetadata(`work-order:${agent.id}`, order);
    const leaseId = saveOldLease(store, agent, identity());
    const kill = vi.spyOn(process, "kill");

    coordinator.reconcileWorkerProcesses(() => ({
      status: "mismatch",
      identity: identity(4242, "boot:999"),
      detail: "PID was reused.",
    }));

    expect(kill).not.toHaveBeenCalled();
    expect(store.getWorkerProcessLease(leaseId)?.state).toBe("identity-mismatch");
    expect(coordinator.get(agent.id)).toMatchObject({ status: "interrupted", error: expect.stringContaining("different birth identity") });
    expect(store.recentEvents({ agentId: agent.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "supervisor.identity-mismatch", payload: expect.objectContaining({ signalAttempted: false }) }),
    ]));
    store.close();
  });

  it("does not resume a strongly verified live orphan after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-orphan-"));
    temporary.push(root);
    const { store, coordinator, driver } = fixture(root);
    const { agent, order } = activeAgent(root, "orphan");
    store.saveAgent(agent);
    store.setMetadata(`work-order:${agent.id}`, order);
    const expected = identity();
    const leaseId = saveOldLease(store, agent, expected);

    coordinator.reconcileWorkerProcesses(() => ({ status: "exact", identity: expected, detail: "Exact live process." }));
    await coordinator.recover();

    expect(driver.resumes).toBe(0);
    expect(store.getWorkerProcessLease(leaseId)?.state).toBe("orphaned");
    expect(coordinator.get(agent.id).status).toBe("interrupted");
    store.close();
  });

  it("allows normal native-session recovery after the old process is confirmed dead", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-dead-"));
    temporary.push(root);
    const { store, coordinator, driver } = fixture(root);
    const { agent, order } = activeAgent(root, "dead");
    store.saveAgent(agent);
    store.setMetadata(`work-order:${agent.id}`, order);
    const leaseId = saveOldLease(store, agent, identity());

    coordinator.reconcileWorkerProcesses(() => ({ status: "dead", detail: "No such PID." }));
    await coordinator.recover();

    expect(driver.resumes).toBe(1);
    expect(store.getWorkerProcessLease(leaseId)?.state).toBe("exited");
    store.close();
  });

  it("stages and atomically adopts an authenticated hosted Codex process", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-hosted-adoption-"));
    temporary.push(root);
    const driver = new HostedAdoptionDriver();
    const { store, coordinator, loaded } = fixture(root, driver);
    loaded.config.workerHosts.enabled = false;
    const { agent, order } = activeAgent(root, "hosted-adoption");
    store.saveAgent(agent);
    store.setMetadata(`work-order:${agent.id}`, order);
    const host = identity(4242, "boot:host");
    const leaseId = saveOldHostedLease(store, agent, host);

    coordinator.reconcileWorkerProcesses(() => ({ status: "exact", identity: host, detail: "Exact live host." }));
    expect(store.getWorkerProcessLease(leaseId)).toMatchObject({ state: "running", daemonOwnerId: "previous-daemon" });
    await coordinator.recover();

    expect(driver.resumes).toBe(1);
    expect(driver.adoptedLeaseId).toBe(leaseId);
    expect(driver.adoptedOwnerEpoch).toBeGreaterThan(1);
    expect(store.getWorkerProcessLease(leaseId)).toMatchObject({
      state: "running",
      daemonOwnerId: expect.not.stringMatching(/^previous-daemon$/u),
      transport: { kind: "worker-host", ownerEpoch: driver.adoptedOwnerEpoch },
    });
    expect(coordinator.get(agent.id).status).toBe("running");
    expect(store.recentEvents({ agentId: agent.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "supervisor.host.adoption-pending" }),
      expect.objectContaining({ type: "supervisor.host.adopted" }),
      expect.objectContaining({ type: "agent.recovered", payload: expect.objectContaining({ continuity: "native-run-reattached" }) }),
    ]));
    store.close();
  });

  it("stages and atomically adopts an authenticated hosted OpenCode service", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-opencode-adoption-"));
    temporary.push(root);
    const driver = new HostedOpenCodeAdoptionDriver();
    const { store, coordinator } = fixture(root, driver);
    const { agent, order } = activeAgent(root, "opencode-adoption", "opencode");
    store.saveAgent(agent);
    store.setMetadata(`work-order:${agent.id}`, order);
    const host = identity(6242, "boot:opencode-host");
    const leaseId = saveOldHostedLease(store, agent, host);

    coordinator.reconcileWorkerProcesses(() => ({ status: "exact", identity: host, detail: "Exact live OpenCode host." }));
    await coordinator.recover();

    expect(driver.resumes).toBe(1);
    expect(driver.adoptedLeaseId).toBe(leaseId);
    expect(store.getWorkerProcessLease(leaseId)).toMatchObject({
      driver: "opencode",
      state: "running",
      daemonOwnerId: expect.not.stringMatching(/^previous-daemon$/u),
      transport: { kind: "worker-host", ownerEpoch: expect.any(Number) },
    });
    expect(coordinator.get(agent.id).status).toBe("running");
    expect(store.recentEvents({ agentId: agent.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "supervisor.host.adoption-pending" }),
      expect.objectContaining({ type: "supervisor.host.adopted" }),
      expect.objectContaining({ type: "agent.recovered", payload: expect.objectContaining({ continuity: "native-run-reattached" }) }),
    ]));
    store.close();
  });

  it("stages and atomically adopts an authenticated hosted Claude SDK process", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-claude-adoption-"));
    temporary.push(root);
    const driver = new HostedClaudeAdoptionDriver();
    const { store, coordinator, loaded } = fixture(root, driver);
    loaded.config.workerHosts.enabled = false;
    const { agent, order } = activeAgent(root, "claude-adoption", "claude");
    store.saveAgent(agent);
    store.setMetadata(`work-order:${agent.id}`, order);
    const host = identity(6742, "boot:claude-host");
    const leaseId = saveOldHostedLease(store, agent, host);

    coordinator.reconcileWorkerProcesses(() => ({ status: "exact", identity: host, detail: "Exact live Claude host." }));
    await coordinator.recover();

    expect(driver.resumes).toBe(1);
    expect(driver.adoptedLeaseId).toBe(leaseId);
    expect(store.getWorkerProcessLease(leaseId)).toMatchObject({
      driver: "claude",
      role: "claude-sdk-host",
      state: "running",
      daemonOwnerId: expect.not.stringMatching(/^previous-daemon$/u),
      transport: { kind: "worker-host", ownerEpoch: expect.any(Number) },
    });
    expect(coordinator.get(agent.id).status).toBe("running");
    store.close();
  });

  it("fails a mismatched retained Claude host closed without signaling it", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-claude-mismatch-"));
    temporary.push(root);
    const driver = new HostedClaudeAdoptionDriver();
    const { store, coordinator } = fixture(root, driver);
    const { agent, order } = activeAgent(root, "claude-mismatch", "claude");
    store.saveAgent(agent);
    store.setMetadata(`work-order:${agent.id}`, order);
    const leaseId = saveOldHostedLease(store, agent, identity(6842, "boot:claude-original"));
    const kill = vi.spyOn(process, "kill");

    coordinator.reconcileWorkerProcesses(() => ({
      status: "mismatch",
      identity: identity(6842, "boot:claude-reused"),
      detail: "Claude host PID was reused.",
    }));
    await coordinator.recover();

    expect(kill).not.toHaveBeenCalled();
    expect(driver.resumes).toBe(0);
    expect(store.getWorkerProcessLease(leaseId)?.state).toBe("identity-mismatch");
    expect(coordinator.get(agent.id)).toMatchObject({ status: "interrupted", error: expect.stringContaining("different birth identity") });
    store.close();
  });

  it("stages and atomically adopts an authenticated hosted Pi RPC process even when new hosts are disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-pi-adoption-"));
    temporary.push(root);
    const driver = new HostedPiAdoptionDriver();
    const { store, coordinator, loaded } = fixture(root, driver);
    loaded.config.workerHosts.enabled = false;
    const { agent, order } = activeAgent(root, "pi-adoption", "pi");
    store.saveAgent(agent);
    store.setMetadata(`work-order:${agent.id}`, order);
    const host = identity(7242, "boot:pi-host");
    const leaseId = saveOldHostedLease(store, agent, host);

    coordinator.reconcileWorkerProcesses(() => ({ status: "exact", identity: host, detail: "Exact live Pi host." }));
    await coordinator.recover();

    expect(driver.resumes).toBe(1);
    expect(driver.adoptedLeaseId).toBe(leaseId);
    expect(store.getWorkerProcessLease(leaseId)).toMatchObject({
      driver: "pi",
      state: "running",
      daemonOwnerId: expect.not.stringMatching(/^previous-daemon$/u),
      transport: { kind: "worker-host", ownerEpoch: expect.any(Number) },
    });
    expect(coordinator.get(agent.id).status).toBe("running");
    expect(store.recentEvents({ agentId: agent.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "supervisor.host.adoption-pending" }),
      expect.objectContaining({ type: "supervisor.host.adopted" }),
      expect.objectContaining({ type: "agent.recovered", payload: expect.objectContaining({ continuity: "native-run-reattached" }) }),
    ]));
    store.close();
  });

  it("reattaches a completed hosted Codex session so later turns remain available", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-hosted-completed-"));
    temporary.push(root);
    const driver = new HostedAdoptionDriver();
    driver.resumeState = "idle";
    const { store, coordinator } = fixture(root, driver);
    const { agent: active, order } = activeAgent(root, "hosted-completed");
    const completed = AgentRecordSchema.parse({
      ...active,
      status: "completed",
      output: { result: "retained" },
      finishedAt: new Date().toISOString(),
    });
    store.saveAgent(completed);
    store.setMetadata(`work-order:${completed.id}`, order);
    const host = identity(4242, "boot:completed-host");
    const leaseId = saveOldHostedLease(store, completed, host);

    coordinator.reconcileWorkerProcesses(() => ({ status: "exact", identity: host, detail: "Exact live host." }));
    await coordinator.recover();

    expect(driver.resumes).toBe(1);
    expect(coordinator.hasSession(completed.id)).toBe(true);
    expect(coordinator.get(completed.id)).toMatchObject({ status: "completed", output: { result: "retained" } });
    expect(store.getWorkerProcessLease(leaseId)).toMatchObject({
      state: "running",
      daemonOwnerId: expect.not.stringMatching(/^previous-daemon$/u),
    });
    expect(store.recentEvents({ agentId: completed.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "supervisor.host.adoption-pending" }),
      expect.objectContaining({ type: "supervisor.host.adopted" }),
      expect.objectContaining({ type: "agent.recovered", payload: expect.objectContaining({ continuity: "terminal-event-observed" }) }),
    ]));
    store.close();
  });

  it("hydrates a starting agent from a hosted lease after native turn acceptance", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-hosted-start-window-"));
    temporary.push(root);
    const driver = new HostedAdoptionDriver();
    const { store, coordinator } = fixture(root, driver);
    const { agent: active, order } = activeAgent(root, "hosted-start-window");
    store.saveAgent(active);
    store.setMetadata(`work-order:${active.id}`, order);
    const host = identity(4242, "boot:start-window-host");
    const leaseId = saveOldHostedLease(store, active, host);
    store.saveAgent(AgentRecordSchema.parse({
      ...active,
      status: "starting",
      nativeSessionId: null,
      nativeRunId: null,
      updatedAt: new Date().toISOString(),
    }));

    coordinator.reconcileWorkerProcesses(() => ({ status: "exact", identity: host, detail: "Exact live host." }));
    await coordinator.recover();

    expect(driver.resumes).toBe(1);
    expect(coordinator.get(active.id)).toMatchObject({
      status: "running",
      nativeSessionId: active.nativeSessionId,
      nativeRunId: active.nativeRunId,
    });
    expect(store.getWorkerProcessLease(leaseId)).toMatchObject({
      state: "running",
      daemonOwnerId: expect.not.stringMatching(/^previous-daemon$/u),
    });
    expect(store.recentEvents({ agentId: active.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent.session.hydrated", payload: expect.objectContaining({ continuity: "lease-authoritative-native-identity" }) }),
      expect.objectContaining({ type: "agent.recovered", payload: expect.objectContaining({ continuity: "native-run-reattached" }) }),
    ]));
    store.close();
  });

  it("fails closed when more than one hosted lease claims the same agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-hosted-ambiguous-"));
    temporary.push(root);
    const driver = new HostedAdoptionDriver();
    const { store, coordinator } = fixture(root, driver);
    const { agent, order } = activeAgent(root, "hosted-ambiguous");
    store.saveAgent(agent);
    store.setMetadata(`work-order:${agent.id}`, order);
    saveOldHostedLease(store, agent, identity(4242, "boot:host-a"), "a");
    saveOldHostedLease(store, agent, identity(4243, "boot:host-b"), "b");

    coordinator.reconcileWorkerProcesses((candidate) => ({ status: "exact", identity: candidate, detail: "Exact live host." }));
    await coordinator.recover();

    expect(driver.resumes).toBe(0);
    expect(coordinator.get(agent.id)).toMatchObject({ status: "interrupted", error: expect.stringContaining("Multiple potentially live worker-host leases") });
    const ambiguousLeases = store.listWorkerProcessLeases({ agentId: agent.id });
    expect(ambiguousLeases).toHaveLength(2);
    expect(ambiguousLeases.every((lease) => ["unverified", "orphaned"].includes(lease.state))).toBe(true);
    expect(ambiguousLeases.some((lease) => lease.state === "unverified")).toBe(true);
    expect(store.recentEvents({ agentId: agent.id }).filter((event) => event.type === "supervisor.host.adoption-ambiguous")).toHaveLength(1);
    store.close();
  });

  it("adopts the one exact live hosted lease when another historical claim is dead", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-hosted-live-plus-dead-"));
    temporary.push(root);
    const driver = new HostedAdoptionDriver();
    const { store, coordinator } = fixture(root, driver);
    const { agent, order } = activeAgent(root, "hosted-live-plus-dead");
    store.saveAgent(agent);
    store.setMetadata(`work-order:${agent.id}`, order);
    const liveHost = identity(4242, "boot:host-live");
    const deadHost = identity(4243, "boot:host-dead");
    const liveLeaseId = saveOldHostedLease(store, agent, liveHost, "live");
    const deadLeaseId = saveOldHostedLease(store, agent, deadHost, "dead");

    coordinator.reconcileWorkerProcesses((candidate) => candidate.pid === liveHost.pid
      ? { status: "exact", identity: candidate, detail: "Exact live host." }
      : { status: "dead", detail: "Historical worker host no longer exists." });
    await coordinator.recover();

    expect(driver.resumes).toBe(1);
    expect(driver.adoptedLeaseId).toBe(liveLeaseId);
    expect(store.getWorkerProcessLease(liveLeaseId)).toMatchObject({ state: "running", daemonOwnerId: expect.not.stringMatching(/^previous-daemon$/u) });
    expect(store.getWorkerProcessLease(deadLeaseId)).toMatchObject({ state: "exited", error: expect.stringContaining("no longer exists") });
    expect(coordinator.get(agent.id).status).toBe("running");
    expect(store.recentEvents({ agentId: agent.id }).filter((event) => event.type === "supervisor.host.adoption-ambiguous")).toHaveLength(0);
    store.close();
  });

  it("fails closed when one hosted claim is exact and another remains potentially live but unverified", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-hosted-exact-unverified-"));
    temporary.push(root);
    const driver = new HostedAdoptionDriver();
    const { store, coordinator } = fixture(root, driver);
    const { agent, order } = activeAgent(root, "hosted-exact-unverified");
    store.saveAgent(agent);
    store.setMetadata(`work-order:${agent.id}`, order);
    const exactHost = identity(4242, "boot:host-exact");
    saveOldHostedLease(store, agent, exactHost, "exact");
    saveOldHostedLease(store, agent, identity(4243, "boot:host-unverified"), "unverified");

    coordinator.reconcileWorkerProcesses((candidate) => candidate.pid === exactHost.pid
      ? { status: "exact", identity: candidate, detail: "Exact live host." }
      : { status: "unverified", identity: candidate, detail: "Host liveness could not be disproved." });
    await coordinator.recover();

    expect(driver.resumes).toBe(0);
    expect(coordinator.get(agent.id)).toMatchObject({ status: "interrupted", error: expect.stringContaining("Multiple potentially live worker-host leases") });
    expect(store.recentEvents({ agentId: agent.id }).filter((event) => event.type === "supervisor.host.adoption-ambiguous")).toHaveLength(1);
    store.close();
  });

  it("fails closed when two hosted claims are both potentially live but unverified", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-hosted-two-unverified-"));
    temporary.push(root);
    const driver = new HostedAdoptionDriver();
    const { store, coordinator } = fixture(root, driver);
    const { agent, order } = activeAgent(root, "hosted-two-unverified");
    store.saveAgent(agent);
    store.setMetadata(`work-order:${agent.id}`, order);
    saveOldHostedLease(store, agent, identity(4242, "boot:host-unverified-a"), "unverified-a");
    saveOldHostedLease(store, agent, identity(4243, "boot:host-unverified-b"), "unverified-b");

    coordinator.reconcileWorkerProcesses((candidate) => ({
      status: "unverified",
      identity: candidate,
      detail: "Host liveness could not be disproved.",
    }));
    await coordinator.recover();

    expect(driver.resumes).toBe(0);
    expect(coordinator.get(agent.id)).toMatchObject({ status: "interrupted", error: expect.stringContaining("Multiple potentially live worker-host leases") });
    expect(store.recentEvents({ agentId: agent.id }).filter((event) => event.type === "supervisor.host.adoption-ambiguous")).toHaveLength(1);
    store.close();
  });

  it("atomically settles a synchronous terminal resume while updating its process lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-terminal-resume-"));
    temporary.push(root);
    const driver = new SynchronousTerminalResumeDriver();
    const { store, coordinator } = fixture(root, driver);
    const { agent, order } = activeAgent(root, "terminal-resume");
    store.saveAgent(agent);
    store.setMetadata(`work-order:${agent.id}`, order);
    saveOldLease(store, agent, identity());

    coordinator.reconcileWorkerProcesses(() => ({ status: "dead", detail: "No such PID." }));
    await coordinator.recover();

    expect(coordinator.get(agent.id)).toMatchObject({ status: "completed", output: { recovered: true }, error: null });
    expect(store.claimNativeDriverEvent({
      agentId: agent.id,
      eventKind: "run.completed",
      nativeEventId: "turn-1",
    })).toBe(false);
    expect(store.listWorkerProcessLeases({ agentId: agent.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "resume-fixture", state: "exited", activeTurnId: null }),
    ]));
    expect(store.recentEvents({ agentId: agent.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "driver.run.completed" }),
      expect.objectContaining({ type: "agent.recovered", payload: expect.objectContaining({ continuity: "terminal-event-observed" }) }),
    ]));
    store.close();
  });

  it("persists a process reservation before a hung native startup can time out", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-hung-start-"));
    temporary.push(root);
    const driver = new LedgerDriver();
    driver.hungStart = true;
    const { store, coordinator } = fixture(root, driver);

    const created = await coordinator.create(workOrder(root, "hung-start"));
    await expect.poll(() => coordinator.get(created.id).status).toBe("interrupted");

    expect(store.listWorkerProcessLeases({ agentId: created.id })).toEqual([
      expect.objectContaining({ state: "reserved", role: "hung-fixture", identity: null }),
    ]);
    store.close();
  });

  it("reconciles a missed exit callback without redispatching the native work", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-missed-callback-"));
    temporary.push(root);
    const driver = new MissedExitDriver();
    const { store, coordinator } = fixture(root, driver);

    const created = await coordinator.create(workOrder(root, "missed-exit"));
    await expect.poll(() => coordinator.get(created.id).status).toBe("running");
    const lease = store.listWorkerProcessLeases({ agentId: created.id, states: ["running"] })[0];
    if (!lease) throw new Error("Expected a running native process lease.");

    coordinator.reconcileActiveProcesses(() => ({
      status: "dead",
      detail: "Fixture process exited before its driver callback was delivered.",
    }));
    await expect.poll(() => coordinator.get(created.id).status).toBe("interrupted");

    expect(store.getWorkerProcessLease(lease.id)).toMatchObject({
      state: "exited",
      activeTurnId: null,
      error: expect.stringContaining("Fixture process exited"),
    });
    expect(store.recentEvents({ agentId: created.id }).filter((event) => event.type === "agent.interrupted")).toHaveLength(1);
    expect(store.recentEvents({ agentId: created.id }).filter((event) => event.type === "supervisor.process.exited")).toHaveLength(1);
    expect(driver.resumes).toBe(0);

    // A second pass is idempotent and cannot redispatch or emit another
    // interruption once the durable agent is terminal.
    coordinator.reconcileActiveProcesses(() => ({ status: "dead", detail: "Should not be consulted again." }));
    expect(store.recentEvents({ agentId: created.id }).filter((event) => event.type === "agent.interrupted")).toHaveLength(1);
    store.close();
  });

  it("keeps an exact live retained process running during reconciliation", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-process-live-reconcile-"));
    temporary.push(root);
    const driver = new MissedExitDriver();
    const { store, coordinator } = fixture(root, driver);

    const created = await coordinator.create(workOrder(root, "live-reconcile"));
    await expect.poll(() => coordinator.get(created.id).status).toBe("running");
    const lease = store.listWorkerProcessLeases({ agentId: created.id, states: ["running"] })[0];
    if (!lease) throw new Error("Expected a running native process lease.");
    const beforeEvents = store.recentEvents({ agentId: created.id });

    coordinator.reconcileActiveProcesses(() => ({
      status: "exact",
      identity: driver.attachedIdentity,
      detail: "Fixture process remains alive with the recorded birth identity.",
    }));

    expect(coordinator.get(created.id)).toMatchObject({ status: "running" });
    expect(store.getWorkerProcessLease(lease.id)).toMatchObject({ state: "running" });
    expect(store.recentEvents({ agentId: created.id })).toHaveLength(beforeEvents.length);
    expect(driver.resumes).toBe(0);
    store.close();
  });
});
