import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ObjectiveApprovalRecord,
  ObjectiveCheckpointRecord,
  ObjectiveRunRecord,
  ObjectiveTaskRecord,
} from "../packages/protocol/src/index.js";
import { SymphonyStore, type ObjectivePlanRevisionRecord } from "../packages/storage/src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const now = "2026-09-01T00:00:00.000Z";

const task: ObjectiveTaskRecord = {
  task: {
    id: "implement",
    objective: "Implement the bounded change and verify it.",
    dependsOn: [],
    outputSchema: { type: "object" },
    model: "auto",
    harness: "auto",
    permissions: "read-only",
    inputs: [],
    requiresApproval: false,
  },
  state: "queued",
  attemptId: null,
  agentId: null,
  output: null,
  error: null,
  startedAt: null,
  finishedAt: null,
};

const run: ObjectiveRunRecord = {
  version: 1,
  runId: "objective-run-1",
  objectiveId: "objective-1",
  workflowId: "workflow-1",
  workflowRevision: 3,
  workflowHash: "workflow-hash-1",
  conductorAgentId: "conductor-1",
  spec: {
    id: "objective-1",
    statement: "Ship the change and prove it works.",
    criteria: [],
    approvalPolicy: { mode: "on-replan" },
    maxReplans: 3,
  },
  state: "planning",
  activePlanRevision: 0,
  latestCheckpointId: null,
  pendingApprovalId: null,
  replanCount: 0,
  tasks: [task],
  context: {},
  output: null,
  error: null,
  requestKey: "objective-request-1",
  createdAt: now,
  updatedAt: now,
  startedAt: null,
  finishedAt: null,
};

function makeStore(prefix = "symphony-objective-store-"): SymphonyStore {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(directory);
  return new SymphonyStore(join(directory, "state.sqlite"));
}

