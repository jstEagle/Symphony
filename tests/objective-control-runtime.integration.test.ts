import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentRecordSchema,
  AgentWorkOrderSchema,
  ObjectiveControlPlanSchema,
  ObjectiveControlPlanSnapshotSchema,
  objectiveControlExecutionId,
  type AgentRecord,
  type AgentWorkOrder,
  type JsonValue,
  type ObjectiveControlPlan,
} from "@symphony/protocol";
import {
  applyObjectiveControlAcknowledgement,
  nextObjectiveControlIntent,
  WorkflowCompiler,
  type WorkflowDefinition,
} from "../packages/workflow/src/index.js";
import { compileObjectiveControlPlan } from "../packages/workflow/src/objective-control-plan.js";
import { ObjectiveRuntime, type ObjectiveRuntimeAuthority } from "../packages/workflow/src/objective-runtime.js";
import { ObjectiveApprovalExpiryProcessor } from "../packages/workflow/src/objective-approval-expiry.js";
import { ObjectiveStoreRepository } from "../packages/workflow/src/objective-store-repository.js";
import { ObjectiveSupervisionRunner } from "../packages/workflow/src/objective-supervision-runner.js";
import { createStore, type SymphonyStore } from "../packages/storage/src/index.js";

const authority = {
  actor: { type: "system" as const, id: "control-runtime-test" },
  permissionCeiling: "full-access" as const,
};

const definition: WorkflowDefinition = {
  id: "control-runtime-workflow",
  name: "Control runtime workflow",
  mission: { statement: "Exercise durable control runtime integration.", keyResults: [] },
  workspace: { path: "/tmp/control-runtime" },
  inputSchema: { type: "object" },
  output: "steps",
  steps: [{
    id: "work",
    type: "agent",
    objective: "Do durable control work.",
    model: "fixture",
    harness: "auto",
    outputSchema: { type: "object" },
    workspace: { path: "/tmp/control-runtime" },
  }],
  triggers: [{ id: "manual", type: "manual" }],
};

type Fixture = {
  root: string;
  store: SymphonyStore;
  repository: ObjectiveStoreRepository;
  runtime: ObjectiveRuntime;
  orders: AgentWorkOrder[];
  launches: string[];
  create: (order: AgentWorkOrder) => Promise<AgentRecord>;
};

const fixtures: Fixture[] = [];

function plan(): ObjectiveControlPlan {
  const ir = new WorkflowCompiler().compile(definition, 7);
  const compiled = compileObjectiveControlPlan(ir, { planId: "control-runtime-plan" });
  return ObjectiveControlPlanSchema.parse({
    ...compiled,
    root: {
      ...compiled.root,
      steps: [{
        ...(compiled.root.steps[0] as object),
        inputs: [{ kind: "file", path: "/tmp/control-runtime/input.json" }],
      }],
    },
  });
}

function parallelSignalPlan(): ObjectiveControlPlan {
  const base = plan();
  const signal = (id: string, signalKey: string) => ({
    id,
    sourceNodeId: id,
    sourcePath: `root.${id}`,
    dependsOn: [],
    label: id,
    type: "signal" as const,
    signalKey,
    expiresAfterMs: 60_000,
    payloadSchema: { status: "string" },
  });
  return ObjectiveControlPlanSchema.parse({
    ...base,
    id: "control-runtime-parallel-signals",
    root: {
      ...base.root,
      type: "parallel",
      steps: [signal("signal-a", "deployment.a"), signal("signal-b", "deployment.b")],
    },
  });
}

