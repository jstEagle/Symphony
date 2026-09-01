import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentRecordSchema,
  AgentWorkOrderSchema,
  ObjectiveBudgetLedgerRecordSchema,
  ObjectiveBudgetLimitsSchema,
  ObjectivePolicySnapshotSchema,
  ObjectiveRunRecordSchema,
  ObjectiveTaskSchema,
  UsageEventSchema,
  type AgentRecord,
  type AgentWorkOrder,
  type ObjectiveBudgetLimits,
} from "../packages/protocol/src/index.js";
import { ObjectiveRuntime, objectivePolicyHash } from "../packages/workflow/src/objective-runtime.js";
import { ObjectiveStoreRepository } from "../packages/workflow/src/objective-store-repository.js";
import { ObjectiveSupervisor } from "../packages/workflow/src/objective-supervisor.js";
import { ObjectiveSupervisionRunner, objectiveAttemptId } from "../packages/workflow/src/objective-supervision-runner.js";
import { createStore, type SymphonyStore } from "../packages/storage/src/index.js";

const authority = { actor: { type: "system" as const, id: "budget-runner-test" }, permissionCeiling: "full-access" as const };
const now = "2026-09-01T00:00:01.000Z";
const temporary: string[] = [];
const stores: SymphonyStore[] = [];

function task(id = "build") {
  return ObjectiveTaskSchema.parse({
    id,
    objective: `Complete ${id}`,
    dependsOn: [],
    outputSchema: {},
    model: "fixture",
    harness: "auto",
    inputs: [],
    requiresApproval: false,
    workspace: { path: "/tmp/symphony-budget-runner", dirtyPolicy: "local-only" },
  });
}

