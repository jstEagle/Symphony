import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig, writeDefaultConfig } from "../packages/config/src/index.js";
import {
  AgentRecordSchema,
  AgentWorkOrderSchema,
  type AgentRecord,
  type AgentWorkOrder,
  type ObjectiveRunRecord,
} from "../packages/protocol/src/index.js";
import { ObjectiveRuntime } from "../packages/workflow/src/objective-runtime.js";
import { ObjectiveStoreRepository } from "../packages/workflow/src/objective-store-repository.js";
import { ObjectiveSupervisionRunner } from "../packages/workflow/src/objective-supervision-runner.js";
import { createStore, type SymphonyStore } from "../packages/storage/src/index.js";

const authority = { actor: { type: "system" as const, id: "runner-test" }, permissionCeiling: "full-access" as const };
const temporary: string[] = [];
const stores: SymphonyStore[] = [];

function task(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    objective: `Complete ${id}`,
    dependsOn: [],
    outputSchema: {},
    model: "fixture",
    harness: "auto" as const,
    inputs: [],
    requiresApproval: false,
    workspace: { path: "/tmp/objective-runner", dirtyPolicy: "local-only" as const },
    ...extra,
  };
}

function conductor(runId = "chat-run-1"): AgentRecord {
  return AgentRecordSchema.parse({
    id: "conductor-1",
    logicalAgentId: "conductor-1",
    workflowId: "workflow-1",
    runId,
    parentAgentId: null,
    depth: 0,
    objective: "Coordinate this objective.",
    missionHash: "workflow-hash-1",
    requestedHarness: "auto",
    requestedModel: "auto",
    harness: null,
    model: null,
    permissions: "full-access",
    status: "running",
    nativeSessionId: null,
    nativeRunId: null,
    workspacePath: "/tmp/objective-runner",
    output: null,
    error: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: null,
  });
}

function fixture(initialStatus: AgentRecord["status"] = "running", emitProgressDuringCreate = false) {
  const root = mkdtempSync(join(tmpdir(), "symphony-objective-runner-"));
  temporary.push(root);
  writeDefaultConfig(root);
  const loaded = loadConfig({ rootDirectory: root });
  const store = createStore(loaded.dataDirectory);
  stores.push(store);
  const repository = new ObjectiveStoreRepository(store);
  let id = 0;
  const runtime = new ObjectiveRuntime(repository, {
    id: () => `runner-id-${++id}`,
    now: () => "2026-09-01T00:00:01.000Z",
  });
  const createdAgents: AgentWorkOrder[] = [];
  const create = async (input: unknown): Promise<AgentRecord> => {
    const order = AgentWorkOrderSchema.parse(input);
    createdAgents.push(order);
    const existing = store.getAgentByLogicalAgentId(order.id as string);
    if (existing) return existing;
    const record = AgentRecordSchema.parse({
      id: `native-${order.id}`,
      logicalAgentId: order.id,
      workflowId: order.workflowId,
      runId: order.runId,
      parentAgentId: order.parentAgentId,
      depth: order.depth,
      objective: order.objective,
      missionHash: order.mission.hash,
      requestedHarness: order.harness,
      requestedModel: order.model,
      harness: null,
      model: null,
      permissions: order.permissions,
      status: initialStatus,
      nativeSessionId: null,
      nativeRunId: null,
      workspacePath: order.workspace.path,
      output: null,
      error: null,
      createdAt: "2026-09-01T00:00:01.000Z",
      updatedAt: "2026-09-01T00:00:01.000Z",
      startedAt: "2026-09-01T00:00:01.000Z",
      finishedAt: null,
    });
    store.saveAgent(record);
    if (emitProgressDuringCreate) {
      store.appendEvent({
        type: "agent.routed",
        workflowId: order.workflowId,
        runId: order.runId,
        agentId: record.id,
        occurredAt: "2026-09-01T00:00:01.000Z",
        payload: { harness: "codex" },
        provenance: { source: "daemon" },
      });
    }
    return record;
  };
  const agents = { create, message: async () => ({ receiptId: "message-1", queued: true }) } as never;
  return { root, store, repository, runtime, agents, createdAgents };
}