function conductor(runId: string): AgentRecord {
  return AgentRecordSchema.parse({
    id: "control-runtime-conductor",
    logicalAgentId: "control-runtime-conductor",
    workflowId: definition.id,
    runId,
    parentAgentId: null,
    depth: 0,
    objective: "Coordinate control runtime test.",
    missionHash: "control-runtime-workflow-hash",
    requestedHarness: "auto",
    requestedModel: "auto",
    harness: null,
    model: null,
    permissions: "full-access",
    status: "running",
    nativeSessionId: null,
    nativeRunId: null,
    workspacePath: "/tmp/control-runtime",
    output: null,
    error: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: null,
  });
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "symphony-control-runtime-"));
  const store = createStore(join(root, "store.sqlite"));
  const repository = new ObjectiveStoreRepository(store);
  let id = 0;
  const runtime = new ObjectiveRuntime(repository, {
    id: () => `control-runtime-id-${++id}`,
    now: () => "2026-09-01T00:00:01.000Z",
  });
  const orders: AgentWorkOrder[] = [];
  const launches: string[] = [];
  const create = async (order: AgentWorkOrder): Promise<AgentRecord> => {
    const parsed = AgentWorkOrderSchema.parse(order);
    orders.push(parsed);
    const existing = store.getAgentByLogicalAgentId(parsed.id);
    if (existing) return existing;
    launches.push(parsed.id);
    const agent = AgentRecordSchema.parse({
      id: `native-${parsed.id}`,
      logicalAgentId: parsed.id,
      workflowId: parsed.workflowId,
      runId: parsed.runId,
      parentAgentId: parsed.parentAgentId,
      depth: parsed.depth,
      objective: parsed.objective,
      missionHash: parsed.mission.hash,
      requestedHarness: parsed.harness,
      requestedModel: parsed.model,
      harness: null,
      model: null,
      permissions: parsed.permissions,
      status: "running",
      nativeSessionId: null,
      nativeRunId: null,
      workspacePath: parsed.workspace.path,
      output: null,
      error: null,
      createdAt: "2026-09-01T00:00:01.000Z",
      updatedAt: "2026-09-01T00:00:01.000Z",
      startedAt: "2026-09-01T00:00:01.000Z",
      finishedAt: null,
    });
    store.saveAgent(agent);
    return agent;
  };
  const fixture = { root, store, repository, runtime, orders, launches, create };
  fixtures.push(fixture);
  return fixture;
}