function fixture(
  limits: Partial<ObjectiveBudgetLimits> = {},
  createFailure = false,
  taskIds: string[] = ["build"],
  createStatus: AgentRecord["status"] = "running",
) {
  const directory = mkdtempSync(join(tmpdir(), "symphony-objective-budget-runner-"));
  temporary.push(directory);
  const store = createStore(join(directory, "state.sqlite"));
  stores.push(store);
  const repository = new ObjectiveStoreRepository(store);
  let idSequence = 0;
  const runtime = new ObjectiveRuntime(repository, { now: () => now, id: () => `budget-runner-id-${++idSequence}` });
  const budget = ObjectiveBudgetLimitsSchema.parse({
    maxConcurrentAgents: null,
    maxDepth: null,
    ...limits,
  });
  const policyWithoutHash = {
    version: 1 as const,
    policyVersion: 1,
    policyHash: "pending",
    runId: "budget-runner-run",
    objectiveId: "budget-runner-objective",
    workflowId: "budget-runner-workflow",
    workflowRevision: 1,
    workflowHash: "budget-runner-workflow-hash",
    actor: { type: "system" as const, id: "budget-runner-test" },
    effectivePermission: "full-access" as const,
    allowedCapabilities: [],
    workspace: { path: "/tmp/symphony-budget-runner", dirtyPolicy: "local-only" as const },
    budget,
    sideEffectClassCeiling: "read" as const,
    approvalPolicy: { mode: "never" as const },
    expiresAt: null,
    createdAt: now,
  };
  const policy = ObjectivePolicySnapshotSchema.parse({ ...policyWithoutHash, policyHash: objectivePolicyHash(policyWithoutHash) });
  const run = ObjectiveRunRecordSchema.parse({
    version: 1,
    runId: policy.runId,
    objectiveId: policy.objectiveId,
    workflowId: policy.workflowId,
    workflowRevision: policy.workflowRevision,
    workflowHash: policy.workflowHash,
    conductorAgentId: "budget-conductor",
    policy,
    policyHash: policy.policyHash,
    pauseReason: null,
    spec: { id: policy.objectiveId, statement: "Account for objective work.", criteria: [], approvalPolicy: { mode: "never" }, maxReplans: 1 },
    state: "executing",
    activePlanRevision: 0,
    latestCheckpointId: null,
    pendingApprovalId: null,
    replanCount: 0,
    tasks: taskIds.map((id) => ({ task: task(id), state: "queued" as const, attemptId: null, agentId: null, output: null, error: null, startedAt: null, finishedAt: null })),
    context: {},
    output: null,
    error: null,
    requestKey: "budget-runner-create",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
  });
  store.saveObjectiveRun(run);
  store.saveObjectiveBudgetLedger(ObjectiveBudgetLedgerRecordSchema.parse({
    version: 1,
    runId: run.runId,
    objectiveId: run.objectiveId,
    policyHash: policy.policyHash,
    limits: policy.budget,
    reserved: {},
    consumed: {},
    status: "active",
    pauseReason: null,
    revision: 0,
    requestKey: "budget-runner-ledger",
    createdAt: now,
    updatedAt: now,
  }));
  store.saveAgent(AgentRecordSchema.parse({
    id: "budget-conductor",
    logicalAgentId: "budget-conductor",
    workflowId: run.workflowId,
    runId: "chat-run",
    parentAgentId: null,
    depth: 0,
    objective: "Coordinate",
    missionHash: run.workflowHash,
    requestedHarness: "auto",
    requestedModel: "auto",
    harness: null,
    model: null,
    permissions: "full-access",
    status: "running",
    nativeSessionId: null,
    nativeRunId: null,
    workspacePath: "/tmp/symphony-budget-runner",
    output: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
  }));
  let createCalls = 0;
  const orders: AgentWorkOrder[] = [];
  const create = async (input: unknown): Promise<AgentRecord> => {
    createCalls += 1;
    if (createFailure) throw new Error("native create failed");
    const order = AgentWorkOrderSchema.parse(input);
    orders.push(order);
    const existing = store.getAgentByLogicalAgentId(order.id as string);
    if (existing) return existing;
    const agent = AgentRecordSchema.parse({
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
      status: createStatus,
      nativeSessionId: null,
      nativeRunId: null,
      workspacePath: order.workspace.path,
      output: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: null,
    });
    store.saveAgent(agent);
    if (createStatus === "completed" || createStatus === "failed") {
      appendTerminalEvidence(store, run, agent, createStatus);
    }
    return agent;
  };
  const agents = { create, message: async () => ({ receiptId: "budget-message", queued: true }) } as never;
  const runner = () => new ObjectiveSupervisionRunner(runtime, repository, agents, store, { authority });
  return { store, run, runtime, repository, runner, orders, get createCalls() { return createCalls; } };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("ObjectiveSupervisionRunner budget enforcement", () => {
  it("serializes concurrent reservation races and never creates a second native attempt", async () => {
    const fixture = fixtureFactory({ maxConcurrentAgents: 1, maxModelCalls: 2 });
    const first = fixture.runner();
    const second = fixture.runner();
    const results = await Promise.all([first.step(fixture.run.runId), second.step(fixture.run.runId)]);
    expect(results.map((result) => result.action).sort()).toEqual(["dispatched", "waiting"]);
    expect(fixture.createCalls).toBe(1);
    const reservation = fixture.store.listObjectiveBudgetReservations({ runId: fixture.run.runId })[0];
    expect(reservation).toMatchObject({ state: "reserved", attemptId: expect.any(String) });
  });

  it("replays a reserved hold after a crash before native create", async () => {
    const fixture = fixtureFactory({ maxConcurrentAgents: 1 });
    const runner = fixture.runner();
    const supervisorIntent = new ObjectiveSupervisor(fixture.runtime, fixture.repository, authority).next(fixture.run.runId);
    if (supervisorIntent.kind !== "dispatch") throw new Error("expected dispatch intent");
    const attemptId = objectiveAttemptId(fixture.run.runId, "build", supervisorIntent.intentId);
    const reservation = {
      version: 1,
      id: "restart-reservation",
      runId: fixture.run.runId,
      objectiveId: fixture.run.objectiveId,
      policyHash: fixture.run.policyHash,
      reservationKey: `objective-budget-reservation:${fixture.run.runId}:${attemptId}`,
      attemptId,
      agentId: null,
      amount: { modelCalls: 1 },
      state: "reserved" as const,
      revision: 0,
      requestKey: "restart-reservation-request",
      createdAt: now,
      updatedAt: now,
      releasedAt: null,
    };
    fixture.store.reserveObjectiveBudget(reservation);
    // The reservation is the only durable write from the crashed generation.
    // Replaying the deterministic logical attempt is safe: AgentCoordinator
    // persists an accepted create before any native start can occur, so an
    // existing agent is returned rather than duplicated.
    const result = await runner.step(fixture.run.runId);
    expect(result.action).toBe("dispatched");
    expect(fixture.createCalls).toBe(1);
    expect(fixture.store.getAgentByLogicalAgentId(attemptId)).toBeTruthy();
  });

  it("treats max concurrent agents as transient backpressure", async () => {
    const fixture = fixtureFactory({ maxConcurrentAgents: 1 }, false, ["build", "verify"]);
    const runner = fixture.runner();

    const first = await runner.step(fixture.run.runId);
    expect(first.action).toBe("waiting");
    expect(fixture.createCalls).toBe(1);
    expect(fixture.store.getObjectiveBudgetLedger(fixture.run.runId)).toMatchObject({ status: "active", pauseReason: null });
    expect(fixture.store.getMetadata(`objective-supervision:${fixture.run.runId}`)).toMatchObject({ state: "waiting" });

    const firstAgent = fixture.store.getAgentByLogicalAgentId(first.intent.kind === "dispatch"
      ? objectiveAttemptId(fixture.run.runId, "build", first.intent.intentId)
      : "");
    if (!firstAgent) throw new Error("expected first objective agent");
    const completedFirstAgent = { ...firstAgent, status: "completed" as const, output: { ok: true }, finishedAt: now };
    fixture.store.saveAgent(completedFirstAgent);
    appendTerminalEvidence(fixture.store, fixture.run, completedFirstAgent, "completed");

    // Once the first task is terminal, its reservation is consumed during
    // replay and the queued sibling can claim the newly-free slot.
    const second = await runner.step(fixture.run.runId);
    expect(second.action).toBe("dispatched");
    expect(fixture.createCalls).toBe(2);
    expect(fixture.store.getObjectiveBudgetLedger(fixture.run.runId)).toMatchObject({ status: "active", pauseReason: null });
    expect(fixture.store.listObjectiveBudgetReservations({ runId: fixture.run.runId }).map((item) => item.state)).toEqual(["consumed", "reserved"]);
  });

  it("reconciles a fast completed replay directly into the objective checkpoint", async () => {
    const fixture = fixtureFactory({}, false, ["build"], "completed");
    const result = await fixture.runner().step(fixture.run.runId);
    expect(result.action).toBe("dispatched");
    expect(fixture.createCalls).toBe(1);
    expect(fixture.runtime.get(fixture.run.runId).tasks[0]).toMatchObject({ state: "completed", output: null });
    expect(fixture.store.listObjectiveBudgetReservations({ runId: fixture.run.runId })[0]).toMatchObject({ state: "consumed" });
  });

  it("releases a reservation after a definite native create failure", async () => {
    const fixture = fixtureFactory({ maxModelCalls: 1 }, true);
    const result = await fixture.runner().step(fixture.run.runId);
    expect(result.action).toBe("dispatched");
    expect(fixture.store.listObjectiveBudgetReservations({ runId: fixture.run.runId })[0]).toMatchObject({ state: "released" });
    expect(fixture.store.getObjectiveBudgetLedger(fixture.run.runId)).toMatchObject({ reserved: { modelCalls: 0 } });
  });

  it("consumes exactly one reservation only after terminal evidence", async () => {
    const fixture = fixtureFactory({ maxModelCalls: 1, maxTotalTokens: 100 });
    const runner = fixture.runner();
    const dispatched = await runner.step(fixture.run.runId);
    expect(fixture.orders[0]?.metadata).toMatchObject({
      policyHash: fixture.run.policyHash,
      budgetReservationId: expect.any(String),
      budgetReservationKey: expect.any(String),
    });
    const attemptId = dispatched.intent.kind === "dispatch" ? objectiveAttemptId(fixture.run.runId, "build", dispatched.intent.intentId) : null;
    const agent = attemptId ? fixture.store.getAgentByLogicalAgentId(attemptId) : null;
    if (!agent) throw new Error("expected native attempt");
    fixture.store.recordUsage(UsageEventSchema.parse({ id: "budget-usage-1", workflowId: fixture.run.workflowId, runId: fixture.run.runId, agentId: agent.id, model: null, harness: null, inputTokens: 5, outputTokens: 5, cacheReadTokens: null, costAmount: null, currency: "USD", basis: "harness-reported", priceSnapshotId: null, recordedAt: now }));
    const completedAgent = { ...agent, status: "completed" as const, output: { ok: true }, finishedAt: now };
    fixture.store.saveAgent(completedAgent);
    appendTerminalEvidence(fixture.store, fixture.run, completedAgent, "completed");
    await runner.step(fixture.run.runId);
    expect(fixture.store.listObjectiveBudgetReservations({ runId: fixture.run.runId })[0]).toMatchObject({ state: "consumed" });
    expect(fixture.store.getObjectiveBudgetLedger(fixture.run.runId)).toMatchObject({ reserved: { modelCalls: 0 }, consumed: { modelCalls: 1, totalTokens: 10 } });
  });

  it("holds unknown terminal usage in visible attention and retries after reconciliation", async () => {
    const fixture = fixtureFactory({ maxTotalTokens: 100 });
    const runner = fixture.runner();
    const dispatched = await runner.step(fixture.run.runId);
    const attemptId = dispatched.intent.kind === "dispatch" ? objectiveAttemptId(fixture.run.runId, "build", dispatched.intent.intentId) : null;
    const agent = attemptId ? fixture.store.getAgentByLogicalAgentId(attemptId) : null;
    if (!agent) throw new Error("expected native attempt");
    const completedAgent = { ...agent, status: "completed" as const, finishedAt: now };
    fixture.store.saveAgent(completedAgent);
    appendTerminalEvidence(fixture.store, fixture.run, completedAgent, "completed");
    expect((await runner.step(fixture.run.runId)).action).toBe("attention");
    expect(fixture.store.getObjectiveBudgetLedger(fixture.run.runId)).toMatchObject({ status: "paused", pauseReason: "budget-unknown-usage" });
    expect(fixture.store.listObjectiveBudgetReservations({ runId: fixture.run.runId })[0]).toMatchObject({ state: "reserved" });
    fixture.store.recordUsage(UsageEventSchema.parse({ id: "budget-usage-2", workflowId: fixture.run.workflowId, runId: fixture.run.runId, agentId: agent.id, model: null, harness: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, costAmount: null, currency: "USD", basis: "harness-reported", priceSnapshotId: null, recordedAt: now }));
    await runner.step(fixture.run.runId);
    expect(fixture.store.listObjectiveBudgetReservations({ runId: fixture.run.runId })[0]).toMatchObject({ state: "consumed" });
  });

  it("attributes a reused native agent to the settled attempt and turn only", async () => {
    const fixture = fixtureFactory({ maxModelCalls: 4, maxTotalTokens: 100 });
    const runner = fixture.runner();
    const dispatched = await runner.step(fixture.run.runId);
    const firstAttemptId = dispatched.intent.kind === "dispatch" ? objectiveAttemptId(fixture.run.runId, "build", dispatched.intent.intentId) : null;
    const agent = firstAttemptId ? fixture.store.getAgentByLogicalAgentId(firstAttemptId) : null;
    if (!agent || !firstAttemptId) throw new Error("expected native attempt");

    fixture.store.recordUsage(UsageEventSchema.parse({
      id: "reused-agent-turn-1",
      workflowId: fixture.run.workflowId,
      runId: fixture.run.runId,
      agentId: agent.id,
      objectiveAttemptId: firstAttemptId,
      nativeTurnId: "native-turn-1",
      nativeEventId: "native-event-1",
      model: null,
      harness: null,
      inputTokens: 5,
      outputTokens: 5,
      cacheReadTokens: null,
      costAmount: null,
      currency: "USD",
      basis: "harness-reported",
      priceSnapshotId: null,
      recordedAt: now,
    }));
    fixture.store.recordUsage(UsageEventSchema.parse({
      id: "reused-agent-turn-2",
      workflowId: fixture.run.workflowId,
      runId: fixture.run.runId,
      agentId: agent.id,
      objectiveAttemptId: "objective-attempt:later-turn",
      nativeTurnId: "native-turn-2",
      nativeEventId: "native-event-2",
      model: null,
      harness: null,
      inputTokens: 80,
      outputTokens: 80,
      cacheReadTokens: null,
      costAmount: null,
      currency: "USD",
      basis: "harness-reported",
      priceSnapshotId: null,
      recordedAt: now,
    }));
    // The record points at a later native turn, but the reservation being
    // settled is still the first objective attempt. The runner must use the
    // reservation identity, not the agent's mutable current pointer.
    const completedAgent = { ...agent, objectiveAttemptId: "objective-attempt:later-turn", status: "completed" as const, output: { ok: true }, finishedAt: now };
    fixture.store.saveAgent(completedAgent);
    appendTerminalEvidence(fixture.store, fixture.run, completedAgent, "completed", firstAttemptId);
    await runner.step(fixture.run.runId);

    expect(fixture.store.listObjectiveBudgetReservations({ runId: fixture.run.runId })[0]).toMatchObject({ state: "consumed" });
    expect(fixture.store.getObjectiveBudgetLedger(fixture.run.runId)).toMatchObject({ consumed: { modelCalls: 1, totalTokens: 10 } });
  });

  it("prevents dispatch after durable exhaustion and preserves policy metadata", async () => {
    const fixture = fixtureFactory({ maxModelCalls: 0 });
    const result = await fixture.runner().step(fixture.run.runId);
    expect(result.action).toBe("attention");
    expect(fixture.createCalls).toBe(0);
    expect(fixture.store.listObjectiveBudgetReservations({ runId: fixture.run.runId })).toHaveLength(0);
  });

  it.each(["EUR", "JPY"]) ("holds %s usage instead of adding it to USD budget totals", async (currency) => {
    const fixture = fixtureFactory({ maxCostUsd: 10 });
    const runner = fixture.runner();
    const dispatched = await runner.step(fixture.run.runId);
    const attemptId = dispatched.intent.kind === "dispatch" ? objectiveAttemptId(fixture.run.runId, "build", dispatched.intent.intentId) : null;
    const agent = attemptId ? fixture.store.getAgentByLogicalAgentId(attemptId) : null;
    if (!agent || !attemptId) throw new Error("expected native attempt");
    fixture.store.recordUsage(UsageEventSchema.parse({
      id: `non-usd-${currency}`,
      workflowId: fixture.run.workflowId,
      runId: fixture.run.runId,
      agentId: agent.id,
      objectiveAttemptId: attemptId,
      nativeTurnId: `turn-${currency}`,
      nativeEventId: `event-${currency}`,
      model: null,
      harness: null,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: null,
      costAmount: 5,
      currency,
      basis: "provider-reported",
      priceSnapshotId: null,
      recordedAt: now,
    }));
    const completedAgent = { ...agent, status: "completed" as const, finishedAt: now };
    fixture.store.saveAgent(completedAgent);
    appendTerminalEvidence(fixture.store, fixture.run, completedAgent, "completed", attemptId);
    expect(await runner.step(fixture.run.runId)).toMatchObject({ action: "attention" });
    expect(fixture.store.getObjectiveBudgetLedger(fixture.run.runId)).toMatchObject({ status: "paused", pauseReason: "budget-unknown-usage", consumed: {} });
    expect(fixture.store.listObjectiveBudgetReservations({ runId: fixture.run.runId })[0]).toMatchObject({ state: "reserved" });
    expect(fixture.store.aggregateCost({ runId: fixture.run.runId })).toMatchObject({ knownTotal: 0, unknownEvents: 1, currency: "USD" });
  });
});

// Keep the helper name distinct from each test's local fixture binding.
function fixtureFactory(
  limits: Partial<ObjectiveBudgetLimits> = {},
  createFailure = false,
  taskIds: string[] = ["build"],
  createStatus: AgentRecord["status"] = "running",
) {
  return fixture(limits, createFailure, taskIds, createStatus);
}

function appendTerminalEvidence(
  store: SymphonyStore,
  run: ObjectiveRunRecord,
  agent: AgentRecord,
  status: "completed" | "failed",
  attemptId?: string,
): void {
  store.appendEvent({
    type: status === "completed" ? "agent.completed" : "agent.failed",
    workflowId: run.workflowId,
    runId: run.runId,
    agentId: agent.id,
    occurredAt: now,
    payload: {
      ...(attemptId ? { objectiveAttemptId: attemptId } : {}),
      ...(status === "completed" ? { output: agent.output } : { error: agent.error }),
    },
    provenance: {
      source: "daemon",
      ...(attemptId ? { objectiveAttemptId: attemptId } : {}),
    },
  });
}