function createObjective(runtime: ObjectiveRuntime, store: SymphonyStore, input: Record<string, unknown> = {}): ObjectiveRunRecord {
  const run = runtime.create({
    runId: "objective-runner-1",
    objectiveId: "objective-runner-1",
    workflowId: "workflow-1",
    workflowRevision: 1,
    workflowHash: "workflow-hash-1",
    conductorAgentId: "conductor-1",
    spec: {
      id: "objective-runner-1",
      statement: "Complete the runner test objective.",
      criteria: [],
      approvalPolicy: { mode: "never" },
      maxReplans: 1,
    },
    requestKey: "runner-create-1",
    ...input,
  }, authority);
  store.saveAgent(conductor());
  return run;
}

describe("ObjectiveSupervisionRunner", () => {
  it("dispatches with a stable logical attempt, reconciles terminal evidence, and settles finish after restart", async () => {
    const { store, repository, runtime, agents, createdAgents } = fixture();
  const run = createObjective(runtime, store, { tasks: [task("build")] });
    const runner = new ObjectiveSupervisionRunner(runtime, repository, agents, store, { authority });
    runner.start();

    const dispatched = await runner.step(run.runId);
    expect(dispatched.action).toBe("dispatched");
    expect(createdAgents).toHaveLength(1);
    expect(createdAgents[0]?.id).toContain("objective-attempt:objective-runner-1:build:");
    expect(createdAgents[0]?.permissions).toBe("read-only");
    expect(store.getMetadata(`objective-assignment:${run.runId}:${dispatched.intent.intentId}:build`)).toMatchObject({
      state: "dispatched",
      attemptId: createdAgents[0]?.id,
      agentId: "native-" + createdAgents[0]?.id,
    });
    expect(store.getObjectiveRun(run.runId)?.tasks[0]).toMatchObject({ state: "running", agentId: "native-" + createdAgents[0]?.id });

    const restarted = new ObjectiveSupervisionRunner(runtime, repository, agents, store, { authority });
    const waiting = await restarted.step(run.runId);
    expect(waiting.intent.kind).toBe("evaluate");
    expect(waiting.action).toBe("waiting");

    const agent = store.getAgent("native-" + createdAgents[0]?.id);
    if (!agent) throw new Error("runner fixture agent missing");
    store.saveAgent({ ...agent, status: "completed", output: { ok: true }, finishedAt: "2026-09-01T00:00:02.000Z" });
    store.appendEvent({
      type: "agent.completed",
      workflowId: run.workflowId,
      runId: run.runId,
      agentId: agent.id,
      occurredAt: "2026-09-01T00:00:02.000Z",
      payload: { output: { ok: true } },
      provenance: { source: "daemon" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getObjectiveRun(run.runId)?.state).toBe("succeeded");

    const finished = await runner.step(run.runId);
    expect(["settled", "noop"]).toContain(finished.action);
    expect(store.getMetadata(`objective-supervision:${run.runId}`)).toMatchObject({ state: "settled", kind: "finish" });
    const afterRestart = await new ObjectiveSupervisionRunner(runtime, repository, agents, store, { authority }).step(run.runId);
    expect(afterRestart.action).toBe("noop");
    expect(createdAgents).toHaveLength(1);
    runner.stop();
  });

  it("records visible attention for an objective without a conductor and never guesses dispatch authority", async () => {
    const { store, repository, runtime, agents } = fixture();
    const run = createObjective(runtime, store, { conductorAgentId: null, tasks: [task("build")] });
    const runner = new ObjectiveSupervisionRunner(runtime, repository, agents, store, { authority });

    const result = await runner.step(run.runId);
    expect(result.action).toBe("attention");
    expect(store.getMetadata(`objective-supervision:${run.runId}`)).toMatchObject({ state: "attention", kind: "dispatch" });
    expect(store.recentEvents({ runId: run.runId, types: ["objective.supervisor.attention"] })).toMatchObject([{ agentId: null, provenance: { source: "daemon" } }]);
  });

  it("keeps a queued native assignment claimed until routing/startup evidence arrives", async () => {
    const { store, repository, runtime, agents, createdAgents } = fixture("queued");
    const run = createObjective(runtime, store, { tasks: [task("build")] });
    const runner = new ObjectiveSupervisionRunner(runtime, repository, agents, store, { authority });

    const waiting = await runner.step(run.runId);
    expect(waiting.action).toBe("waiting");
    expect(waiting.intent.kind).toBe("dispatch");
    expect(store.getObjectiveRun(run.runId)?.tasks[0]?.state).toBe("queued");
    expect(store.getMetadata(`objective-assignment:${run.runId}:${waiting.intent.intentId}:build`)).toMatchObject({ state: "claimed", agentId: "native-" + createdAgents[0]?.id });

    const queued = store.getAgent("native-" + createdAgents[0]?.id);
    if (!queued) throw new Error("queued fixture agent missing");
    store.saveAgent({ ...queued, status: "starting" });
    runner.start();
    store.appendEvent({
      type: "agent.routed",
      workflowId: run.workflowId,
      runId: run.runId,
      agentId: queued.id,
      occurredAt: "2026-09-01T00:00:02.000Z",
      payload: { harness: "codex" },
      provenance: { source: "daemon" },
    });
    await vi.waitFor(() => expect(store.getObjectiveRun(run.runId)?.tasks[0]?.state).toBe("running"));
    expect(createdAgents).toHaveLength(2); // replayed logical create, not a second native identity
    expect(createdAgents[0]?.id).toBe(createdAgents[1]?.id);
    runner.stop();
  });

  it("self-drains a progress event that arrives while dispatch is in flight", async () => {
    const { store, repository, runtime, agents } = fixture("starting", true);
    const run = createObjective(runtime, store, { tasks: [task("build")] });
    const runner = new ObjectiveSupervisionRunner(runtime, repository, agents, store, { authority });
    runner.start();

    const dispatched = await runner.step(run.runId);
    expect(dispatched.action).toBe("dispatched");
    expect(store.getObjectiveRun(run.runId)?.tasks[0]?.state).toBe("running");
    await vi.waitFor(() => expect(store.getMetadata(`objective-supervision:${run.runId}`)).toMatchObject({ kind: "evaluate", state: "waiting" }));
    runner.stop();
  });

  it("waits for an in-flight supervision step before stop resolves", async () => {
    const base = fixture("starting");
    const run = createObjective(base.runtime, base.store, { tasks: [task("build")] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayedAgents = {
      create: async (input: unknown) => {
        await gate;
        return (base.agents as { create: (value: unknown) => Promise<AgentRecord> }).create(input);
      },
      message: async () => ({ receiptId: "message-1", queued: true }),
    } as never;
    const runner = new ObjectiveSupervisionRunner(base.runtime, base.repository, delayedAgents, base.store, { authority });
    runner.start();
    const operation = runner.step(run.runId);
    let stopped = false;
    const stopping = runner.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await operation;
    await stopping;
    expect(stopped).toBe(true);
  });

  it("wakes from objective events even when the conductor belongs to a different chat run", async () => {
    const { store, repository, runtime, agents } = fixture();
    const run = createObjective(runtime, store, { tasks: [task("build")] });
    const existing = AgentRecordSchema.parse({
      ...conductor("objective-runner-1"),
      id: "native-existing",
      logicalAgentId: "native-existing",
      runId: run.runId,
      parentAgentId: "conductor-1",
      status: "running",
      finishedAt: null,
    });
    store.saveAgent(existing);
    runtime.checkpoint(run.runId, {
      eventCursor: store.latestCursor(),
      taskUpdates: [{ taskId: "build", state: "running", agentId: existing.id, attemptId: "objective-attempt-existing" }],
      reason: "Attach the existing native task attempt.",
      requestKey: "runner-existing-checkpoint",
    }, authority);
    const runner = new ObjectiveSupervisionRunner(runtime, repository, agents, store, { authority });
    runner.start();
    await runner.step(run.runId);

    store.saveAgent({ ...existing, status: "completed", output: { ok: true }, finishedAt: "2026-09-01T00:00:02.000Z" });
    store.appendEvent({
      type: "agent.completed",
      workflowId: run.workflowId,
      runId: run.runId,
      agentId: existing.id,
      occurredAt: "2026-09-01T00:00:02.000Z",
      payload: { objectiveAttemptId: "objective-attempt-existing", output: { ok: true } },
      provenance: { source: "daemon" },
    });
    store.appendEvent({
      type: "objective.checkpoint.committed",
      workflowId: run.workflowId,
      runId: run.runId,
      agentId: "conductor-1",
      occurredAt: "2026-09-01T00:00:02.000Z",
      payload: { taskId: "build" },
      provenance: { source: "daemon" },
    });
    await vi.waitFor(() => expect(store.getObjectiveRun(run.runId)?.state).toBe("succeeded"));
    runner.stop();
  });

  it("uses one durable planner work order when a completed chat conductor has no reusable session", async () => {
    const { store, repository, runtime, agents, createdAgents } = fixture("starting");
    const run = createObjective(runtime, store, { tasks: [] });
    const completedConductor = { ...conductor("chat-run-1"), status: "completed" as const, finishedAt: "2026-09-01T00:00:02.000Z" };
    store.saveAgent(completedConductor);
    store.setMetadata("work-order:conductor-1", AgentWorkOrderSchema.parse({
      id: "conductor-1",
      workflowId: "workflow-1",
      runId: "chat-run-1",
      parentAgentId: null,
      depth: 0,
      mission: { id: "workflow-1", revision: 1, hash: "workflow-hash-1", statement: "Coordinate this objective.", keyResults: [] },
      objective: "Coordinate this objective.",
      model: "fixture",
      harness: "auto",
      permissions: "full-access",
      outputSchema: {},
      inputs: [],
      workspace: { path: "/tmp/objective-runner", dirtyPolicy: "local-only" },
    }) as never);
    const runner = new ObjectiveSupervisionRunner(runtime, repository, agents, store, { authority });

    const first = await runner.step(run.runId);
    expect(first.intent.kind).toBe("replan");
    expect(first.action).toBe("waiting");
    expect(createdAgents).toHaveLength(1);
    expect(createdAgents[0]?.id).toContain(`objective-planner:${run.runId}:${first.intent.intentId}`);
    expect(store.getMetadata(`objective-assignment:${run.runId}:${first.intent.intentId}:__objective_planner__`)).toMatchObject({ state: "dispatched" });

    const replay = await new ObjectiveSupervisionRunner(runtime, repository, agents, store, { authority }).step(run.runId);
    expect(replay.action).toBe("waiting");
    expect(createdAgents).toHaveLength(2);
    expect(createdAgents[0]?.id).toBe(createdAgents[1]?.id);
  });

  it("waits for durable terminal evidence before reconciling a fast planner replay", async () => {
    const { store, repository, runtime, agents } = fixture("completed");
    const run = createObjective(runtime, store, { tasks: [] });
    const completedConductor = { ...conductor("chat-run-1"), status: "completed" as const, finishedAt: "2026-09-01T00:00:02.000Z" };
    store.saveAgent(completedConductor);
    store.setMetadata("work-order:conductor-1", AgentWorkOrderSchema.parse({
      id: "conductor-1",
      workflowId: "workflow-1",
      runId: "chat-run-1",
      parentAgentId: null,
      depth: 0,
      mission: { id: "workflow-1", revision: 1, hash: "workflow-hash-1", statement: "Coordinate this objective.", keyResults: [] },
      objective: "Coordinate this objective.",
      model: "fixture",
      harness: "auto",
      permissions: "full-access",
      outputSchema: {},
      inputs: [],
      workspace: { path: "/tmp/objective-runner", dirtyPolicy: "local-only" },
    }) as never);
    const runner = new ObjectiveSupervisionRunner(runtime, repository, agents, store, { authority });

    const first = await runner.step(run.runId);
    expect(first.action).toBe("waiting");
    if (first.intent.kind !== "replan") throw new Error("expected replan intent");
    const plannerId = `objective-planner:${run.runId}:${first.intent.intentId}`;
    const planner = store.getAgentByLogicalAgentId(plannerId);
    if (!planner) throw new Error("expected fast planner replay");
    store.appendEvent({
      type: "agent.completed",
      workflowId: run.workflowId,
      runId: run.runId,
      agentId: planner.id,
      occurredAt: "2026-09-01T00:00:02.000Z",
      payload: { objectiveAttemptId: plannerId },
      provenance: { source: "daemon", objectiveAttemptId: plannerId },
    });
    expect((await runner.step(run.runId)).action).toBe("attention");
  });
});