function createObjective(
  fixture: Fixture,
  controlPlan: ObjectiveControlPlan,
  requestKey: string,
  approvalMode: "never" | "before-completion" = "never",
  admissionAuthority: ObjectiveRuntimeAuthority = authority,
  context: Record<string, JsonValue> = {},
) {
  const source = controlPlan.source;
  if (source.kind !== "workflow-revision") throw new Error("fixture control plan must be workflow-backed");
  const run = fixture.runtime.create({
    runId: `control-runtime-run-${requestKey}`,
    objectiveId: `control-runtime-objective-${requestKey}`,
    workflowId: definition.id,
    workflowRevision: source.workflowRevision,
    workflowHash: source.workflowHash,
    conductorAgentId: "control-runtime-conductor",
    spec: {
      id: `control-runtime-objective-${requestKey}`,
      statement: "Exercise durable control runtime integration.",
      criteria: [],
      approvalPolicy: { mode: approvalMode },
      maxReplans: 0,
    },
    controlPlan,
    context,
    requestKey,
  }, admissionAuthority);
  fixture.store.saveAgent(conductor(run.runId));
  return run;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe("durable objective control runtime integration", () => {
  it("settles an evaluate node deterministically without launching a native agent and publishes durable evidence", async () => {
    const fixture = makeFixture();
    const base = plan();
    const evaluationPlan = ObjectiveControlPlanSchema.parse({
      ...base,
      root: {
        ...base.root,
        steps: [{
          id: "quality",
          sourceNodeId: "quality",
          sourcePath: "steps.0",
          dependsOn: [],
          label: "Release quality",
          type: "evaluate",
          metric: "Release quality",
          path: "release.score",
          operator: "gte",
          target: 8,
        }],
      },
    });
    const run = createObjective(fixture, evaluationPlan, "control-runtime-evaluation", "never", authority, { release: { score: 9 } });
    const runner = new ObjectiveSupervisionRunner(fixture.runtime, fixture.repository, { create: fixture.create } as never, fixture.store, { authority });

    await runner.step(run.runId); // enter root sequence
    const evaluated = await runner.step(run.runId);
    expect(evaluated.intent).toMatchObject({ kind: "evaluate", metric: "Release quality", actual: 9, target: 8, operator: "gte", pass: true });
    expect(fixture.launches).toEqual([]);
    expect(fixture.runtime.controlState(run.runId)?.snapshot.executions.find((execution) => execution.key.nodeId === "quality")).toMatchObject({
      state: "completed",
      output: { actual: 9, target: 8, operator: "gte", pass: true },
    });
    expect(fixture.store.eventsAfter(0, { runId: run.runId, types: ["objective.control.evaluation.completed"] })).toHaveLength(1);
    const evidence = fixture.store.eventsAfter(0, { runId: run.runId, types: ["objective.control.evaluation.completed"] })[0];
    expect(evidence?.payload).toMatchObject({ metric: "Release quality", path: "release.score", actual: 9, target: 8, operator: "gte", pass: true });
    await runner.step(run.runId); // join root sequence
    const settled = await runner.step(run.runId); // complete root sequence
    expect(settled.intent.kind).toBe("complete");
    expect(fixture.runtime.get(run.runId).state).toBe("succeeded");
  });

  it("admits revision zero atomically, dispatches with control metadata, and resumes after restart", async () => {
    const fixture = makeFixture();
    const run = createObjective(fixture, plan(), "control-runtime-create");
    expect(fixture.repository.getObjectiveControlHead(run.runId)).toMatchObject({ activeRevision: 0, latestSnapshotSequence: 1 });
    expect(fixture.repository.getLatestObjectiveControlSnapshot(run.runId)?.sequence).toBe(1);

    const runner = new ObjectiveSupervisionRunner(fixture.runtime, fixture.repository, { create: fixture.create } as never, fixture.store, { authority });
    const entered = await runner.step(run.runId);
    expect(entered.intent.kind).toBe("sequence");
    expect(fixture.repository.getLatestObjectiveControlSnapshot(run.runId)?.sequence).toBe(2);

    const dispatched = await runner.step(run.runId);
    expect(dispatched.intent).toMatchObject({ kind: "agent", nodeId: "work", operation: "dispatch" });
    expect(fixture.launches).toHaveLength(1);
    const order = fixture.orders[0];
    if (!order) throw new Error("control order was not recorded");
    expect(order.metadata).toMatchObject({
      objectiveRunId: run.runId,
      objectiveAttemptId: order.id,
      controlNodeId: "work",
      controlExecutionId: expect.any(String),
      controlIterationPath: expect.any(String),
      controlIntentId: dispatched.intent.intentId,
      controlAttemptId: order.id,
    });
    expect(order.inputs).toEqual([{ kind: "file", path: "/tmp/control-runtime/input.json" }]);

    const restarted = new ObjectiveSupervisionRunner(fixture.runtime, fixture.repository, { create: fixture.create } as never, fixture.store, { authority });
    const waiting = await restarted.step(run.runId);
    expect(waiting.intent).toMatchObject({ kind: "agent", operation: "wait", attemptId: order.id });
    expect(waiting.action).toBe("waiting");
    expect(fixture.launches).toHaveLength(1);

    const agent = fixture.store.getAgentByLogicalAgentId(order.id);
    if (!agent) throw new Error("control agent was not persisted");
    fixture.store.saveAgent({ ...agent, status: "completed", output: { ok: true }, finishedAt: "2026-09-01T00:00:02.000Z", updatedAt: "2026-09-01T00:00:02.000Z" });
    fixture.store.appendEvent({
      type: "agent.completed",
      workflowId: run.workflowId,
      runId: run.runId,
      agentId: agent.id,
      occurredAt: "2026-09-01T00:00:02.000Z",
      payload: { objectiveAttemptId: order.id, output: { ok: true } },
      provenance: { source: "daemon" },
    });
    await restarted.step(run.runId);
    await restarted.step(run.runId);
    await restarted.step(run.runId);
    expect(fixture.runtime.get(run.runId).state).toBe("succeeded");
    expect(fixture.repository.getLatestObjectiveControlSnapshot(run.runId)?.sequence).toBeGreaterThan(4);
  });

  it("cancels every waiting suspension in a parallel frontier", async () => {
    const fixture = makeFixture();
    const controlPlan = parallelSignalPlan();
    const run = createObjective(fixture, controlPlan, "par-cancel");
    const runner = new ObjectiveSupervisionRunner(fixture.runtime, fixture.repository, { create: fixture.create } as never, fixture.store, { authority });

    await runner.step(run.runId); // enter the parallel root and materialize both signal executions
    await runner.step(run.runId); // subscribe signal-a through the regular supervisor path

    const current = fixture.runtime.controlState(run.runId);
    if (!current) throw new Error("parallel control state was not persisted");
    const signalA = current.snapshot.executions.find((entry) => entry.key.nodeId === "signal-a")?.key;
    const signalB = current.snapshot.executions.find((entry) => entry.key.nodeId === "signal-b")?.key;
    if (!signalA || !signalB) throw new Error("parallel signal executions were not materialized");
    const scoped = ObjectiveControlPlanSnapshotSchema.parse({ ...current.snapshot, frontier: [signalB] });
    const signalBIntent = nextObjectiveControlIntent(controlPlan, scoped, "2026-09-01T00:00:01.000Z");
    expect(signalBIntent).toMatchObject({ kind: "signal", operation: "subscribe", execution: signalB });
    const bothWaiting = applyObjectiveControlAcknowledgement(controlPlan, scoped, {
      kind: "signal",
      intentId: signalBIntent.intentId,
      requestKey: "control-runtime-parallel-signal-b-subscribe",
      signalKey: "deployment.b",
      since: "2026-09-01T00:00:01.000Z",
      expiresAt: "2026-09-01T00:01:01.000Z",
      now: "2026-09-01T00:00:01.000Z",
    });
    const merged = ObjectiveControlPlanSnapshotSchema.parse({ ...bothWaiting, frontier: [signalA, signalB] });
    expect(fixture.repository.saveObjectiveControlSnapshot(merged)).toBe(true);

    const cancelled = fixture.runtime.cancelControlSuspensions(run.runId, authority);
    expect(cancelled).not.toBeNull();
    const executions = cancelled?.snapshot.executions.filter((entry) => entry.key.nodeId === "signal-a" || entry.key.nodeId === "signal-b") ?? [];
    expect(executions).toHaveLength(2);
    expect(executions.map((entry) => entry.suspension?.status)).toEqual(["cancelled", "cancelled"]);
    expect(executions.map((entry) => entry.state)).toEqual(["cancelled", "cancelled"]);
    expect(cancelled?.snapshot.frontier.some((entry) => entry.key.nodeId === "signal-a" || entry.key.nodeId === "signal-b")).toBe(false);
    expect(fixture.repository.listObjectiveControlSuspensions(run.runId).every((entry) => entry.status === "cancelled")).toBe(true);
  });

  it("holds an approval-gated control agent until its durable approval is resolved", async () => {
    const fixture = makeFixture();
    const gated = ObjectiveControlPlanSchema.parse({
      ...plan(),
      root: { ...plan().root, steps: [{ ...(plan().root.steps[0] as object), requiresApproval: true }] },
    });
    const run = createObjective(fixture, gated, "control-runtime-approval");
    const runner = new ObjectiveSupervisionRunner(fixture.runtime, fixture.repository, { create: fixture.create } as never, fixture.store, { authority });
    await runner.step(run.runId);
    const held = await runner.step(run.runId);
    expect(held.intent).toMatchObject({ kind: "agent", operation: "approval" });
    expect(fixture.launches).toHaveLength(0);

    const approval = held.intent;
    if (approval.kind !== "agent") throw new Error("expected control approval intent");
    const approvalId = fixture.runtime.get(run.runId).pendingApprovalId;
    if (!approvalId) throw new Error("control approval was not persisted");
    const record = fixture.repository.getObjectiveApproval(run.runId, approvalId);
    expect(record).toMatchObject({
      kind: "control",
      status: "requested",
      scope: {
        controlIntentId: approval.intentId,
        controlNodeId: approval.nodeId,
        controlAttemptId: approval.attemptId,
        controlExecutionKey: approval.execution,
      },
    });
    const restarted = new ObjectiveSupervisionRunner(fixture.runtime, fixture.repository, { create: fixture.create } as never, fixture.store, { authority });
    const stillHeld = await restarted.step(run.runId);
    expect(stillHeld.action).toBe("attention");
    expect(fixture.runtime.get(run.runId).pendingApprovalId).toBe(approvalId);
    expect(() => fixture.runtime.acknowledgeControl(run.runId, {
      kind: "agent",
      intentId: approval.intentId,
      requestKey: "control-runtime-approval-ack",
      approved: true,
      eventCursor: fixture.store.latestCursor(),
      now: "2026-09-01T00:00:02.000Z",
    }, authority)).toThrow(/approval/i);
    fixture.runtime.resolveApproval(run.runId, approvalId, {
      status: "approved",
      decision: "approved",
      requestKey: "control-runtime-approval-resolution",
    }, authority);
    const resumed = await runner.step(run.runId);
    expect(resumed.intent).toMatchObject({ kind: "agent", operation: "approval" });
    const dispatched = await runner.step(run.runId);
    expect(dispatched.intent).toMatchObject({ kind: "agent", operation: "dispatch" });
    expect(fixture.launches).toHaveLength(1);
  });

  it("terminalizes a rejected control-node approval without dispatching", async () => {
    const fixture = makeFixture();
    const gated = ObjectiveControlPlanSchema.parse({
      ...plan(),
      root: { ...plan().root, steps: [{ ...(plan().root.steps[0] as object), requiresApproval: true }] },
    });
    const run = createObjective(fixture, gated, "control-runtime-rejected-approval");
    const runner = new ObjectiveSupervisionRunner(fixture.runtime, fixture.repository, { create: fixture.create } as never, fixture.store, { authority });
    await runner.step(run.runId);
    const held = await runner.step(run.runId);
    if (held.intent.kind !== "agent") throw new Error("expected control approval intent");
    const approvalId = fixture.runtime.get(run.runId).pendingApprovalId;
    if (!approvalId) throw new Error("control approval was not persisted");
    fixture.runtime.resolveApproval(run.runId, approvalId, {
      status: "rejected",
      decision: { reason: "not authorized" },
      requestKey: "control-runtime-rejected-resolution",
    }, authority);
    const projected = await runner.step(run.runId);
    expect(projected.action).toBe("settled");
    expect(projected.run.state).toBe("failed");
    const rejectedSnapshot = fixture.runtime.controlState(run.runId)?.snapshot;
    expect(rejectedSnapshot?.nodeStates[objectiveControlExecutionId(held.intent.execution)]).toBe("failed");
    expect(fixture.launches).toHaveLength(0);
  });

  it("expires a control-node approval durably and fails its execution", async () => {
    const fixture = makeFixture();
    const expiringAuthority: ObjectiveRuntimeAuthority = {
      ...authority,
      policy: { approvalPolicy: { mode: "never", timeoutSeconds: 1 } },
    };
    const gated = ObjectiveControlPlanSchema.parse({
      ...plan(),
      root: { ...plan().root, steps: [{ ...(plan().root.steps[0] as object), requiresApproval: true }] },
    });
    const run = createObjective(fixture, gated, "control-runtime-expired-approval", "never", expiringAuthority);
    const runner = new ObjectiveSupervisionRunner(fixture.runtime, fixture.repository, { create: fixture.create } as never, fixture.store, { authority: expiringAuthority });
    await runner.step(run.runId);
    const held = await runner.step(run.runId);
    if (held.intent.kind !== "agent") throw new Error("expected control approval intent");
    const approvalId = fixture.runtime.get(run.runId).pendingApprovalId;
    if (!approvalId) throw new Error("control approval was not persisted");
    const lateRuntime = new ObjectiveRuntime(fixture.repository, {
      id: () => "control-runtime-expiry-id",
      now: () => "2026-09-01T00:00:03.000Z",
    });
    const expiry = new ObjectiveApprovalExpiryProcessor(lateRuntime, fixture.repository, fixture.store, {
      now: () => "2026-09-01T00:00:03.000Z",
    });
    expect(expiry.expireRequested()).toHaveLength(1);
    expect(fixture.repository.getObjectiveApproval(run.runId, approvalId)).toMatchObject({ status: "expired" });
    const projected = await runner.step(run.runId);
    expect(projected.action).toBe("settled");
    expect(projected.run.state).toBe("failed");
    expect(fixture.launches).toHaveLength(0);
  });

  it("rejects control plans whose nested agents exceed permission, capability, or workspace authority", () => {
    const permissionFixture = makeFixture();
    const fullAccess = ObjectiveControlPlanSchema.parse({
      ...plan(),
      root: { ...plan().root, steps: [{ ...(plan().root.steps[0] as object), permissions: "full-access" }] },
    });
    expect(() => createObjective(permissionFixture, fullAccess, "control-runtime-permission-ceiling", "never", {
      ...authority,
      permissionCeiling: "read-only",
    })).toThrow(/authority|ceiling/i);

    const capabilityFixture = makeFixture();
    const unsafeCapability = ObjectiveControlPlanSchema.parse({
      ...plan(),
      root: { ...plan().root, steps: [{ ...(plan().root.steps[0] as object), capabilities: ["unsafe"] }] },
    });
    expect(() => createObjective(capabilityFixture, unsafeCapability, "control-runtime-capability-ceiling", "never", {
      ...authority,
      allowedCapabilities: ["safe"],
    })).toThrow(/capability|authority/i);

    const workspaceFixture = makeFixture();
    const outsideWorkspace = ObjectiveControlPlanSchema.parse({
      ...plan(),
      root: { ...plan().root, steps: [{ ...(plan().root.steps[0] as object), workspace: { path: "/tmp/control-runtime-outside" } }] },
    });
    expect(() => createObjective(workspaceFixture, outsideWorkspace, "control-runtime-workspace-ceiling", "never", {
      ...authority,
      workspace: { path: workspaceFixture.root },
    })).toThrow(/workspace|authority/i);
  });

  it("commits dynamic control mutations through the repository reducer transaction", () => {
    const fixture = makeFixture();
    const run = createObjective(fixture, plan(), "control-runtime-mutation");
    const current = fixture.runtime.controlState(run.runId);
    if (!current) throw new Error("control state was not admitted");
    const node = {
      id: "inserted",
      sourceNodeId: "inserted",
      sourcePath: "mutation.inserted",
      dependsOn: [],
      label: "inserted",
      type: "set" as const,
      value: { inserted: true },
    };
    const committed = fixture.runtime.mutateControlPlan(run.runId, {
      version: 1,
      mutationId: "control-runtime-mutation-id",
      planId: current.head.planId,
      objectiveId: run.objectiveId,
      runId: run.runId,
      expectedRevision: current.head.activeRevision,
      type: "insert-node",
      parentId: current.revision.plan.root.id,
      slot: "steps",
      position: 0,
      node,
      reason: "Add durable mutation fixture node.",
      evidence: { eventCursor: fixture.store.latestCursor(), eventIds: [] },
      requestKey: "control-runtime-mutation-request",
      actor: authority.actor,
    }, authority);
    expect(committed.head.activeRevision).toBe(1);
    expect(committed.snapshot.planRevision).toBe(1);
    expect(committed.snapshot.sequence).toBe(2);
    expect(committed.revision.plan.root).toMatchObject({ type: "sequence" });
    expect(committed.revision.plan.root.type === "sequence" ? committed.revision.plan.root.steps[0] : null).toMatchObject({ id: "inserted" });
    expect(fixture.repository.getObjectiveControlMutationByRequestKey(run.runId, "control-runtime-mutation-request")).toMatchObject({ resultingRevision: 1 });
  });

  it("requires durable completion approval before settling a control objective", async () => {
    const fixture = makeFixture();
    const run = createObjective(fixture, plan(), "control-runtime-completion-approval", "before-completion");
    const runner = new ObjectiveSupervisionRunner(fixture.runtime, fixture.repository, { create: fixture.create } as never, fixture.store, { authority });
    await runner.step(run.runId);
    await runner.step(run.runId);
    const order = fixture.orders[0];
    if (!order) throw new Error("control order was not recorded");
    const agent = fixture.store.getAgentByLogicalAgentId(order.id);
    if (!agent) throw new Error("control agent was not persisted");
    fixture.store.saveAgent({ ...agent, status: "completed", output: { ok: true }, finishedAt: "2026-09-01T00:00:02.000Z", updatedAt: "2026-09-01T00:00:02.000Z" });
    fixture.store.appendEvent({ type: "agent.completed", workflowId: run.workflowId, runId: run.runId, agentId: agent.id, occurredAt: "2026-09-01T00:00:02.000Z", payload: { objectiveAttemptId: order.id }, provenance: { source: "daemon" } });
    await runner.step(run.runId);
    await runner.step(run.runId);
    const held = await runner.step(run.runId);
    expect(held.intent.kind).toBe("complete");
    expect(fixture.runtime.get(run.runId)).toMatchObject({ state: "awaiting-approval", pendingApprovalId: expect.any(String) });
    const approvalId = fixture.runtime.get(run.runId).pendingApprovalId;
    if (!approvalId) throw new Error("completion approval was not persisted");
    fixture.runtime.resolveApproval(run.runId, approvalId, { status: "approved", decision: "approved", requestKey: "control-runtime-completion-approval-resolution" }, authority);
    const settled = await runner.step(run.runId);
    expect(settled.action).toBe("settled");
    expect(fixture.runtime.get(run.runId).state).toBe("succeeded");
  });

  it("propagates an evidenced control-agent failure to the durable objective run", async () => {
    const fixture = makeFixture();
    const run = createObjective(fixture, plan(), "control-runtime-failure");
    const runner = new ObjectiveSupervisionRunner(fixture.runtime, fixture.repository, { create: fixture.create } as never, fixture.store, { authority });
    await runner.step(run.runId);
    await runner.step(run.runId);
    const order = fixture.orders[0];
    if (!order) throw new Error("control order was not recorded");
    const agent = fixture.store.getAgentByLogicalAgentId(order.id);
    if (!agent) throw new Error("control agent was not persisted");
    fixture.store.saveAgent({ ...agent, status: "failed", error: "fixture failure", finishedAt: "2026-09-01T00:00:02.000Z", updatedAt: "2026-09-01T00:00:02.000Z" });
    fixture.store.appendEvent({ type: "agent.failed", workflowId: run.workflowId, runId: run.runId, agentId: agent.id, occurredAt: "2026-09-01T00:00:02.000Z", payload: { objectiveAttemptId: order.id, error: "fixture failure" }, provenance: { source: "daemon" } });
    const result = await runner.step(run.runId);
    expect(result.action).toBe("dispatched");
    expect(fixture.runtime.get(run.runId)).toMatchObject({ state: "failed", error: "fixture failure" });
  });

  it("delivers an external signal exactly once after the frontier has advanced", async () => {
    const fixture = makeFixture();
    const base = plan();
    const signalPlan = ObjectiveControlPlanSchema.parse({
      ...base,
      root: {
        ...base.root,
        steps: [{
          id: "health",
          sourceNodeId: "health",
          sourcePath: "steps.0",
          dependsOn: [],
          label: "Deployment health",
          type: "signal",
          signalKey: "deployment.health",
          expiresAfterMs: 60_000,
          payloadSchema: { status: "string" },
        }],
      },
    });
    const run = createObjective(fixture, signalPlan, "control-runtime-signal");
    const runner = new ObjectiveSupervisionRunner(fixture.runtime, fixture.repository, { create: fixture.create } as never, fixture.store, { authority });
    await runner.step(run.runId);
    const subscribed = await runner.step(run.runId);
    expect(subscribed.intent).toMatchObject({ kind: "signal", operation: "subscribe", signalKey: "deployment.health" });
    const state = fixture.runtime.controlState(run.runId);
    if (!state) throw new Error("signal control state was not admitted");
    const execution = state.snapshot.executions.find((entry) => entry.key.nodeId === "health");
    if (!execution?.suspension || execution.suspension.kind !== "signal") throw new Error("signal subscription was not persisted");
    const input = {
      signalKey: execution.suspension.signalKey,
      subscriptionKey: execution.suspension.subscriptionKey,
      deliveryId: "provider-event-1",
      attemptId: execution.suspension.attemptId,
      payload: { status: "healthy" },
      occurredAt: "2026-09-01T00:00:02.000Z",
    };
    const delivered = fixture.runtime.deliverControlSignal(run.runId, input, authority);
    expect(delivered.status).toBe("delivered");
    expect(fixture.store.getObjectiveControlSignalDelivery(input.subscriptionKey, input.deliveryId)).toMatchObject({
      runId: run.runId,
      deliveryId: input.deliveryId,
      payload: input.payload,
    });
    expect(fixture.store.eventsAfter(0, { runId: run.runId, types: ["objective.control.signal.delivered"] })).toHaveLength(1);
    expect(fixture.runtime.deliverControlSignal(run.runId, input, authority)).toMatchObject({ status: "replayed", deliveryId: input.deliveryId });
    await runner.step(run.runId);
  });
});
