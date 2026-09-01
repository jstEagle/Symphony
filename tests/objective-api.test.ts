import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../apps/daemon/src/index.js";
import {
  nowIso,
  ObjectiveBudgetDebitRecordSchema,
  ObjectiveBudgetLedgerRecordSchema,
  ObjectiveBudgetReservationRecordSchema,
  ObjectivePolicySnapshotSchema,
  objectivePolicyHash,
  type ObjectiveControlPlanRevision,
  type ObjectiveControlPlanSnapshot,
  type ObjectiveApprovalRecord,
  type ObjectiveCheckpointRecord,
  type ObjectiveRunRecord,
} from "../packages/protocol/src/index.js";
import { createStore, objectiveControlPlanHash, type ObjectivePlanRevisionRecord } from "../packages/storage/src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}

const timestamp = "2026-09-01T00:00:00.000Z";

function agent(id: string, runId: string, parentAgentId: string | null = null) {
  return {
    id,
    logicalAgentId: id,
    workflowId: "objective-workflow",
    runId,
    parentAgentId,
    depth: parentAgentId ? 1 : 0,
    objective: "Work on the durable objective.",
    missionHash: "mission-hash-1",
    requestedHarness: "codex" as const,
    requestedModel: "fixture",
    harness: "codex" as const,
    model: "fixture",
    permissions: "read-only" as const,
    status: "completed" as const,
    nativeSessionId: null,
    nativeRunId: null,
    workspacePath: process.cwd(),
    output: { ok: true },
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
  };
}

function objective(): ObjectiveRunRecord {
  return {
    version: 1,
    runId: "objective-run-1",
    objectiveId: "objective-1",
    workflowId: "objective-workflow",
    workflowRevision: 1,
    workflowHash: "workflow-hash-1",
    conductorAgentId: "objective-root",
    spec: {
      id: "objective-1",
      statement: "Ship the durable objective.",
      criteria: [],
      approvalPolicy: { mode: "never" },
      maxReplans: 1,
    },
    state: "executing",
    activePlanRevision: 0,
    latestCheckpointId: "objective-checkpoint-1",
    pendingApprovalId: "objective-approval-1",
    replanCount: 0,
    tasks: [{
      task: {
        id: "task-1",
        objective: "Prove the objective state.",
        dependsOn: [],
        outputSchema: {},
        model: "auto",
        harness: "auto",
        inputs: [],
        requiresApproval: false,
      },
      state: "running",
      attemptId: null,
      agentId: "objective-child",
      output: null,
      error: null,
      startedAt: timestamp,
      finishedAt: null,
    }],
    context: { phase: "verification" },
    output: null,
    error: null,
    requestKey: "objective-request-1",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: null,
  };
}

function objectiveWithPolicy(): ObjectiveRunRecord {
  const run = objective();
  const policyWithoutHash = ObjectivePolicySnapshotSchema.parse({
    version: 1,
    policyVersion: 1,
    policyHash: "pending-hash",
    runId: run.runId,
    objectiveId: run.objectiveId,
    workflowId: run.workflowId,
    workflowRevision: run.workflowRevision,
    workflowHash: run.workflowHash,
    actor: { type: "user", id: "local-user" },
    effectivePermission: "read-only",
    allowedCapabilities: ["read", "observe"],
    workspace: null,
    budget: { maxCostUsd: 10, maxTotalTokens: 100, maxModelCalls: 10 },
    sideEffectClassCeiling: "read",
    approvalPolicy: { mode: "never" },
    expiresAt: null,
    createdAt: timestamp,
  });
  const policy = ObjectivePolicySnapshotSchema.parse({
    ...policyWithoutHash,
    policyHash: objectivePolicyHash(policyWithoutHash),
  });
  return {
    ...run,
    policy,
    policyHash: policy.policyHash,
    pauseReason: null,
  };
}

