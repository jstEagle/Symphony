import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, writeDefaultConfig } from "../packages/config/src/index.js";
import {
  AgentRecordSchema,
  AgentWorkOrderSchema,
  type AgentRecord,
  type AgentWorkOrder,
  type ObjectiveRunRecord,
} from "../packages/protocol/src/index.js";
import { ObjectiveRuntime } from "../packages/workflow/src/objective-runtime.js";
import { compileObjectiveControlPlan } from "../packages/workflow/src/objective-control-plan.js";
import { ObjectiveStoreRepository } from "../packages/workflow/src/objective-store-repository.js";
import { ObjectiveSupervisionRunner } from "../packages/workflow/src/objective-supervision-runner.js";
import { createStore, type SymphonyStore } from "../packages/storage/src/index.js";

const authority = {
  actor: { type: "system" as const, id: "objective-runner-integration" },
  permissionCeiling: "full-access" as const,
};

type FixtureOptions = Readonly<{
  /** Return an agent with a different run id to prove lineage fencing. */
  wrongRunId?: string;
}>;

type Fixture = Readonly<{
  root: string;
  store: SymphonyStore;
  repository: ObjectiveStoreRepository;
  runtime: ObjectiveRuntime;
  agents: {
    create(input: unknown): Promise<AgentRecord>;
    message(): Promise<{ receiptId: string; queued: boolean }>;
  };
  orders: AgentWorkOrder[];
  nativeLaunches: string[];
}>;

const fixtures: Fixture[] = [];

function objectiveTask(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    objective: `Complete ${id}`,
    dependsOn: [],
    outputSchema: {},
    model: "fixture",
    harness: "auto" as const,
    inputs: [],
    requiresApproval: false,
    workspace: { path: "/tmp/symphony-objective-runner", dirtyPolicy: "local-only" as const },
    ...extra,
  };
}