describe("Objective Runtime storage", () => {
  it("migrates objective tables and stores immutable run identity idempotently", () => {
    const store = makeStore();
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 11").get()).toEqual({ version: 11 });
    expect(store.saveObjectiveRun(run)).toBe(true);
    expect(store.saveObjectiveRun(run)).toBe(false);
    expect(store.getObjectiveRun(run.runId)).toEqual(run);
    expect(store.getObjectiveRunByRequestKey(run.requestKey)).toEqual(run);
    expect(store.listObjectiveRuns({ state: ["planning"] })).toEqual([run]);
    expect(() => store.saveObjectiveRun({ ...run, workflowHash: "forged-hash" })).toThrow(/immutable/);
    store.close();

    const reopened = new SymphonyStore(join(store.path.replace(/state\.sqlite$/, ""), "state.sqlite"));
    expect(reopened.getObjectiveRun(run.runId)).toEqual(run);
    reopened.close();
  });

  it("keeps plan revisions append-only and advances the active pointer with CAS", () => {
    const store = makeStore();
    expect(store.saveObjectiveRun(run)).toBe(true);
    const initial: ObjectivePlanRevisionRecord = {
      version: 1,
      id: "plan-revision-0",
      runId: run.runId,
      objectiveId: run.objectiveId,
      workflowId: run.workflowId,
      workflowRevision: run.workflowRevision,
      workflowHash: run.workflowHash,
      planRevision: 0,
      tasks: [task],
      createdBy: { type: "agent", id: "conductor-1" },
      requestKey: "plan-request-0",
      createdAt: now,
    };
    expect(store.saveObjectivePlanRevision(initial)).toBe(true);
    expect(store.saveObjectivePlanRevision(initial)).toBe(false);
    expect(() => store.saveObjectivePlanRevision({ ...initial, requestKey: "different-request" })).toThrow(/idempotency conflict/);
    expect(() => store.saveObjectivePlanRevision({ ...initial, id: "different-plan-id", tasks: [] })).toThrow(/idempotency conflict/);

    const nextTask = { ...task, task: { ...task.task, id: "verify" } };
    const next: ObjectivePlanRevisionRecord = {
      ...initial,
      id: "plan-revision-1",
      planRevision: 1,
      tasks: [task, nextTask],
      requestKey: "plan-request-1",
      createdAt: "2026-09-01T00:00:01.000Z",
    };
    expect(store.saveObjectivePlanRevision(next, { expectedActivePlanRevision: 0 })).toBe(true);
    expect(store.getObjectiveRun(run.runId)).toMatchObject({ activePlanRevision: 1, tasks: [task, nextTask] });
    expect(() => store.saveObjectivePlanRevision({
      ...next,
      id: "dropped-task-revision",
      planRevision: 2,
      requestKey: "dropped-task-plan-2",
      tasks: [nextTask],
    }, { expectedActivePlanRevision: 1 })).toThrow(/cannot remove or redefine task/);
    const stale = { ...next, id: "stale-revision", planRevision: 2, requestKey: "stale-plan-2" };
    expect(store.saveObjectivePlanRevision(stale, { expectedActivePlanRevision: 0 })).toBe(false);
    expect(() => store.saveObjectivePlanRevision({ ...next, id: "gap-revision", planRevision: 3, requestKey: "gap-plan-1" }, { expectedActivePlanRevision: 1 })).toThrow(/exactly one/);
    expect(() => store.updateObjectiveRun({ ...run, activePlanRevision: 2 }, { expectedActivePlanRevision: 1 })).toThrow(/cannot change the active plan revision/);
    expect(store.listObjectivePlanRevisions(run.runId)).toEqual([initial, next]);
    store.close();
  });

  it("appends ordered evidence checkpoints and updates the run pointer", () => {
    const store = makeStore();
    expect(store.saveObjectiveRun(run)).toBe(true);
    const checkpoint: ObjectiveCheckpointRecord = {
      version: 1,
      id: "checkpoint-1",
      runId: run.runId,
      objectiveId: run.objectiveId,
      sequence: 1,
      planRevision: 0,
      eventCursor: 17,
      context: { verified: false },
      taskStates: { implement: "running" },
      criteria: [],
      contextHash: "context-hash-1",
      reason: "The first task has started.",
      createdBy: { type: "agent", id: "conductor-1" },
      requestKey: "checkpoint-request-1",
      createdAt: now,
    };
    expect(store.appendObjectiveCheckpoint(checkpoint)).toBe(true);
    expect(store.appendObjectiveCheckpoint(checkpoint)).toBe(false);
    expect(() => store.appendObjectiveCheckpoint({ ...checkpoint, requestKey: "different-request" })).toThrow(/idempotency conflict/);
    expect(() => store.appendObjectiveCheckpoint({ ...checkpoint, id: "different-checkpoint-id", context: { verified: true } })).toThrow(/idempotency conflict/);
    expect(store.getObjectiveRun(run.runId)).toMatchObject({ latestCheckpointId: checkpoint.id });
    expect(() => store.appendObjectiveCheckpoint({
      ...checkpoint,
      id: "checkpoint-unknown-task",
      sequence: 2,
      requestKey: "checkpoint-unknown-task",
      taskStates: { implement: "running", unknown: "completed" },
    })).toThrow(/task states must cover/);
    expect(() => store.appendObjectiveCheckpoint({ ...checkpoint, id: "checkpoint-3", sequence: 3, requestKey: "checkpoint-request-3" })).toThrow(/sequence must be 2/);
    const second = { ...checkpoint, id: "checkpoint-2", sequence: 2, requestKey: "checkpoint-request-2", eventCursor: 21, createdAt: "2026-09-01T00:00:02.000Z" };
    expect(store.appendObjectiveCheckpoint(second)).toBe(true);
    expect(store.listObjectiveCheckpoints(run.runId)).toEqual([checkpoint, second]);
    expect(store.getObjectiveCheckpoint(run.runId, second.id)).toEqual(second);
    expect(() => store.appendObjectiveCheckpoint({
      ...second,
      id: "checkpoint-stale-cursor",
      sequence: 3,
      eventCursor: 20,
      requestKey: "checkpoint-stale-cursor",
    })).toThrow(/event cursor cannot move backwards/);
    expect(() => store.appendObjectiveCheckpoint({ ...second, id: "foreign-checkpoint", objectiveId: "other-objective", requestKey: "foreign-request" })).toThrow(/identity/);
    store.close();
  });

  it("stores approval requests once and resolves them with a status CAS", () => {
    const store = makeStore();
    expect(store.saveObjectiveRun(run)).toBe(true);
    const approval: ObjectiveApprovalRecord = {
      version: 1,
      id: "approval-1",
      runId: run.runId,
      objectiveId: run.objectiveId,
      planRevision: 0,
      kind: "completion",
      taskId: null,
      question: "May this objective be marked complete?",
      scope: { result: "verified" },
      operationId: "mark-objective-complete",
      requestHash: "approval-request-hash-1",
      policyHash: "approval-policy-hash-1",
      sideEffectClass: "read",
      canonicalTarget: "objective/objective-run-1",
      expiresAt: null,
      requestedBy: { type: "agent", id: "conductor-1" },
      status: "requested",
      decision: null,
      decidedBy: null,
      requestedAt: now,
      expiresAt: null,
      resolvedAt: null,
      requestKey: "approval-request-1",
    };
    expect(store.saveObjectiveApproval(approval)).toBe(true);
    expect(store.saveObjectiveApproval(approval)).toBe(false);
    expect(() => store.saveObjectiveApproval({ ...approval, requestKey: "different-request" })).toThrow(/idempotency conflict/);
    expect(() => store.saveObjectiveApproval({ ...approval, id: "different-approval-id", canonicalTarget: "objective/other" })).toThrow(/idempotency conflict/);
    expect(store.updateObjectiveApproval({ ...approval, status: "approved", decision: { approved: true }, decidedBy: { type: "user", id: "user-1" }, resolvedAt: "2026-09-01T00:00:03.000Z" }, { expectedStatus: "requested" })).toBe(true);
    expect(store.updateObjectiveApproval({ ...approval, status: "rejected", decision: { approved: false }, decidedBy: { type: "user", id: "user-2" }, resolvedAt: "2026-09-01T00:00:04.000Z" }, { expectedStatus: "requested" })).toBe(false);
    expect(store.getObjectiveApproval(run.runId, approval.id)).toMatchObject({ status: "approved", decidedBy: { id: "user-1" } });
    expect(store.listObjectiveApprovals({ runId: run.runId, status: ["approved"] })).toHaveLength(1);
    expect(() => store.updateObjectiveApproval({ ...approval, question: "Forged question", status: "approved" }, { expectedStatus: "approved" })).toThrow(/immutable/);
    expect(() => store.updateObjectiveApproval({ ...approval, policyHash: "forged-policy-hash", status: "approved" }, { expectedStatus: "approved" })).toThrow(/immutable/);
    expect(() => store.saveObjectiveApproval({
      ...approval,
      id: "approval-future-plan",
      planRevision: 1,
      requestKey: "approval-future-plan",
    })).toThrow(/future plan revision/);
    expect(() => store.saveObjectiveApproval({
      ...approval,
      id: "approval-unknown-task",
      kind: "task",
      taskId: "missing-task",
      requestKey: "approval-unknown-task",
    })).toThrow(/unknown task/);

    // Simulate an approval record written before the v11 identity expansion.
    // Reopening/reading that durable history must not make the objective
    // unreadable; the storage layer supplies deterministic legacy identity
    // until the record is next resolved and rewritten.
    const legacy = { ...approval } as Record<string, unknown>;
    delete legacy.operationId;
    delete legacy.requestHash;
    delete legacy.policyHash;
    delete legacy.sideEffectClass;
    delete legacy.canonicalTarget;
    delete legacy.expiresAt;
    store.database.prepare("UPDATE objective_approvals SET record_json = ? WHERE id = ?").run(JSON.stringify(legacy), approval.id);
    expect(store.getObjectiveApproval(run.runId, approval.id)).toMatchObject({
      operationId: `legacy-approval-operation-${approval.id}`,
      sideEffectClass: "local",
      expiresAt: null,
    });
    const reopenedPath = store.path;
    store.close();
    const reopened = new SymphonyStore(reopenedPath);
    expect(reopened.getObjectiveApproval(run.runId, approval.id)).toMatchObject({
      operationId: `legacy-approval-operation-${approval.id}`,
      sideEffectClass: "local",
      expiresAt: null,
    });
    reopened.close();
  });

  it("durably filters due approvals before applying the scan limit", () => {
    const store = makeStore("symphony-objective-approval-expiry-");
    expect(store.saveObjectiveRun(run)).toBe(true);
    const approval = (id: string, expiresAt: string): ObjectiveApprovalRecord => ({
      version: 1,
      id,
      runId: run.runId,
      objectiveId: run.objectiveId,
      planRevision: 0,
      kind: "plan",
      taskId: null,
      question: "Approve this plan.",
      scope: {},
      operationId: `operation-${id}`,
      requestHash: `request-hash-${id}`,
      policyHash: `policy-hash-${id}`,
      sideEffectClass: "local",
      canonicalTarget: `objective/${id}`,
      capability: null,
      expiresAt,
      requestedBy: { type: "agent", id: "conductor-1" },
      status: "requested",
      decision: null,
      decidedBy: null,
      requestedAt: now,
      resolvedAt: null,
      requestKey: `request-key-${id}`,
    });
    for (let index = 0; index < 4; index += 1) {
      expect(store.saveObjectiveApproval(approval(`future-${index}`, "2026-09-01T00:10:00.000Z"))).toBe(true);
    }
    expect(store.saveObjectiveApproval(approval("expired-later", "2026-08-31T23:59:59.000Z"))).toBe(true);
    expect(store.saveObjectiveApproval({ ...approval("never", "2026-09-01T00:10:00.000Z"), expiresAt: null })).toBe(true);

    const due = store.listObjectiveApprovals({
      status: ["requested"],
      expiresAtLte: now,
      limit: 2,
    });
    expect(due.map((record) => record.id)).toEqual(["expired-later"]);
    store.close();
  });
});