function seedObjective(root: string): void {
  const store = createStore(join(root, ".symphony"));
  const run = objective();
  store.saveAgent(agent("objective-root", run.runId));
  store.saveAgent(agent("objective-child", run.runId, "objective-root"));
  store.saveAgent(agent("foreign-root", "foreign-run"));
  store.saveObjectiveRun(run);
  const plan: ObjectivePlanRevisionRecord = {
    version: 1,
    id: "objective-plan-1",
    runId: run.runId,
    objectiveId: run.objectiveId,
    workflowId: run.workflowId,
    workflowRevision: run.workflowRevision,
    workflowHash: run.workflowHash,
    planRevision: 0,
    tasks: run.tasks,
    createdBy: { type: "agent", id: "objective-root" },
    requestKey: "objective-plan-request-1",
    createdAt: timestamp,
  };
  store.saveObjectivePlanRevision(plan);
  const checkpoint: ObjectiveCheckpointRecord = {
    version: 1,
    id: "objective-checkpoint-1",
    runId: run.runId,
    objectiveId: run.objectiveId,
    sequence: 1,
    planRevision: 0,
    eventCursor: 0,
    context: run.context,
    taskStates: { "task-1": "running" },
    criteria: [],
    contextHash: "context-hash-1",
    reason: "The objective is in progress.",
    createdBy: { type: "agent", id: "objective-root" },
    requestKey: "objective-checkpoint-request-1",
    createdAt: timestamp,
  };
  store.appendObjectiveCheckpoint(checkpoint);
  const approval: ObjectiveApprovalRecord = {
    version: 1,
    id: "objective-approval-1",
    runId: run.runId,
    objectiveId: run.objectiveId,
    planRevision: 0,
    kind: "completion",
    taskId: null,
    question: "May this objective complete?",
    scope: {},
    operationId: "objective-operation-1",
    requestHash: "approval-request-hash-1",
    policyHash: "approval-policy-hash-1",
    sideEffectClass: "read",
    canonicalTarget: "objective://objective-1",
    expiresAt: null,
    requestedBy: { type: "agent", id: "objective-root" },
    status: "requested",
    decision: null,
    decidedBy: null,
    requestedAt: timestamp,
    resolvedAt: null,
    requestKey: "objective-approval-request-1",
  };
  store.saveObjectiveApproval(approval);
  store.appendEvent({
    type: "objective.task.started",
    workflowId: run.workflowId,
    runId: run.runId,
    agentId: "objective-child",
    occurredAt: timestamp,
    payload: { taskId: "task-1" },
    provenance: { source: "daemon" },
  });
  store.close();
}