function conductor(runId: string): AgentRecord {
  return AgentRecordSchema.parse({
    id: "integration-conductor",
    logicalAgentId: "integration-conductor",
    workflowId: "integration-workflow",
    runId,
    parentAgentId: null,
    depth: 0,
    objective: "Coordinate this objective.",
    missionHash: "integration-workflow-hash",
    requestedHarness: "auto",
    requestedModel: "auto",
    harness: null,
    model: null,
    permissions: "full-access",
    status: "running",
    nativeSessionId: null,
    nativeRunId: null,
    workspacePath: "/tmp/symphony-objective-runner",
    output: null,
    error: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: null,
  });
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "symphony-objective-runner-integration-"));
  writeDefaultConfig(root);
  const loaded = loadConfig({ rootDirectory: root });
  const store = createStore(loaded.dataDirectory);
  const repository = new ObjectiveStoreRepository(store);
  let sequence = 0;
  const runtime = new ObjectiveRuntime(repository, {
    id: () => `integration-id-${++sequence}`,
    now: () => "2026-09-01T00:00:01.000Z",
  });
  const orders: AgentWorkOrder[] = [];
  const nativeLaunches: string[] = [];
  const create = async (input: unknown): Promise<AgentRecord> => {
    const order = AgentWorkOrderSchema.parse(input);
    orders.push(order);
    const existing = store.getAgentByLogicalAgentId(order.id as string);
    if (existing) return existing;
    nativeLaunches.push(order.id as string);
    const record = AgentRecordSchema.parse({
      id: `native-${order.id}`,
      logicalAgentId: order.id,
      workflowId: order.workflowId,
      runId: options.wrongRunId ?? order.runId,
      parentAgentId: order.parentAgentId,
      depth: order.depth,
      objective: order.objective,
      missionHash: order.mission.hash,
      requestedHarness: order.harness,
      requestedModel: order.model,
      harness: null,
      model: null,
      permissions: order.permissions,
      status: "running",
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
    return record;
  };
  const agents = {
    create,
    message: async () => ({ receiptId: "integration-message", queued: true }),
  };
  const fixture = { root, store, repository, runtime, agents, orders, nativeLaunches };
  fixtures.push(fixture);
  return fixture;
}

function createObjective(
  runtime: ObjectiveRuntime,
  store: SymphonyStore,
  overrides: Record<string, unknown> = {},
): ObjectiveRunRecord {
  const run = runtime.create({
    runId: "objective-runner-integration-run",
    objectiveId: "objective-runner-integration",
    workflowId: "integration-workflow",
    workflowRevision: 1,
    workflowHash: "integration-workflow-hash",
    conductorAgentId: "integration-conductor",
    spec: {
      id: "objective-runner-integration",
      statement: "Complete the integration objective.",
      criteria: [],
      approvalPolicy: { mode: "never" },
      maxReplans: 1,
    },
    requestKey: "objective-runner-integration-create",
    ...overrides,
  }, authority);
  store.saveAgent(conductor(run.runId));
  return run;
}

function agentFor(fixture: Fixture, order: AgentWorkOrder): AgentRecord {
  const agent = fixture.store.getAgentByLogicalAgentId(order.id as string);
  if (!agent) throw new Error(`Expected fake native agent ${order.id}`);
  return agent;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe("ObjectiveSupervisionRunner durable integration contract", () => {
  it("dispatches materialized fan-out agents through the durable runner and resumes after a runner restart", async () => {
    const fixture = makeFixture();
    const controlPlan = compileObjectiveControlPlan({
      id: "integration-workflow",
      name: "Fan-out integration workflow",
      mission: { statement: "Process every durable item.", keyResults: [] },
      workspace: { path: "/tmp/symphony-objective-runner" },
      inputSchema: { type: "object" },
      output: "steps",
      steps: [{
        id: "map-items",
        type: "fanout",
        source: "items",
        concurrency: 1,
        aggregation: { mode: "array" },
        itemTemplate: {
          id: "item-worker",
          type: "agent",
          objective: "Process {{ item.id }} as {{ itemKey }}.",
          model: "fixture",
          harness: "auto",
          outputSchema: {},
          workspace: { path: "/tmp/symphony-objective-runner", dirtyPolicy: "local-only" },
        },
      }],
      triggers: [{ id: "manual", type: "manual" }],
    }, { workflowRevision: 1, workflowHash: "integration-workflow-hash" });
    const run = createObjective(fixture.runtime, fixture.store, {
      controlPlan,
      context: { items: [{ id: "a" }, { id: "b" }] },
    });
    const first = new ObjectiveSupervisionRunner(fixture.runtime, fixture.repository, fixture.agents as never, fixture.store, { authority });
    expect((await first.step(run.runId)).intent.kind).toBe("sequence");
    const materialized = await first.step(run.runId);
    expect(materialized.intent.kind).toBe("fanout");
    expect(materialized.action).toBe("dispatched");
    expect(fixture.runtime.controlState(run.runId)?.snapshot.executions.filter((entry) => entry.fanoutScope)).toHaveLength(2);
    const dispatched = await first.step(run.runId);
    expect(dispatched.action).toBe("dispatched");
    expect(dispatched.intent.kind).toBe("agent");
    expect(fixture.nativeLaunches).toHaveLength(1);
    expect(fixture.orders[0]?.objective).toBe("Process a as a.");

    // A fresh runner must observe the durable assignment and never create a
    // second native agent for the same materialized item.
    const restarted = new ObjectiveSupervisionRunner(fixture.runtime, fixture.repository, fixture.agents as never, fixture.store, { authority });
    const waiting = await restarted.step(run.runId);
    expect(waiting.action).toBe("waiting");
    expect(fixture.nativeLaunches).toHaveLength(1);

    const order = fixture.orders[0];
    if (!order) throw new Error("fan-out dispatch order was not recorded");
    const agent = agentFor(fixture, order);
    fixture.store.saveAgent({ ...agent, status: "completed", output: { id: "a" }, finishedAt: "2026-09-01T00:00:02.000Z", updatedAt: "2026-09-01T00:00:02.000Z" });
    fixture.store.appendEvent({ type: "agent.completed", workflowId: run.workflowId, runId: run.runId, agentId: agent.id, occurredAt: "2026-09-01T00:00:02.000Z", payload: { output: { id: "a" } }, provenance: { source: "daemon" } });
    await restarted.step(run.runId);
    expect(fixture.runtime.controlState(run.runId)?.snapshot.frontier).toHaveLength(1);
    expect(fixture.runtime.controlState(run.runId)?.snapshot.executions.filter((entry) => entry.fanoutScope)).toHaveLength(2);
  });

  it("recovers a dispatched frontier without launching duplicate native work", async () => {
    const fixture = makeFixture();
    const run = createObjective(fixture.runtime, fixture.store, { tasks: [objectiveTask("build")] });
    const first = new ObjectiveSupervisionRunner(
      fixture.runtime,
      fixture.repository,
      fixture.agents as never,
      fixture.store,
      { authority },
    );

    const dispatched = await first.step(run.runId);
    expect(dispatched.action).toBe("dispatched");
    expect(fixture.nativeLaunches).toHaveLength(1);
    const order = fixture.orders[0];
    if (!order) throw new Error("dispatch order was not recorded");
    const taskRecord = fixture.runtime.get(run.runId).tasks[0];
    expect(taskRecord).toMatchObject({ attemptId: order.id, agentId: `native-${order.id}` });

    // A new runner has no in-memory state. It must observe the durable running
    // task, not derive a fresh attempt or start a second native session.
    const restarted = new ObjectiveSupervisionRunner(
      fixture.runtime,
      fixture.repository,
      fixture.agents as never,
      fixture.store,
      { authority },
    );
    const recovered = await restarted.step(run.runId);
    expect(recovered.intent.kind).toBe("evaluate");
    expect(recovered.action).toBe("waiting");
    expect(fixture.nativeLaunches).toEqual([order.id]);
    expect(fixture.runtime.get(run.runId).tasks[0]?.attemptId).toBe(order.id);
  });

  it("turns authoritative terminal evidence into a succeeded objective checkpoint", async () => {
    const fixture = makeFixture();
    const run = createObjective(fixture.runtime, fixture.store, { tasks: [objectiveTask("verify")] });
    const runner = new ObjectiveSupervisionRunner(
      fixture.runtime,
      fixture.repository,
      fixture.agents as never,
      fixture.store,
      { authority },
    );
    const dispatched = await runner.step(run.runId);
    const order = fixture.orders[0];
    if (!order) throw new Error("dispatch order was not recorded");
    const agent = agentFor(fixture, order);
    fixture.store.saveAgent({
      ...agent,
      status: "completed",
      output: { verified: true },
      finishedAt: "2026-09-01T00:00:02.000Z",
      updatedAt: "2026-09-01T00:00:02.000Z",
    });
    fixture.store.appendEvent({
      type: "agent.completed",
      workflowId: run.workflowId,
      runId: run.runId,
      agentId: agent.id,
      occurredAt: "2026-09-01T00:00:02.000Z",
      payload: { output: { verified: true } },
      provenance: { source: "daemon" },
    });

    const evaluated = await runner.step(run.runId);
    expect(evaluated.intent.kind).toBe("evaluate");
    expect(fixture.runtime.get(run.runId)).toMatchObject({ state: "succeeded", latestCheckpointId: expect.any(String) });
    expect(fixture.runtime.get(run.runId).tasks[0]).toMatchObject({ state: "completed", output: { verified: true } });
    expect(dispatched.runId).toBe(run.runId);
  });

  it.each(["cancelled", "interrupted", "lost"] as const)(
    "keeps an %s native outcome unresolved instead of reporting task failure",
    async (status) => {
      const fixture = makeFixture();
      const run = createObjective(fixture.runtime, fixture.store, { tasks: [objectiveTask("uncertain")] });
      const runner = new ObjectiveSupervisionRunner(
        fixture.runtime,
        fixture.repository,
        fixture.agents as never,
        fixture.store,
        { authority },
      );
      await runner.step(run.runId);
      const order = fixture.orders[0];
      if (!order) throw new Error("dispatch order was not recorded");
      const agent = agentFor(fixture, order);
      fixture.store.saveAgent({
        ...agent,
        status,
        error: `fixture ${status}`,
        finishedAt: "2026-09-01T00:00:02.000Z",
        updatedAt: "2026-09-01T00:00:02.000Z",
      });

      const result = await runner.step(run.runId);
      expect(result.action).toBe("attention");
      expect(fixture.runtime.get(run.runId)).toMatchObject({ state: "executing" });
      expect(fixture.runtime.get(run.runId).tasks[0]?.state).toBe("running");
      expect(fixture.store.getMetadata(`objective-supervision:${run.runId}`)).toMatchObject({ state: "attention" });
    },
  );

  it("holds approval-gated work at a durable attention boundary", async () => {
    const fixture = makeFixture();
    const run = createObjective(fixture.runtime, fixture.store, {
      tasks: [objectiveTask("publish", { requiresApproval: true })],
    });
    expect(run.state).toBe("awaiting-approval");
    expect(run.pendingApprovalId).not.toBeNull();
    const runner = new ObjectiveSupervisionRunner(
      fixture.runtime,
      fixture.repository,
      fixture.agents as never,
      fixture.store,
      { authority },
    );

    const result = await runner.step(run.runId);
    expect(result.intent.kind).toBe("wait-for-approval");
    expect(result.action).toBe("attention");
    expect(fixture.orders).toHaveLength(0);
    expect(fixture.store.getMetadata(`objective-supervision:${run.runId}`)).toMatchObject({ state: "attention" });
  });

  it("does not accept terminal evidence from an agent belonging to another run", async () => {
    const fixture = makeFixture({ wrongRunId: "foreign-objective-run" });
    const run = createObjective(fixture.runtime, fixture.store, { tasks: [objectiveTask("lineage")] });
    const runner = new ObjectiveSupervisionRunner(
      fixture.runtime,
      fixture.repository,
      fixture.agents as never,
      fixture.store,
      { authority },
    );
    await runner.step(run.runId);
    const order = fixture.orders[0];
    if (!order) throw new Error("dispatch order was not recorded");
    const agent = agentFor(fixture, order);
    fixture.store.saveAgent({
      ...agent,
      status: "completed",
      output: { shouldNotCount: true },
      finishedAt: "2026-09-01T00:00:02.000Z",
      updatedAt: "2026-09-01T00:00:02.000Z",
    });

    const result = await runner.step(run.runId);
    expect(result.intent.kind).toBe("evaluate");
    expect(result.action).toBe("waiting");
    expect(fixture.runtime.get(run.runId).state).toBe("executing");
    expect(fixture.runtime.get(run.runId).tasks[0]?.state).toBe("running");
    expect(fixture.runtime.get(run.runId).tasks[0]?.output).toBeNull();
  });

  it("materializes one restart-stable attention item at the approval boundary", async () => {
    const fixture = makeFixture();
    const run = createObjective(fixture.runtime, fixture.store, {
      tasks: [objectiveTask("publish", { requiresApproval: true })],
    });
    const first = new ObjectiveSupervisionRunner(
      fixture.runtime,
      fixture.repository,
      fixture.agents as never,
      fixture.store,
      { authority },
    );
    await first.step(run.runId);
    const approvals = fixture.store.listObjectiveApprovals({ runId: run.runId, limit: 10 });
    const approval = approvals[0];
    if (!approval) throw new Error("approval was not persisted");
    const initial = fixture.store.listObjectiveAttentions({ runId: run.runId, limit: 10 });
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      operationId: approval.operationId,
      status: "open",
      risk: "high",
      urgency: "high",
      nodeId: null,
      evidenceRefs: expect.arrayContaining([expect.objectContaining({ kind: "trace" })]),
    });

    const restarted = new ObjectiveSupervisionRunner(
      fixture.runtime,
      fixture.repository,
      fixture.agents as never,
      fixture.store,
      { authority },
    );
    await restarted.step(run.runId);
    expect(fixture.store.listObjectiveAttentions({ runId: run.runId, limit: 10 })).toHaveLength(1);
  });
});