function seedObjectiveBudget(root: string): void {
  const store = createStore(join(root, ".symphony"));
  const run = objectiveWithPolicy();
  const policyHash = run.policy?.policyHash ?? "objective-policy-hash-1";
  store.saveAgent(agent("objective-root", run.runId));
  store.saveAgent(agent("objective-child", run.runId, "objective-root"));
  store.saveObjectiveRun(run);
  const ledger = ObjectiveBudgetLedgerRecordSchema.parse({
    version: 1,
    runId: run.runId,
    objectiveId: run.objectiveId,
    policyHash,
    limits: run.policy?.budget,
    reserved: {},
    consumed: {},
    status: "active",
    pauseReason: null,
    revision: 0,
    requestKey: "objective-budget-ledger-request-1",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  store.saveObjectiveBudgetLedger(ledger);
  const reservation = ObjectiveBudgetReservationRecordSchema.parse({
    version: 1,
    id: "objective-reservation-1",
    runId: run.runId,
    objectiveId: run.objectiveId,
    policyHash,
    reservationKey: "objective-reservation-key-1",
    attemptId: "objective-attempt-1",
    agentId: "objective-child",
    amount: { costUsd: 1, totalTokens: 20, modelCalls: 1 },
    state: "reserved",
    requestKey: "objective-reservation-request-1",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  store.saveObjectiveBudgetReservation(reservation);
  store.recordObjectiveBudgetDebit(ObjectiveBudgetDebitRecordSchema.parse({
    version: 1,
    id: "objective-debit-1",
    runId: run.runId,
    objectiveId: run.objectiveId,
    policyHash,
    usageEventKey: "objective-usage-event-1",
    reservationId: null,
    usage: { costUsd: 0.25, inputTokens: 4, outputTokens: 6, totalTokens: 10, modelCalls: 1 },
    basis: "provider-reported",
    requestKey: "objective-debit-request-1",
    createdAt: timestamp,
  }));
  store.close();
}

function seedObjectiveControl(root: string): void {
  const store = createStore(join(root, ".symphony"));
  const run = objective();
  store.saveAgent({ ...agent("objective-root", run.runId), permissions: "full-access" as const });
  store.saveAgent(agent("objective-readonly", run.runId, "objective-root"));
  store.saveAgent(agent("foreign-root", "foreign-run"));
  store.saveObjectiveRun(run);
  const source = {
    kind: "workflow-revision" as const,
    workflowId: run.workflowId,
    workflowRevision: run.workflowRevision,
    workflowHash: run.workflowHash,
  };
  const plan = {
    version: 1 as const,
    id: "objective-control-plan-1",
    source,
    root: {
      id: "root",
      sourceNodeId: "root",
      sourcePath: "root",
      dependsOn: [],
      type: "set" as const,
      value: { initial: true },
    },
    limits: { maxNodes: null, maxDepth: null, maxLoopIterations: null, maxConcurrentAgents: null },
  };
  const revision: ObjectiveControlPlanRevision = {
    version: 1,
    planId: plan.id,
    objectiveId: run.objectiveId,
    runId: run.runId,
    revision: 0,
    source,
    plan,
    hash: objectiveControlPlanHash(plan),
    createdBy: { type: "agent", id: "objective-root" },
    requestKey: "objective-control-admission-1",
    createdAt: timestamp,
  };
  const snapshot: ObjectiveControlPlanSnapshot = {
    version: 1,
    planId: plan.id,
    objectiveId: run.objectiveId,
    runId: run.runId,
    planRevision: 0,
    sequence: 1,
    eventCursor: 0,
    nodeStates: {},
    frontier: [],
    branches: {},
    loopIterations: {},
    exitReasons: {},
    attemptIds: {},
    executions: [],
    contextRefs: [],
    reason: "Initial control strategy.",
    createdAt: timestamp,
  };
  store.saveObjectiveControlPlanRevision(revision, snapshot);
  store.close();
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("durable objective projection API", () => {
  it("serves bounded run projections, records, and run-scoped events", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-objective-api-"));
    temporary.push(root);
    const port = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
    }));
    seedObjective(root);
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true });
    try {
      const base = `http://127.0.0.1:${port}`;
      const list = await fetch(`${base}/v1/objectives?limit=1&workflowId=objective-workflow`).then(responseJson) as { objectives: ObjectiveRunRecord[]; limit: number };
      expect(list.limit).toBe(1);
      expect(list.objectives).toHaveLength(1);
      expect(list.objectives[0]?.runId).toBe("objective-run-1");

      const detail = await fetch(`${base}/v1/objectives/objective-run-1?limit=10`).then(responseJson) as {
        run: ObjectiveRunRecord;
        planRevisions: unknown[];
        checkpoints: unknown[];
        approvals: unknown[];
        events: Array<{ runId: string }>;
        hasMore: boolean;
      };
      expect(detail.run.runId).toBe("objective-run-1");
      expect(detail.planRevisions).toHaveLength(1);
      expect(detail.checkpoints).toHaveLength(1);
      expect(detail.approvals).toHaveLength(1);
      expect(detail.budgetLedger).toBeNull();
      expect(detail.reservations).toBeNull();
      expect(detail.debits).toBeNull();
      expect(detail.events.length).toBeGreaterThanOrEqual(1);
      expect(detail.events[0]?.runId).toBe("objective-run-1");
      expect(detail.hasMore).toBe(false);

      await daemon.objectiveSupervisor.step("objective-run-1");
      const attentionPage = await fetch(`${base}/v1/objectives/objective-run-1/attentions`).then(responseJson) as {
        attentions: Array<{ id: string; operationId: string; status: string }>;
      };
      expect(attentionPage.attentions).toHaveLength(1);
      expect(attentionPage.attentions[0]).toMatchObject({ operationId: "objective-operation-1", status: "open" });
      const attentionId = attentionPage.attentions[0]?.id;
      if (!attentionId) throw new Error("attention id was not returned");
      const resolvedResponse = await fetch(`${base}/v1/objectives/objective-run-1/attentions/${attentionId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "objective-attention-resolve-1" },
        body: JSON.stringify({ status: "resolved", decision: { approved: true }, evidenceRefs: [] }),
      });
      expect(resolvedResponse.status).toBe(409);
      expect(await resolvedResponse.json()).toMatchObject({ error: expect.stringContaining("not ready for completion approval") });
    } finally {
      await daemon.close();
    }
  });

  it("serves the policy-backed ledger and run-scoped accounting records", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-objective-api-budget-"));
    temporary.push(root);
    const port = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
    }));
    seedObjectiveBudget(root);
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true });
    try {
      const detail = await fetch(`http://127.0.0.1:${port}/v1/objectives/objective-run-1`).then(responseJson) as {
        run: ObjectiveRunRecord;
        budgetLedger: { runId: string; consumed: { costUsd: number }; reserved: { costUsd: number } } | null;
        reservations: Array<{ runId: string; id: string }> | null;
        debits: Array<{ runId: string; id: string }> | null;
      };
      expect(detail.run.policy?.policyHash).toBe(objectiveWithPolicy().policy?.policyHash);
      expect(detail.budgetLedger).toMatchObject({
        runId: "objective-run-1",
        consumed: { costUsd: 0.25 },
        reserved: { costUsd: 1 },
      });
      expect(detail.reservations).toHaveLength(1);
      expect(detail.reservations?.[0]).toMatchObject({ runId: "objective-run-1", id: "objective-reservation-1" });
      expect(detail.debits).toHaveLength(1);
      expect(detail.debits?.[0]).toMatchObject({ runId: "objective-run-1", id: "objective-debit-1" });
    } finally {
      await daemon.close();
    }
  });

  it("limits authenticated agents to objectives in their root lineage", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-objective-api-auth-"));
    temporary.push(root);
    const port = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
    }));
    seedObjective(root);
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true });
    try {
      const base = `http://127.0.0.1:${port}`;
      const childHeaders = {
        "x-symphony-agent-id": "objective-child",
        "x-symphony-agent-token": daemon.agents.tokenFor("objective-child"),
      };
      const childDetail = await fetch(`${base}/v1/objectives/objective-run-1`, { headers: childHeaders });
      expect(childDetail.status).toBe(200);

      const foreignHeaders = {
        "x-symphony-agent-id": "foreign-root",
        "x-symphony-agent-token": daemon.agents.tokenFor("foreign-root"),
      };
      const foreignList = await fetch(`${base}/v1/objectives`, { headers: foreignHeaders }).then(responseJson) as { objectives: unknown[] };
      expect(foreignList.objectives).toEqual([]);
      const foreignDetail = await fetch(`${base}/v1/objectives/objective-run-1`, { headers: foreignHeaders });
      expect(foreignDetail.status).toBe(403);
    } finally {
      await daemon.close();
    }
  });

  it("authenticates and CAS-protects the durable objective strategy API", async () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-objective-control-api-"));
    temporary.push(root);
    const port = await availablePort();
    writeFileSync(join(root, "symphony.config.json"), JSON.stringify({
      dataDirectory: ".symphony",
      server: { host: "127.0.0.1", port, openBrowser: false, webDirectory: "apps/web/out" },
      harnesses: {
        codex: { enabled: false }, claude: { enabled: false }, cursor: { enabled: false },
        opencode: { enabled: false }, pi: { enabled: false }, acp: [],
      },
      router: { provider: "neutral-lexical", baseUrl: "http://127.0.0.1:1" },
      observer: { provider: "deterministic" },
      plugins: { watch: false },
    }));
    seedObjectiveControl(root);
    const daemon = await startDaemon({ rootDirectory: root, noPlugins: true });
    try {
      const base = `http://127.0.0.1:${port}`;
      const fullHeaders = {
        "content-type": "application/json",
        "x-symphony-agent-id": "objective-root",
        "x-symphony-agent-token": daemon.agents.tokenFor("objective-root"),
      };
      const readonlyHeaders = {
        ...fullHeaders,
        "x-symphony-agent-id": "objective-readonly",
        "x-symphony-agent-token": daemon.agents.tokenFor("objective-readonly"),
      };
      const foreignHeaders = {
        ...fullHeaders,
        "x-symphony-agent-id": "foreign-root",
        "x-symphony-agent-token": daemon.agents.tokenFor("foreign-root"),
      };
      const strategyMutation = {
        type: "replace-node",
        expectedRevision: 0,
        nodeId: "root",
        node: {
          id: "root",
          sourceNodeId: "root",
          sourcePath: "root",
          dependsOn: [],
          type: "set",
          value: { initial: false },
        },
        reason: "Update the durable strategy.",
        evidence: { eventCursor: 0, eventIds: [] },
      };
      const current = await fetch(`${base}/v1/objectives/${runIdForTest()}/strategy`, { headers: fullHeaders });
      expect(current.status).toBe(200);
      const currentBody = await current.json() as { head: { activeRevision: number } };
      expect(currentBody.head.activeRevision).toBe(0);

      const missingKey = await fetch(`${base}/v1/objectives/${runIdForTest()}/strategy`, {
        method: "POST",
        headers: fullHeaders,
        body: JSON.stringify(strategyMutation),
      });
      expect(missingKey.status).toBe(400);

      const stream = await fetch(`${base}/v1/objectives/${runIdForTest()}/strategy/events?projection=ui&type=not-control`);
      expect(stream.status).toBe(200);
      const reader = stream.body?.getReader();
      expect(reader).toBeDefined();
      const decoder = new TextDecoder();
      const connected = await reader!.read();
      expect(decoder.decode(connected.value)).toContain(": connected");

      const committed = await fetch(`${base}/v1/objectives/${runIdForTest()}/strategy`, {
        method: "POST",
        headers: { ...fullHeaders, "idempotency-key": "objective-control-request-1" },
        body: JSON.stringify(strategyMutation),
      });
      expect(committed.status).toBe(200);
      const committedBody = await committed.json() as { status: string; revision: { revision: number }; snapshot: { planRevision: number } };
      expect(committedBody).toMatchObject({ status: "committed", revision: { revision: 1 }, snapshot: { planRevision: 1 } });
      const semanticEvent = await reader!.read();
      expect(decoder.decode(semanticEvent.value)).toContain("event: objective.control-plan.changed");
      await reader!.cancel();

      const replay = await fetch(`${base}/v1/objectives/${runIdForTest()}/strategy`, {
        method: "POST",
        headers: { ...fullHeaders, "idempotency-key": "objective-control-request-1" },
        body: JSON.stringify(strategyMutation),
      });
      expect(replay.status).toBe(200);
      expect((await replay.json() as { status: string }).status).toBe("replayed");

      const stale = await fetch(`${base}/v1/objectives/${runIdForTest()}/strategy`, {
        method: "POST",
        headers: { ...fullHeaders, "idempotency-key": "objective-control-request-2" },
        body: JSON.stringify(strategyMutation),
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ conflict: true, currentRevision: 1, expectedRevision: 0 });

      const derivedState = await fetch(`${base}/v1/objectives/${runIdForTest()}/strategy`, { headers: fullHeaders }).then((response) => response.json()) as {
        mutations: Array<unknown>;
        revision: { plan: { root: { value?: unknown } } };
      };
      expect(derivedState.mutations).toHaveLength(1);
      expect(derivedState.revision.plan.root).toMatchObject({ value: { initial: false } });

      const callerDerived = await fetch(`${base}/v1/objectives/${runIdForTest()}/strategy`, {
        method: "POST",
        headers: { ...fullHeaders, "idempotency-key": "objective-control-request-3" },
        body: JSON.stringify({ ...strategyMutation, resultingPlan: strategyMutation.node }),
      });
      expect(callerDerived.status).toBe(400);

      const readonly = await fetch(`${base}/v1/objectives/${runIdForTest()}/strategy`, {
        method: "POST",
        headers: { ...readonlyHeaders, "idempotency-key": "objective-control-readonly" },
        body: JSON.stringify({ ...strategyMutation, expectedRevision: 1 }),
      });
      expect(readonly.status).toBe(403);

      const foreign = await fetch(`${base}/v1/objectives/${runIdForTest()}/strategy`, { headers: foreignHeaders });
      expect(foreign.status).toBe(403);
    } finally {
      await daemon.close();
    }
  });
});

function runIdForTest(): string {
  return "objective-run-1";
}
